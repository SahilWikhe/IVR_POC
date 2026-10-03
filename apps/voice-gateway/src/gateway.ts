import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import {
  logEvent,
  type OperationalEvent,
  type VoiceTranscriptEvent,
  type VoiceTranscriptSink,
} from '@hostline/observability';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import twilio from 'twilio';
import WebSocket from 'ws';
import { z } from 'zod';
import type { EnabledVoiceConfig, VoiceConfig } from './config.js';
import {
  voiceInstructions,
  liveVoiceInstructions,
  liveBackendInstructions,
  liveOpening,
} from './context.js';
import {
  LiveAudioRelay,
  type LiveDelegationInput,
  type LiveDelegationResult,
  type LiveWorkflowStage,
} from './live-relay.js';
import { createLiveBackend } from './live-backend.js';
import { MediaRateLimiter, type MediaRateLimitCode } from './media-rate.js';
import { createVoiceApiClient, VoiceControlError, type VoiceApiClient } from './client.js';
import { createCallController, type CallController, type CallControlResult } from './control.js';
import {
  AudioRelay,
  decodeAudio,
  type AudioPeer,
  type RelayDiagnosticCode,
  type VoiceToolRequest,
} from './relay.js';

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
  api?: VoiceApiClient;
  controller?: CallController;
  connectProvider?: (config: EnabledVoiceConfig) => ProviderSocket;
  now?: () => number;
  onDiagnostic?: (event: OperationalEvent) => void;
  delegate?: (input: LiveDelegationInput) => Promise<LiveDelegationResult>;
  voiceTranscripts?: VoiceTranscriptSink;
}

type StreamCloseCode =
  | MediaRateLimitCode
  | 'stream_closed'
  | 'start_timeout'
  | 'provider_setup_timeout'
  | 'duration_limit'
  | 'policy_denied'
  | 'policy_unavailable'
  | 'provider_protocol_invalid'
  | 'response_buffer_limit'
  | 'provider_closed'
  | 'provider_socket_error'
  | 'provider_setup_failed'
  | 'media_protocol_invalid'
  | 'input_buffer_limit'
  | 'caller_stopped'
  | 'media_socket_error';

type GatewayWorkflowStage =
  | 'stream_bound'
  | 'proposal_started'
  | 'proposal_failed'
  | 'proposal_prepared'
  | 'transfer_started'
  | 'transfer_failed'
  | 'transfer_prepared'
  | 'dispatch_started'
  | 'dispatch_failed'
  | 'dispatch_unavailable'
  | 'dispatch_already_owned'
  | 'dispatch_admitted'
  | 'dispatch_expired'
  | 'dispatch_accepted'
  | 'dispatch_rejected'
  | 'dispatch_unknown'
  | 'dispatch_receipt_failed';

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
  inbound = true,
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
    (inbound && params.To !== config.phoneNumber) ||
    !callSidSchema.safeParse(params.CallSid).success
  )
    return undefined;
  if (inbound && params.Direction !== undefined && params.Direction !== 'inbound') return undefined;
  return { callSid: params.CallSid!, params };
}

function openProvider(config: EnabledVoiceConfig): WebSocket {
  // Fixed provider host, no model-selected URLs, redirects, or client credentials.
  return new WebSocket(
    config.model === 'gpt-live-1'
      ? 'wss://api.openai.com/v1/live/sessions'
      : `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`,
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
    voiceModel: config.enabled ? config.model : null,
    taskModel: config.enabled && config.model === 'gpt-live-1' ? config.backendModel : null,
    reservationRequestsEnabled: config.enabled && config.actionsEnabled,
    reservationWritesEnabled: false,
    transfersEnabled: config.enabled && config.transfersEnabled,
  }));
  if (!config.enabled) {
    app.post('/twilio/incoming', async (_request, reply) =>
      reply.code(503).send({ error: 'Voice is disabled' }),
    );
    return app;
  }

  const now = dependencies.now ?? Date.now;
  const api = dependencies.api ?? createVoiceApiClient(config);
  const controller =
    dependencies.controller ??
    createCallController({
      accountSid: config.accountSid,
      authToken: config.authToken,
      publicUrl: config.publicUrl,
      maxCallSeconds: config.maxCallSeconds,
    });
  const activeCalls = new Map<string, Set<() => void>>();
  const sockets = new Set<WebSocket>();
  const connect = dependencies.connectProvider ?? openProvider;

  app.post('/twilio/incoming', async (request, reply) => {
    const call = signedCall(config, request, '/twilio/incoming');
    if (!call) return reply.code(403).send({ error: 'Invalid provider callback' });
    try {
      const response = await api.admit({
        providerCallSid: call.callSid,
        accountSid: config.accountSid,
      });
      return reply.type('text/xml').send(response.twiml);
    } catch {
      return reply.code(503).send({ error: 'Voice admission unavailable' });
    }
  });

  app.post('/twilio/status', async (request, reply) => {
    const call = signedCall(config, request, '/twilio/status');
    if (!call) return reply.code(403).send({ error: 'Invalid provider callback' });
    if (
      ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(
        call.params.CallStatus ?? '',
      )
    ) {
      try {
        await api.end({ providerCallSid: call.callSid, reason: 'provider_terminal' });
      } catch {
        return reply.code(503).send({ error: 'Voice status unavailable' });
      }
      for (const close of activeCalls.get(call.callSid) ?? []) close();
    }
    // Late nonterminal callbacks never reopen a spent grant.
    return reply.code(204).send();
  });

  app.post('/twilio/confirmation/:token', async (request, reply) => {
    const token = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(request.params);
    if (!token.success) return reply.code(403).send({ error: 'Invalid provider callback' });
    const call = signedCall(config, request, `/twilio/confirmation/${token.data.token}`);
    if (!call) return reply.code(403).send({ error: 'Invalid provider callback' });
    const confidence =
      call.params.Confidence === undefined ? undefined : Number(call.params.Confidence);
    const digits = call.params.Digits;
    if (
      (confidence !== undefined &&
        (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) ||
      (digits !== undefined && !/^[0-9*#]?$/.test(digits)) ||
      (Boolean(digits) && Boolean(call.params.SpeechResult))
    )
      return reply.code(400).send({ error: 'Invalid confirmation input' });
    try {
      const result = await api.confirmation({
        providerCallSid: call.callSid,
        confirmationToken: token.data.token,
        ...(call.params.SpeechResult === undefined
          ? {}
          : { speechResult: call.params.SpeechResult }),
        ...(digits === undefined ? {} : { digits }),
        ...(confidence === undefined ? {} : { confidence }),
      });
      return reply.type('text/xml').send(result.twiml);
    } catch {
      return reply.code(503).send({ error: 'Voice confirmation unavailable' });
    }
  });

  app.post('/twilio/transfer-status/:token', async (request, reply) => {
    const token = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(request.params);
    if (!token.success) return reply.code(403).send({ error: 'Invalid provider callback' });
    const call = signedCall(config, request, `/twilio/transfer-status/${token.data.token}`, false);
    if (
      !call ||
      !call.params.CallStatus ||
      ![
        'initiated',
        'ringing',
        'answered',
        'in-progress',
        'completed',
        'busy',
        'failed',
        'no-answer',
        'canceled',
      ].includes(call.params.CallStatus)
    )
      return reply.code(403).send({ error: 'Invalid provider callback' });
    if (
      call.params.ParentCallSid !== undefined &&
      !callSidSchema.safeParse(call.params.ParentCallSid).success
    )
      return reply.code(400).send({ error: 'Invalid transfer binding' });
    try {
      await api.transferStatus({
        transferToken: token.data.token,
        childCallSid: call.callSid,
        status: call.params.CallStatus,
        ...(call.params.ParentCallSid === undefined
          ? {}
          : { parentCallSid: call.params.ParentCallSid }),
      });
      return reply.code(204).send();
    } catch {
      return reply.code(503).send({ error: 'Voice transfer status unavailable' });
    }
  });

  app.post('/twilio/transfer-result/:token', async (request, reply) => {
    const token = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(request.params);
    if (!token.success) return reply.code(403).send({ error: 'Invalid provider callback' });
    // Dial action callbacks identify the parent inbound leg; Number callbacks above identify the child.
    const call = signedCall(config, request, `/twilio/transfer-result/${token.data.token}`);
    if (
      !call ||
      !call.params.DialCallStatus ||
      !['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(call.params.DialCallStatus)
    )
      return reply.code(403).send({ error: 'Invalid provider callback' });
    if (
      (call.params.DialCallSid !== undefined &&
        !callSidSchema.safeParse(call.params.DialCallSid).success) ||
      (call.params.DialBridged !== undefined &&
        !['true', 'false'].includes(call.params.DialBridged))
    )
      return reply.code(400).send({ error: 'Invalid transfer result' });
    try {
      const result = await api.transferResult({
        providerCallSid: call.callSid,
        transferToken: token.data.token,
        dialCallStatus: call.params.DialCallStatus,
        bridged: call.params.DialBridged === 'true',
        ...(call.params.DialCallSid === undefined ? {} : { dialCallSid: call.params.DialCallSid }),
      });
      return reply.type('text/xml').send(result.twiml);
    } catch {
      return reply.code(503).send({ error: 'Voice transfer result unavailable' });
    }
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
      // Switch to the durable internal call UUID after authenticated redemption
      // so API confirmation stages and resumed streams can be correlated.
      let diagnosticId: string = randomUUID();
      let transcriptCallId: string | undefined;
      const capture = (event: VoiceTranscriptEvent) => {
        if (!config.debugTranscripts || !transcriptCallId) return;
        try {
          void Promise.resolve(
            dependencies.voiceTranscripts?.record(transcriptCallId, event, generation),
          ).catch(() => {});
        } catch {
          /* Debug capture never controls the call. */
        }
      };
      const diagnose = (
        event: 'voice.stream_closed' | 'voice.relay' | 'voice.workflow' | 'voice.control_error',
        code:
          | StreamCloseCode
          | RelayDiagnosticCode
          | LiveWorkflowStage
          | GatewayWorkflowStage
          | VoiceControlError['code'],
      ) => {
        capture({ kind: 'stage', code });
        try {
          (dependencies.onDiagnostic ?? logEvent)({ event, requestId: diagnosticId, code });
        } catch {
          // A diagnostic sink failure must not prevent stream cleanup.
        }
      };
      const stage = (code: LiveWorkflowStage | GatewayWorkflowStage) =>
        diagnose('voice.workflow', code);
      let closeCode: StreamCloseCode = 'stream_closed';
      const controlCancellation = new AbortController();
      let closed = false;
      let connected = false;
      let callSid: string | undefined;
      let generation: string | undefined;
      let callExpiresAt: number | undefined;
      let streamSid: string | undefined;
      let provider: ProviderSocket | undefined;
      let relay: AudioRelay | LiveAudioRelay | undefined;
      let lastSequence = -1;
      let lastTimestamp = -1;
      const mediaRate = new MediaRateLimiter();
      let pending: Array<{ payload: string; receivedAt: number }> = [];
      let pendingBytes = 0;
      let providerTimer: ReturnType<typeof setTimeout> | undefined;
      let durationTimer: ReturnType<typeof setTimeout> | undefined;
      let policyTimer: ReturnType<typeof setTimeout> | undefined;
      let policyDeadline: ReturnType<typeof setTimeout> | undefined;
      let initialConfigurationVersion: number | undefined;
      let policyCapabilities: { actionsEnabled: boolean; transfersEnabled: boolean } | undefined;
      let policyCheckedAt = Number.NEGATIVE_INFINITY;
      let policyInFlight: Promise<boolean> | undefined;
      let controlOwned = false;
      let validatingResponse = false;
      let responseQueue: string[] = [];
      let responseQueueBytes = 0;
      let responseQueueAudioBytes = 0;
      const close = () => {
        if (closed) return;
        closed = true;
        diagnose('voice.stream_closed', closeCode);
        controlCancellation.abort();
        clearTimeout(startTimer);
        if (providerTimer) clearTimeout(providerTimer);
        if (durationTimer) clearTimeout(durationTimer);
        if (policyTimer) clearTimeout(policyTimer);
        if (policyDeadline) clearTimeout(policyDeadline);
        pending = [];
        responseQueue = [];
        responseQueueBytes = 0;
        responseQueueAudioBytes = 0;
        relay?.close();
        // terminate a pending connection instead of leaving handshake work alive.
        if (provider?.readyState === WebSocket.CONNECTING) provider.terminate();
        else if (config.model !== 'gpt-live-1' || !relay) provider?.close(1000, 'Session ended');
        socket.close(1000, 'Session ended');
        if (callSid) {
          const registered = activeCalls.get(callSid);
          registered?.delete(close);
          if (registered?.size === 0) activeCalls.delete(callSid);
        }
        if (callSid && generation) {
          void api
            .end({ providerCallSid: callSid, generation, reason: 'stream_closed' })
            .catch(() => {
              /* bounded API failure cannot reopen a durable lease */
            });
        }
      };
      const fail = (code: StreamCloseCode) => {
        closeCode = code;
        close();
      };
      const startTimer = setTimeout(() => fail('start_timeout'), 5000);
      startTimer.unref();

      const checkPolicy = (force = false): Promise<boolean> => {
        if (closed || !callSid || !generation || initialConfigurationVersion === undefined)
          return Promise.resolve(false);
        if (policyInFlight) return policyInFlight;
        // Response bursts may reuse at most one second of successful policy
        // knowledge; this caps request frequency without claiming instant revocation.
        const policyAge = now() - policyCheckedAt;
        if (!force && policyAge >= 0 && policyAge < 1000) return Promise.resolve(true);
        const binding = { providerCallSid: callSid, generation };
        let rejectCancelled: (() => void) | undefined;
        const cancelled = new Promise<never>((_resolve, reject) => {
          rejectCancelled = () => reject(new Error('Voice policy cancelled'));
          controlCancellation.signal.addEventListener('abort', rejectCancelled, { once: true });
        });
        const deadline = new Promise<never>((_resolve, reject) => {
          policyDeadline = setTimeout(() => reject(new Error('Voice policy deadline')), 3000);
          policyDeadline.unref();
        });
        policyInFlight = Promise.race([
          Promise.resolve().then(() => {
            if (closed) throw new Error('Voice policy cancelled');
            return api.policy(binding, controlCancellation.signal);
          }),
          cancelled,
          deadline,
        ])
          .then((policy) => {
            if (closed) return false;
            // A tool hands ownership to deterministic API/provider control.
            // Its own current-policy checks fence preparation and dispatch.
            if (controlOwned) return true;
            if (
              !policy.allowed ||
              policy.configurationVersion !== initialConfigurationVersion ||
              (policyCapabilities?.actionsEnabled && !policy.actionsEnabled) ||
              (policyCapabilities?.transfersEnabled && !policy.transfersEnabled)
            ) {
              fail('policy_denied');
              return false;
            }
            policyCheckedAt = now();
            return true;
          })
          .catch(() => {
            // A heartbeat that began during audio must not cancel a control
            // already owned and reauthorized by the API's dispatch boundary.
            if (!controlOwned) fail('policy_unavailable');
            return false;
          })
          .finally(() => {
            if (policyDeadline) clearTimeout(policyDeadline);
            if (rejectCancelled)
              controlCancellation.signal.removeEventListener('abort', rejectCancelled);
            policyDeadline = undefined;
            policyInFlight = undefined;
          });
        return policyInFlight;
      };

      const schedulePolicy = () => {
        if (closed || controlOwned) return;
        if (policyTimer) clearTimeout(policyTimer);
        // Each request has a three-second deadline, so failure/change detection
        // is bounded by roughly eight seconds, plus event-loop scheduling.
        policyTimer = setTimeout(() => {
          void checkPolicy(true).then((allowed) => {
            if (allowed) schedulePolicy();
          });
        }, 5000);
        policyTimer.unref();
      };

      const receiveProviderEvent = (raw: string) => {
        if (closed) {
          // Only the Live relay's bounded finalization listener remains active.
          // Its closed state discards content and accepts session.closed alone.
          if (config.model === 'gpt-live-1') relay?.providerEvent(raw);
          return;
        }
        const bytes = Buffer.byteLength(raw);
        if (bytes > 192 * 1024) return fail('provider_protocol_invalid');
        let type: string;
        try {
          const event = z
            .object({ type: z.string().max(120) })
            .passthrough()
            .parse(JSON.parse(raw));
          type = event.type;
          if (config.model === 'gpt-live-1') {
            // Live has continuous output rather than Realtime response boundaries.
            // Caller fragments bypass this output queue so newer corrections can
            // invalidate backend work even while permission is being refreshed.
            if (type === 'session.input_transcript.delta' || type === 'error') {
              relay?.providerEvent(raw);
              return;
            }
            if (
              validatingResponse ||
              type === 'session.output_audio.delta' ||
              type === 'session.delegation.created'
            ) {
              responseQueueBytes += bytes;
              if (type === 'session.output_audio.delta') {
                const audio = z.object({ delta: z.string().max(128 * 1024) }).parse(event);
                const decoded = decodeAudio(audio.delta, 96 * 1024);
                if (!decoded) return fail('provider_protocol_invalid');
                responseQueueAudioBytes += decoded.length;
              }
              if (
                responseQueue.length >= 64 ||
                responseQueueBytes > 192 * 1024 ||
                responseQueueAudioBytes > 16_000
              )
                return fail('response_buffer_limit');
              responseQueue.push(raw);
              if (!validatingResponse) {
                validatingResponse = true;
                void checkPolicy().then((allowed) => {
                  if (!allowed || closed) return;
                  const events = responseQueue;
                  responseQueue = [];
                  responseQueueBytes = 0;
                  responseQueueAudioBytes = 0;
                  validatingResponse = false;
                  for (const eventRaw of events) {
                    if (closed) break;
                    relay?.providerEvent(eventRaw);
                  }
                });
              }
              return;
            }
          }
          if (validatingResponse && type === 'input_audio_buffer.speech_started') {
            // Barge-in must clear/cancel promptly even while output permission
            // is being checked. The response metadata was registered below.
            relay?.providerEvent(raw);
            return;
          }
          if (type === 'response.created' && !controlOwned && !validatingResponse) {
            // Register metadata immediately so interruption can cancel this
            // response; no output or tool execution crosses the policy gate.
            relay?.providerEvent(raw);
            if (closed) return;
            validatingResponse = true;
            void checkPolicy().then((allowed) => {
              if (!allowed || closed) return;
              const events = responseQueue;
              responseQueue = [];
              responseQueueBytes = 0;
              responseQueueAudioBytes = 0;
              validatingResponse = false;
              for (const eventRaw of events) {
                if (closed) break;
                relay?.providerEvent(eventRaw);
              }
            });
            return;
          }
          if (validatingResponse) {
            responseQueueBytes += bytes;
            if (type === 'response.output_audio.delta') {
              const audio = z.object({ delta: z.string().max(128 * 1024) }).parse(event);
              const decoded = decodeAudio(audio.delta, 96 * 1024);
              if (!decoded) return fail('provider_protocol_invalid');
              responseQueueAudioBytes += decoded.length;
            }
            if (
              responseQueue.length >= 64 ||
              responseQueueBytes > 192 * 1024 ||
              responseQueueAudioBytes > 16_000
            )
              return fail('response_buffer_limit');
            responseQueue.push(raw);
            return;
          }
        } catch {
          return fail('provider_protocol_invalid');
        }
        relay?.providerEvent(raw);
        if (relay?.isReady && providerTimer) clearTimeout(providerTimer);
      };

      const performTool = async (
        request: VoiceToolRequest,
      ): Promise<'controlled' | 'unavailable'> => {
        if (closed || !callSid || !generation) return 'unavailable';
        const binding = { providerCallSid: callSid, generation };
        stage(request.kind === 'proposal' ? 'proposal_started' : 'transfer_started');
        let preparation;
        try {
          preparation =
            request.kind === 'proposal'
              ? await api.propose({
                  ...binding,
                  toolCallId: request.toolCallId,
                  utteranceStartedAt: request.utteranceStartedAt,
                  proposal: request.proposal,
                })
              : await api.transfer({
                  ...binding,
                  toolCallId: request.toolCallId,
                  context: request.context,
                });
        } catch (error) {
          stage(request.kind === 'proposal' ? 'proposal_failed' : 'transfer_failed');
          diagnose(
            'voice.control_error',
            error instanceof VoiceControlError ? error.code : 'CONTROL_UNAVAILABLE',
          );
          return 'unavailable';
        }
        stage(request.kind === 'proposal' ? 'proposal_prepared' : 'transfer_prepared');
        if (closed) return 'controlled';
        // Durable compare-and-set precedes the single non-idempotent provider update.
        // A lost response or repeat tool delivery is never a reason to issue it twice.
        let dispatch;
        try {
          stage('dispatch_started');
          dispatch = await api.dispatch({ ...binding, controlId: preparation.controlId });
        } catch {
          stage('dispatch_failed');
          close();
          return 'controlled';
        }
        if (!dispatch.dispatch) {
          stage(dispatch.unavailable ? 'dispatch_unavailable' : 'dispatch_already_owned');
          return dispatch.unavailable ? 'unavailable' : 'controlled';
        }
        stage('dispatch_admitted');
        if (!dispatch.twiml) {
          close();
          return 'controlled';
        }
        // A fulfilled promise can run before an overdue timer. Recheck the
        // original authoritative deadline immediately before the provider write.
        if (closed || callExpiresAt === undefined || now() >= callExpiresAt) {
          stage('dispatch_expired');
          try {
            await api.dispatched({
              ...binding,
              controlId: preparation.controlId,
              outcome: 'rejected',
            });
          } catch {
            /* the dispatch record remains fenced; never send or retry */
          }
          close();
          return 'controlled';
        }
        let result: CallControlResult;
        try {
          result = await controller.dispatch(callSid, dispatch.twiml, controlCancellation.signal);
        } catch {
          result = { outcome: 'unknown' };
        }
        stage(
          result.outcome === 'accepted'
            ? 'dispatch_accepted'
            : result.outcome === 'rejected'
              ? 'dispatch_rejected'
              : 'dispatch_unknown',
        );
        try {
          await api.dispatched({
            ...binding,
            controlId: preparation.controlId,
            outcome: result.outcome,
          });
        } catch {
          // The durable record still has an admitted dispatch. Hold rather than
          // continuing a call whose authoritative control result is unavailable.
          stage('dispatch_receipt_failed');
          close();
          return 'controlled';
        }
        if (result.outcome === 'rejected') return 'unavailable';
        close();
        return 'controlled';
      };

      const executeTool = async (
        request: VoiceToolRequest,
      ): Promise<'controlled' | 'unavailable'> => {
        controlOwned = true;
        if (policyTimer) clearTimeout(policyTimer);
        const result = await performTool(request);
        if (result === 'unavailable' && !closed) {
          controlOwned = false;
          if (!(await checkPolicy(true))) {
            close();
            return 'controlled';
          }
          schedulePolicy();
        }
        return result;
      };

      const startProvider = async (
        startCallSid: string,
        startStreamSid: string,
        streamGrant: string,
      ) => {
        try {
          const context = await api.redeem({
            providerCallSid: startCallSid,
            streamSid: startStreamSid,
            streamGrant,
          });
          diagnosticId = context.voiceCallId;
          generation = context.generation;
          transcriptCallId = context.voiceCallId;
          stage('stream_bound');
          if (closed || !streamSid) {
            await api.end({ providerCallSid: startCallSid, generation, reason: 'stream_closed' });
            return;
          }
          callExpiresAt = Date.parse(context.expiresAt);
          initialConfigurationVersion = context.configurationVersion;
          policyCapabilities = {
            actionsEnabled: config.actionsEnabled && context.actionsEnabled,
            transfersEnabled: config.transfersEnabled && context.transfersEnabled,
          };
          const remainingMs = callExpiresAt - now();
          if (remainingMs <= 0) return fail('duration_limit');
          if (durationTimer) clearTimeout(durationTimer);
          durationTimer = setTimeout(
            () => fail('duration_limit'),
            Math.min(remainingMs, config.maxCallSeconds * 1000),
          );
          durationTimer.unref();
          if (!(await checkPolicy(true)) || closed) return;
          schedulePolicy();
          const capabilities = {
            ...policyCapabilities,
            outcome: context.outcome,
          };
          provider = connect(config);
          const relayOptions = {
            ...capabilities,
            now,
            onTool: executeTool,
            onDiagnostic: (code: RelayDiagnosticCode) => diagnose('voice.relay', code),
          };
          relay =
            config.model === 'gpt-live-1'
              ? new LiveAudioRelay(socket, provider, streamSid, close, {
                  ...relayOptions,
                  opening: liveOpening(context.restaurant, capabilities),
                  onStage: stage,
                  onTranscript: capture,
                  onDelegate:
                    dependencies.delegate ??
                    createLiveBackend({
                      ...capabilities,
                      apiKey: config.openaiKey,
                      model: config.backendModel,
                      instructions: liveBackendInstructions(context.restaurant, capabilities),
                    }),
                })
              : new AudioRelay(socket, provider, streamSid, close, relayOptions);
          for (const input of pending) relay.input(input.payload, input.receivedAt);
          pending = [];
          pendingBytes = 0;
          provider.on('open', () =>
            relay?.configure(
              config.model === 'gpt-live-1'
                ? liveVoiceInstructions(context.restaurant, capabilities)
                : voiceInstructions(context.restaurant, capabilities),
            ),
          );
          provider.on('message', (data, binary) => {
            if (binary) return fail('provider_protocol_invalid');
            receiveProviderEvent(data.toString());
          });
          provider.on('close', () => fail('provider_closed'));
          provider.on('error', () => fail('provider_socket_error'));
        } catch {
          fail('provider_setup_failed');
        }
      };

      // Register synchronously before the first context fetch to avoid losing media.
      socket.on('message', (data, binary) => {
        if (closed) return;
        try {
          if (binary || Buffer.byteLength(data.toString()) > 8192)
            return fail('media_protocol_invalid');
          const tick = now();
          const messageLimit = mediaRate.message(tick);
          if (messageLimit) return fail(messageLimit);
          const event = mediaEvent.parse(JSON.parse(data.toString()));
          if (event.event !== 'media') {
            const limit = mediaRate.event(event.event === 'mark' ? 'mark' : 'control', tick);
            if (limit) return fail(limit);
          }
          if (event.event === 'connected') {
            if (connected || streamSid) return fail('media_protocol_invalid');
            connected = true;
            return;
          }
          const currentSequence = Number(event.sequenceNumber);
          if (currentSequence <= lastSequence) return fail('media_protocol_invalid');
          lastSequence = currentSequence;
          if (event.event === 'start') {
            if (
              !connected ||
              streamSid ||
              event.start.accountSid !== config.accountSid ||
              event.start.streamSid !== event.streamSid
            )
              return fail('media_protocol_invalid');
            callSid = event.start.callSid;
            const registered = activeCalls.get(callSid) ?? new Set<() => void>();
            registered.add(close);
            activeCalls.set(callSid, registered);
            streamSid = event.streamSid;
            clearTimeout(startTimer);
            durationTimer = setTimeout(() => fail('duration_limit'), config.maxCallSeconds * 1000);
            durationTimer.unref();
            providerTimer = setTimeout(() => fail('provider_setup_timeout'), 10_000);
            providerTimer.unref();
            void startProvider(
              event.start.callSid,
              event.streamSid,
              event.start.customParameters.grant,
            );
            return;
          }
          if (!streamSid || event.streamSid !== streamSid) return fail('media_protocol_invalid');
          if (event.event === 'media') {
            const audio = decodeAudio(event.media.payload, 3200);
            const timestamp = Number(event.media.timestamp);
            if (
              !audio ||
              timestamp < lastTimestamp ||
              timestamp > config.maxCallSeconds * 1000 + 1000
            )
              return fail('media_protocol_invalid');
            lastTimestamp = timestamp;
            const audioLimit = mediaRate.event('media', tick, audio.length);
            if (audioLimit) return fail(audioLimit);
            if (relay) relay.input(event.media.payload, tick);
            else {
              pendingBytes += audio.length;
              if (pendingBytes > 16_000 || pending.length >= 150) return fail('input_buffer_limit');
              pending.push({ payload: event.media.payload, receivedAt: tick });
            }
          } else if (event.event === 'mark') relay?.played(event.mark.name);
          else if (event.event === 'stop') {
            if (event.stop.callSid !== callSid || event.stop.accountSid !== config.accountSid)
              return fail('media_protocol_invalid');
            fail('caller_stopped');
          }
          // DTMF grants no authority and never executes a command.
        } catch {
          fail('media_protocol_invalid');
        }
      });
      socket.on('close', () => {
        sockets.delete(socket);
        close();
      });
      socket.on('error', () => fail('media_socket_error'));
    },
  );

  app.addHook('preClose', async () => {
    for (const socket of sockets) socket.close(1001, 'Gateway shutting down');
  });
  return app;
}
