import Fastify, { type FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import twilio from 'twilio';
import WebSocket from 'ws';
import { z } from 'zod';
import type { Restaurant } from '@hostline/contracts';
import type { EnabledVoiceConfig, VoiceConfig } from './config.js';
import { fetchVoiceContext, voiceInstructions } from './context.js';
import { CallRegistry } from './registry.js';
import { AudioRelay, decodeAudio, type AudioPeer } from './relay.js';

const callSidSchema = z.string().regex(/^CA[0-9a-fA-F]{32}$/);
const streamSidSchema = z.string().regex(/^MZ[0-9a-fA-F]{32}$/);
const sequence = z.string().regex(/^\d{1,12}$/);
const mediaEvent = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('connected'),
    protocol: z.literal('Call'),
    version: z.literal('1.0.0'),
  }),
  z.object({
    event: z.literal('start'),
    sequenceNumber: sequence,
    streamSid: streamSidSchema,
    start: z.object({
      streamSid: streamSidSchema,
      accountSid: z.string(),
      callSid: callSidSchema,
      tracks: z.array(z.literal('inbound')).length(1),
      mediaFormat: z.object({
        encoding: z.literal('audio/x-mulaw'),
        sampleRate: z.literal(8000),
        channels: z.literal(1),
      }),
      customParameters: z.object({ grant: z.string().max(128) }),
    }),
  }),
  z.object({
    event: z.literal('media'),
    sequenceNumber: sequence,
    streamSid: streamSidSchema,
    media: z.object({
      track: z.literal('inbound'),
      payload: z.string().max(4268),
      timestamp: sequence,
      chunk: sequence,
    }),
  }),
  z.object({
    event: z.literal('mark'),
    sequenceNumber: sequence,
    streamSid: streamSidSchema,
    mark: z.object({ name: z.string().max(80) }),
  }),
  z.object({
    event: z.literal('stop'),
    sequenceNumber: sequence,
    streamSid: streamSidSchema,
    stop: z.object({ accountSid: z.string(), callSid: callSidSchema }),
  }),
  z.object({
    event: z.literal('dtmf'),
    sequenceNumber: sequence,
    streamSid: streamSidSchema,
    dtmf: z.object({ track: z.literal('inbound_track'), digit: z.string().max(1) }),
  }),
]);

export interface ProviderSocket extends AudioPeer {
  on(event: 'open' | 'close' | 'error', listener: () => void): this;
  on(event: 'message', listener: (data: { toString(): string }, binary: boolean) => void): this;
  terminate(): void;
}

export interface VoiceDependencies {
  context?: (config: EnabledVoiceConfig) => Promise<Restaurant>;
  connectProvider?: (config: EnabledVoiceConfig) => ProviderSocket;
  now?: () => number;
}

function signature(
  config: EnabledVoiceConfig,
  request: FastifyRequest,
  pathname: string,
  params: Record<string, string>,
  stream = false,
): boolean {
  if (request.raw.url !== pathname) return false;
  const signed = request.headers['x-twilio-signature'];
  if (typeof signed !== 'string' || signed.length > 256) return false;
  const httpsUrl = `${config.publicUrl}${pathname}`;
  // Only these two server-configured representations are accepted. Neither Host
  // nor X-Forwarded-* can choose a verification origin, path, or query string.
  const urls = stream ? [httpsUrl.replace(/^https:/, 'wss:'), httpsUrl] : [httpsUrl];
  return urls.some((url) => twilio.validateRequest(config.authToken, signed, url, params));
}

function signedCall(
  config: EnabledVoiceConfig,
  request: FastifyRequest,
  path: string,
): { callSid: string; params: Record<string, string> } | undefined {
  const parsed = z.record(z.string().max(100), z.string().max(2048)).safeParse(request.body);
  if (
    !parsed.success ||
    Object.keys(parsed.data).length > 100 ||
    !signature(config, request, path, parsed.data)
  )
    return undefined;
  const params = parsed.data;
  if (
    params.AccountSid !== config.accountSid ||
    params.To !== config.phoneNumber ||
    !callSidSchema.safeParse(params.CallSid).success
  )
    return undefined;
  if (params.Direction !== undefined && params.Direction !== 'inbound') return undefined;
  return { callSid: params.CallSid!, params };
}

function startResponse(config: EnabledVoiceConfig, token: string): string {
  const response = new twilio.twiml.VoiceResponse();
  response.say(
    'You have reached the restaurant AI test receptionist. This test answers questions only. It cannot make reservations, save messages, or transfer calls.',
  );
  response
    .connect()
    .stream({ url: `${config.publicUrl.replace(/^https:/, 'wss:')}/twilio/media` })
    .parameter({ name: 'grant', value: token });
  response.say(
    'The AI test session has ended. Please contact restaurant staff through your usual contact channel. Goodbye.',
  );
  response.hangup();
  return response.toString();
}

function openProvider(config: EnabledVoiceConfig): WebSocket {
  // Fixed provider host, no model-selected URLs, redirects, or client credentials.
  return new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`,
    {
      headers: { Authorization: `Bearer ${config.openaiKey}` },
      handshakeTimeout: 5000,
      maxPayload: 192 * 1024,
      followRedirects: false,
      perMessageDeflate: false,
    },
  );
}

export async function createVoiceGateway(
  config: VoiceConfig,
  dependencies: VoiceDependencies = {},
) {
  // HTTP request logs and vendor error bodies are intentionally disabled: they can
  // contain caller information, bearer grants, or credentials.
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    trustProxy: false,
    requestTimeout: 10_000,
  });
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 8192, perMessageDeflate: false } });
  app.setErrorHandler((_error, _request, reply) => {
    void reply.code(400).send({ error: 'Invalid voice request' });
  });
  app.get('/health', async () => ({
    status: 'ok',
    liveVoiceEnabled: config.enabled,
    mode: config.enabled ? 'sandbox' : 'disabled',
    productionReady: false,
    reservationWritesEnabled: false,
    transfersEnabled: false,
  }));
  if (!config.enabled) {
    app.post('/twilio/incoming', async (_request, reply) =>
      reply.code(503).send({ error: 'Voice is disabled' }),
    );
    return app;
  }

  const now = dependencies.now ?? Date.now;
  const registry = new CallRegistry(config.maxConcurrentCalls, now);
  const sockets = new Set<WebSocket>();
  const loadContext = dependencies.context ?? fetchVoiceContext;
  const connect = dependencies.connectProvider ?? openProvider;

  app.post('/twilio/incoming', async (request, reply) => {
    const call = signedCall(config, request, '/twilio/incoming');
    if (!call) return reply.code(403).send({ error: 'Invalid provider callback' });
    const response = registry.incoming(call.callSid, (token) => startResponse(config, token));
    if (!response) return reply.code(503).send({ error: 'Voice capacity reached' });
    return reply.type('text/xml').send(response);
  });

  app.post('/twilio/status', async (request, reply) => {
    const call = signedCall(config, request, '/twilio/status');
    if (!call) return reply.code(403).send({ error: 'Invalid provider callback' });
    if (
      ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(
        call.params.CallStatus ?? '',
      )
    )
      registry.end(call.callSid);
    // Late nonterminal callbacks never reopen a spent grant.
    return reply.code(204).send();
  });

  app.get(
    '/twilio/media',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!signature(config, request, '/twilio/media', {}, true))
          return reply.code(403).send({ error: 'Invalid stream signature' });
        if (sockets.size >= config.maxConcurrentCalls * 2)
          return reply.code(503).send({ error: 'Voice capacity reached' });
      },
    },
    (socket) => {
      // Several asynchronous preValidation hooks can all observe the same count.
      // Admission must also happen synchronously immediately before registration.
      if (sockets.size >= config.maxConcurrentCalls * 2) {
        socket.terminate();
        return;
      }
      sockets.add(socket);
      let closed = false;
      let connected = false;
      let callSid: string | undefined;
      let streamSid: string | undefined;
      let provider: ProviderSocket | undefined;
      let relay: AudioRelay | undefined;
      let lastSequence = -1;
      let lastTimestamp = -1;
      let windowStart = now();
      let frameCount = 0;
      let audioBytes = 0;
      let pending: string[] = [];
      let pendingBytes = 0;
      let providerTimer: ReturnType<typeof setTimeout> | undefined;
      let durationTimer: ReturnType<typeof setTimeout> | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(startTimer);
        if (providerTimer) clearTimeout(providerTimer);
        if (durationTimer) clearTimeout(durationTimer);
        pending = [];
        relay?.close();
        // terminate a pending connection instead of leaving handshake work alive.
        if (provider?.readyState === WebSocket.CONNECTING) provider.terminate();
        else provider?.close(1000, 'Session ended');
        socket.close(1000, 'Session ended');
        if (callSid) registry.end(callSid);
      };
      const startTimer = setTimeout(close, 5000);
      startTimer.unref();

      const startProvider = async () => {
        try {
          const restaurant = await loadContext(config);
          if (closed || !streamSid) return;
          provider = connect(config);
          relay = new AudioRelay(socket, provider, streamSid, close);
          for (const payload of pending) relay.input(payload);
          pending = [];
          pendingBytes = 0;
          provider.on('open', () => relay?.configure(voiceInstructions(restaurant)));
          provider.on('message', (data, binary) => {
            if (binary) return close();
            const raw = data.toString();
            relay?.providerEvent(raw);
            if (relay?.isReady && providerTimer) clearTimeout(providerTimer);
          });
          provider.on('close', close);
          provider.on('error', close);
        } catch {
          close();
        }
      };

      // Register synchronously before the first context fetch to avoid losing media.
      socket.on('message', (data, binary) => {
        if (closed) return;
        try {
          if (binary || Buffer.byteLength(data.toString()) > 8192) return close();
          const tick = now();
          if (tick - windowStart >= 1000) {
            windowStart = tick;
            frameCount = 0;
            audioBytes = 0;
          }
          if (++frameCount > 250) return close();
          const event = mediaEvent.parse(JSON.parse(data.toString()));
          if (event.event === 'connected') {
            if (connected || streamSid) return close();
            connected = true;
            return;
          }
          const currentSequence = Number(event.sequenceNumber);
          if (currentSequence <= lastSequence) return close();
          lastSequence = currentSequence;
          if (event.event === 'start') {
            if (
              !connected ||
              streamSid ||
              event.start.accountSid !== config.accountSid ||
              event.start.streamSid !== event.streamSid
            )
              return close();
            if (!registry.redeem(event.start.callSid, event.start.customParameters.grant, close))
              return close();
            callSid = event.start.callSid;
            streamSid = event.streamSid;
            clearTimeout(startTimer);
            durationTimer = setTimeout(close, config.maxCallSeconds * 1000);
            durationTimer.unref();
            providerTimer = setTimeout(close, 10_000);
            providerTimer.unref();
            void startProvider();
            return;
          }
          if (!streamSid || event.streamSid !== streamSid) return close();
          if (event.event === 'media') {
            const audio = decodeAudio(event.media.payload, 3200);
            const timestamp = Number(event.media.timestamp);
            if (
              !audio ||
              timestamp < lastTimestamp ||
              timestamp > config.maxCallSeconds * 1000 + 1000
            )
              return close();
            lastTimestamp = timestamp;
            audioBytes += audio.length;
            if (audioBytes > 24_000) return close();
            if (relay) relay.input(event.media.payload);
            else {
              pendingBytes += audio.length;
              if (pendingBytes > 16_000 || pending.length >= 150) return close();
              pending.push(event.media.payload);
            }
          } else if (event.event === 'mark') relay?.played(event.mark.name);
          else if (event.event === 'stop') {
            if (event.stop.callSid !== callSid || event.stop.accountSid !== config.accountSid)
              return close();
            close();
          }
          // DTMF grants no authority and never executes a command.
        } catch {
          close();
        }
      });
      socket.on('close', () => {
        sockets.delete(socket);
        close();
      });
      socket.on('error', close);
    },
  );

  app.addHook('preClose', async () => {
    for (const socket of sockets) socket.close(1001, 'Gateway shutting down');
  });
  return app;
}
