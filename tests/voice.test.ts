import { createHmac } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { loadVoiceConfig, type EnabledVoiceConfig } from '../apps/voice-gateway/src/config.js';
import { createVoiceGateway, type ProviderSocket } from '../apps/voice-gateway/src/gateway.js';
import { AudioRelay, type AudioPeer } from '../apps/voice-gateway/src/relay.js';
import { CallRegistry } from '../apps/voice-gateway/src/registry.js';
import { voiceInstructions } from '../apps/voice-gateway/src/context.js';
import type { Restaurant } from '../packages/contracts/src/index.js';

const account = `AC${'a'.repeat(32)}`;
const call = `CA${'b'.repeat(32)}`;
const stream = `MZ${'c'.repeat(32)}`;
const environment = {
  LIVE_VOICE_ENABLED: 'true',
  VOICE_MODE: 'sandbox',
  TWILIO_ACCOUNT_SID: account,
  TWILIO_AUTH_TOKEN: 'synthetic-twilio-test-token',
  TWILIO_PHONE_NUMBER: '+12125550142',
  OPENAI_API_KEY: 'synthetic-openai-test-key',
  VOICE_PUBLIC_URL: 'https://voice.example.test',
  VOICE_SERVICE_TOKEN: 'synthetic-internal-service-token-at-least-32-chars',
  VOICE_TENANT_ID: '11111111-1111-4111-8111-111111111111',
};
function config(): EnabledVoiceConfig {
  const result = loadVoiceConfig(environment);
  if (!result.enabled) throw new Error('Test configuration disabled');
  return result;
}
const restaurant: Restaurant = {
  id: '11111111-1111-4111-8111-111111111111',
  version: 1,
  updatedAt: '2026-09-30T12:00:00Z',
  name: 'Synthetic Harbor',
  timezone: 'America/New_York',
  address: '123 Example Street',
  publicPhone: '+12125550100',
  greeting: 'Welcome to the restaurant',
  followUpMessage: 'Staff review requests separately.',
  maxPartySize: 10,
  maxRequestDays: 60,
  hours: Array.from({ length: 7 }, (_, day) => ({
    day,
    closed: false,
    open: '12:00',
    close: '22:00',
  })),
  holidayClosures: [],
  faqs: [],
  menu: [],
  transferLabel: 'Host stand',
  transferNumber: '+12125550101',
  transferEnabled: true,
};

function signed(path: string, params: Record<string, string>, streamSignature = false) {
  const url = `${streamSignature ? 'wss' : 'https'}://voice.example.test${path}`;
  const text = Object.keys(params)
    .sort()
    .reduce((sum, key) => sum + key + params[key], url);
  return createHmac('sha1', environment.TWILIO_AUTH_TOKEN).update(text).digest('base64');
}
function callbackParams(sid = call) {
  return {
    AccountSid: account,
    CallSid: sid,
    To: environment.TWILIO_PHONE_NUMBER,
    Direction: 'inbound',
  };
}
function callback(path = '/twilio/incoming', params: Record<string, string> = callbackParams()) {
  return {
    method: 'POST' as const,
    url: path,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signed(path, params),
    },
    payload: new URLSearchParams(params).toString(),
  };
}
function grant(xml: string): string {
  const value = xml.match(/name="grant" value="([a-f0-9]+)"/)?.[1];
  if (!value) throw new Error('Missing grant');
  return value;
}
function start(token: string, sid = call) {
  return {
    event: 'start',
    sequenceNumber: '1',
    streamSid: stream,
    start: {
      streamSid: stream,
      accountSid: account,
      callSid: sid,
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      customParameters: { grant: token },
    },
  };
}
const connected = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });
const socketHeaders = { 'x-twilio-signature': signed('/twilio/media', {}, true) };

class Peer extends EventEmitter implements AudioPeer, ProviderSocket {
  readyState = 1;
  bufferedAmount = 0;
  events: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.events.push(JSON.parse(data));
  }
  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.emit('close');
    }
  }
  terminate() {
    this.close();
  }
}

describe('voice admission and limits', () => {
  it('is disabled without secrets and refuses incomplete or production activation', async () => {
    expect(loadVoiceConfig({})).toEqual({ enabled: false, port: 3002 });
    expect(() => loadVoiceConfig({ LIVE_VOICE_ENABLED: 'true' })).toThrow(
      'Invalid voice configuration',
    );
    expect(() => loadVoiceConfig({ ...environment, NODE_ENV: 'production' })).toThrow(
      'Production voice activation',
    );
    expect(() =>
      loadVoiceConfig({ ...environment, VOICE_PUBLIC_URL: 'http://voice.example.test' }),
    ).toThrow();
    expect(() =>
      loadVoiceConfig({ ...environment, API_INTERNAL_URL: 'http://untrusted.test' }),
    ).toThrow();
    const connect = vi.fn();
    const app = await createVoiceGateway(loadVoiceConfig({}), { connectProvider: connect });
    try {
      expect((await app.inject(callback())).statusCode).toBe(503);
      expect((await app.inject('/health')).json()).toMatchObject({
        liveVoiceEnabled: false,
        productionReady: false,
      });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects forged, wrong account, wrong number, query and attacker-origin signatures', async () => {
    const app = await createVoiceGateway(config());
    try {
      const valid = callback();
      expect(
        (
          await app.inject({
            ...valid,
            headers: { ...valid.headers, 'x-twilio-signature': 'invalid' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject(
            callback('/twilio/incoming', {
              ...callbackParams(),
              AccountSid: `AC${'d'.repeat(32)}`,
            }),
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject(
            callback('/twilio/incoming', { ...callbackParams(), To: '+12125550999' }),
          )
        ).statusCode,
      ).toBe(403);
      expect((await app.inject({ ...valid, url: '/twilio/incoming?tenant=evil' })).statusCode).toBe(
        403,
      );
      const hostileUrl = 'https://evil.test/twilio/incoming';
      const params = callbackParams();
      const hostile = createHmac('sha1', environment.TWILIO_AUTH_TOKEN)
        .update(
          Object.keys(params)
            .sort()
            .reduce((sum, key) => sum + key + params[key as keyof typeof params], hostileUrl),
        )
        .digest('base64');
      expect(
        (
          await app.inject({
            ...valid,
            headers: {
              ...valid.headers,
              host: 'evil.test',
              'x-forwarded-host': 'evil.test',
              'x-twilio-signature': hostile,
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ ...valid, headers: { ...valid.headers, host: 'internal.local' } }))
          .statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('returns stable callback instructions, bounds admission, expires and spends grants', async () => {
    let now = 0;
    const registry = new CallRegistry(1, () => now, 2);
    const first = registry.incoming(call, (token) => token);
    expect(first).toBeTypeOf('string');
    expect(registry.incoming('other', () => 'no')).toBeUndefined();
    expect(registry.redeem('other', first!, () => undefined)).toBe(false);
    expect(registry.redeem(call, '0'.repeat(64), () => undefined)).toBe(false);
    const ended = vi.fn();
    expect(registry.redeem(call, first!, ended)).toBe(true);
    expect(registry.redeem(call, first!, ended)).toBe(false);
    registry.end(call);
    registry.end(call);
    expect(ended).toHaveBeenCalledOnce();
    expect(registry.incoming(call, () => 'new')).toBe(first);
    expect(registry.redeem(call, first!, ended)).toBe(false);
    const expired = registry.incoming('second', (token) => token);
    now = 30_001;
    expect(registry.redeem('second', expired!, ended)).toBe(false);
    expect(registry.incoming('third', () => 'overflow')).toBeUndefined();

    const app = await createVoiceGateway(config());
    try {
      const initial = await app.inject(callback());
      expect((await app.inject(callback())).body).toBe(initial.body);
      const done = { ...callbackParams(), CallStatus: 'completed' };
      expect((await app.inject(callback('/twilio/status', done))).statusCode).toBe(204);
      expect((await app.inject(callback())).body).toBe(initial.body);
      const earlyCall = `CA${'f'.repeat(32)}`;
      await app.inject(
        callback('/twilio/status', { ...callbackParams(earlyCall), CallStatus: 'completed' }),
      );
      const lateIncoming = await app.inject(
        callback('/twilio/incoming', callbackParams(earlyCall)),
      );
      expect(lateIncoming.body).toContain('<Hangup');
      expect(lateIncoming.body).not.toContain('grant');
    } finally {
      await app.close();
    }
  });

  it('rejects unsigned media upgrades and mismatched call binding before opening a provider', async () => {
    const context = vi.fn(async () => restaurant);
    const connect = vi.fn(() => new Peer());
    const app = await createVoiceGateway(config(), { context, connectProvider: connect });
    await app.ready();
    try {
      await expect(app.injectWS('/twilio/media')).rejects.toThrow();
      const response = await app.inject(callback());
      const socket = await app.injectWS('/twilio/media', { headers: socketHeaders });
      const closed = once(socket, 'close');
      socket.send(connected);
      socket.send(JSON.stringify(start(grant(response.body), `CA${'e'.repeat(32)}`)));
      await closed;
      expect(context).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('opens a provider only after verified start and closes both peers on stream mismatch', async () => {
    const provider = new Peer();
    const connect = vi.fn(() => provider);
    const app = await createVoiceGateway(config(), {
      context: async () => restaurant,
      connectProvider: connect,
    });
    await app.ready();
    try {
      const response = await app.inject(callback());
      const token = grant(response.body);
      const socket = await app.injectWS('/twilio/media', { headers: socketHeaders });
      socket.send(connected);
      socket.send(JSON.stringify(start(token)));
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
      provider.emit('open');
      expect(provider.events[0]).toMatchObject({
        type: 'session.update',
        session: { type: 'realtime', tools: [], tool_choice: 'none' },
      });
      const closed = once(socket, 'close');
      socket.send(
        JSON.stringify({
          event: 'media',
          sequenceNumber: '2',
          streamSid: `MZ${'d'.repeat(32)}`,
          media: {
            timestamp: '0',
            chunk: '1',
            track: 'inbound',
            payload: Buffer.alloc(160).toString('base64'),
          },
        }),
      );
      await closed;
      expect(provider.readyState).toBe(3);
      const retry = await app.injectWS('/twilio/media', { headers: socketHeaders });
      const retryClosed = once(retry, 'close');
      retry.send(connected);
      retry.send(JSON.stringify(start(token)));
      await retryClosed;
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('enforces the provisional socket cap across simultaneous verified upgrades', async () => {
    const app = await createVoiceGateway(config());
    await app.ready();
    try {
      const attempted = await Promise.allSettled(
        Array.from({ length: 20 }, () => app.injectWS('/twilio/media', { headers: socketHeaders })),
      );
      const sockets = attempted.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      await vi.waitFor(() =>
        expect(sockets.filter((socket) => socket.readyState === 1)).toHaveLength(4),
      );
      for (const socket of sockets) socket.close();
      await vi.waitFor(() => expect(sockets.every((socket) => socket.readyState === 3)).toBe(true));
      // injectWS uses paired in-memory streams rather than TCP; explicitly finish
      // the server transport after the client handshake to model the peer FIN.
      for (const socket of app.websocketServer.clients) socket.terminate();
      await vi.waitFor(() => expect(app.websocketServer.clients.size).toBe(0));
      // Capacity is recovered only after a socket closes.
      const next = await app.injectWS('/twilio/media', { headers: socketHeaders });
      expect(next.readyState).toBe(1);
      next.close();
    } finally {
      await app.close();
    }
  });
});

function relayFixture() {
  const telephone = new Peer();
  const provider = new Peer();
  const close = vi.fn();
  const relay = new AudioRelay(telephone, provider, stream, close);
  relay.configure('Synthetic approved facts only');
  const event = (value: object) => relay.providerEvent(JSON.stringify(value));
  event({ type: 'session.updated' });
  const created = (id: string) => event({ type: 'response.created', response: { id } });
  const audio = (responseId: string, itemId = 'item1', bytes = 1600) =>
    event({
      type: 'response.output_audio.delta',
      response_id: responseId,
      item_id: itemId,
      content_index: 0,
      delta: Buffer.alloc(bytes).toString('base64'),
    });
  return { telephone, provider, close, relay, event, created, audio };
}

describe('voice audio protocol', () => {
  it('forwards μ-law input, emits media/marks and truncates only acknowledged playback', () => {
    const { telephone, provider, relay, event, created, audio } = relayFixture();
    const payload = Buffer.alloc(160).toString('base64');
    relay.input(payload);
    expect(provider.events.at(-1)).toEqual({ type: 'input_audio_buffer.append', audio: payload });
    created('r1');
    audio('r1');
    expect(telephone.events.filter((value) => value.event === 'media')).toHaveLength(2);
    relay.played('p1'); // 100 ms heard; 100 ms still in Twilio's queue.
    event({ type: 'input_audio_buffer.speech_started' });
    expect(telephone.events.at(-1)).toEqual({ event: 'clear', streamSid: stream });
    expect(provider.events).toContainEqual({ type: 'response.cancel', response_id: 'r1' });
    expect(provider.events).toContainEqual({
      type: 'conversation.item.truncate',
      item_id: 'item1',
      content_index: 0,
      audio_end_ms: 100,
    });
    const count = telephone.events.length;
    audio('r1');
    expect(telephone.events).toHaveLength(count);
    relay.played('p2'); // Clear acknowledgements are not playback evidence.
    event({ type: 'input_audio_buffer.speech_started' });
    expect(
      provider.events.filter((value) => value.type === 'conversation.item.truncate'),
    ).toHaveLength(1);
    relay.close();
  });

  it('clears queued completed output without cancelling a completed or fully heard response', () => {
    const { provider, relay, event, created, audio } = relayFixture();
    created('r1');
    audio('r1');
    event({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    relay.played('p1');
    event({ type: 'input_audio_buffer.speech_started' });
    expect(provider.events.filter((value) => value.type === 'response.cancel')).toHaveLength(0);
    expect(provider.events.at(-1)).toMatchObject({
      type: 'conversation.item.truncate',
      audio_end_ms: 100,
    });
    created('r2');
    audio('r2', 'item2', 800);
    relay.played('p3');
    event({ type: 'response.done', response: { id: 'r2', status: 'completed' } });
    event({ type: 'input_audio_buffer.speech_started' });
    expect(
      provider.events.filter((value) => value.type === 'conversation.item.truncate'),
    ).toHaveLength(1);
    relay.close();
  });

  it('bounds input, playback and socket backpressure and closes both transports once', () => {
    const cases = ['malformed', 'pending', 'backpressure', 'playback'] as const;
    for (const cause of cases) {
      const { relay, telephone, provider, close, created, audio } = relayFixture();
      if (cause === 'malformed') relay.input('not base64!');
      if (cause === 'pending') relay.providerEvent('{broken');
      if (cause === 'backpressure') {
        provider.bufferedAmount = 300_000;
        relay.input(Buffer.alloc(160).toString('base64'));
      }
      if (cause === 'playback') {
        created('r1');
        for (let index = 0; index < 3; index += 1) audio('r1', 'item1', 96 * 1024);
      }
      relay.close();
      expect(close).toHaveBeenCalledOnce();
      expect(telephone.readyState).toBe(3);
      expect(provider.readyState).toBe(3);
    }
  });

  it('ends failed or incomplete responses promptly while keeping caller cancellation usable', () => {
    for (const status of ['failed', 'incomplete']) {
      const { close, telephone, provider, event, created } = relayFixture();
      created('failed-response');
      event({
        type: 'response.done',
        response: {
          id: 'failed-response',
          status,
          status_details: { error: { message: 'Sensitive vendor error excluded from logs' } },
        },
      });
      expect(close).toHaveBeenCalledOnce();
      expect(telephone.readyState).toBe(3);
      expect(provider.readyState).toBe(3);
    }
    const interrupted = relayFixture();
    interrupted.created('interrupted-response');
    interrupted.event({ type: 'input_audio_buffer.speech_started' });
    interrupted.event({
      type: 'response.done',
      response: { id: 'interrupted-response', status: 'cancelled' },
    });
    expect(interrupted.close).not.toHaveBeenCalled();
    interrupted.created('next-response');
    interrupted.audio('next-response');
    expect(interrupted.telephone.events.some((event) => event.event === 'media')).toBe(true);
    interrupted.relay.close();
  });

  it('bounds pre-configuration input and ignores model tool proposals', () => {
    const phone = new Peer();
    const model = new Peer();
    const close = vi.fn();
    const relay = new AudioRelay(phone, model, stream, close);
    for (let index = 0; index < 6; index += 1) relay.input(Buffer.alloc(3200).toString('base64'));
    expect(close).toHaveBeenCalledOnce();
    const next = relayFixture();
    const before = next.provider.events.length;
    next.event({
      type: 'response.function_call_arguments.done',
      name: 'make_reservation',
      arguments: '{"tenant":"other"}',
    });
    expect(next.provider.events).toHaveLength(before);
    expect(next.telephone.events).toHaveLength(0);
    next.relay.close();
  });

  it('keeps staff destinations and internal identifiers out of model instructions', () => {
    const instructions = voiceInstructions(restaurant);
    expect(instructions).toContain('Synthetic Harbor');
    expect(instructions).not.toContain(restaurant.transferNumber);
    expect(instructions).not.toContain(restaurant.publicPhone);
    expect(instructions).not.toContain(restaurant.id);
    expect(instructions).toContain('No tools are available');
  });
});
