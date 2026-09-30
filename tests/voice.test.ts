import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { loadVoiceConfig, type EnabledVoiceConfig } from '../apps/voice-gateway/src/config.js';
import { createVoiceGateway, type ProviderSocket } from '../apps/voice-gateway/src/gateway.js';
import { AudioRelay, type AudioPeer } from '../apps/voice-gateway/src/relay.js';
import type { VoiceApiClient } from '../apps/voice-gateway/src/client.js';
import type { CallController } from '../apps/voice-gateway/src/control.js';
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

function fixtureApi(): VoiceApiClient {
  const entries = new Map<
    string,
    { token: string; generation: string; ended: boolean; spent: boolean; twiml: string }
  >();
  return {
    admit: vi.fn<VoiceApiClient['admit']>(async ({ providerCallSid }) => {
      let entry = entries.get(providerCallSid);
      if (!entry) {
        const token = 'd'.repeat(64);
        entry = {
          token,
          generation: randomUUID(),
          ended: false,
          spent: false,
          twiml: `<Response><Connect><Stream><Parameter name="grant" value="${token}"/></Stream></Connect></Response>`,
        };
        entries.set(providerCallSid, entry);
      }
      return {
        voiceCallId: restaurant.id,
        generation: entry.generation,
        tenantId: restaurant.id,
        twiml: entry.twiml,
        state: entry.ended ? ('ENDED' as const) : ('WAITING_FOR_STREAM' as const),
      };
    }),
    redeem: vi.fn<VoiceApiClient['redeem']>(async ({ providerCallSid, streamGrant }) => {
      const entry = entries.get(providerCallSid);
      if (!entry || entry.ended || entry.spent || entry.token !== streamGrant)
        throw new Error('Invalid grant');
      entry.spent = true;
      return {
        voiceCallId: restaurant.id,
        generation: entry.generation,
        tenantId: restaurant.id,
        restaurant,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        outcome: null,
        actionsEnabled: false,
        transfersEnabled: false,
        configurationVersion: restaurant.version,
      };
    }),
    policy: vi.fn<VoiceApiClient['policy']>(async () => ({
      allowed: true,
      configurationVersion: restaurant.version,
      actionsEnabled: true,
      transfersEnabled: true,
    })),
    end: vi.fn<VoiceApiClient['end']>(async ({ providerCallSid }) => {
      const entry = entries.get(providerCallSid);
      if (entry) entry.ended = true;
      else
        entries.set(providerCallSid, {
          token: '',
          generation: randomUUID(),
          ended: true,
          spent: true,
          twiml: '<Response><Hangup/></Response>',
        });
      return { state: 'ENDED' as const };
    }),
    propose: vi.fn(async () => {
      throw new Error('Disabled');
    }),
    transfer: vi.fn(async () => {
      throw new Error('Disabled');
    }),
    dispatch: vi.fn(async () => ({ dispatch: false, twiml: null, unavailable: false })),
    dispatched: vi.fn(async () => ({ state: 'CONTROL_PENDING' as const })),
    confirmation: vi.fn(async () => {
      throw new Error('Disabled');
    }),
    transferStatus: vi.fn(async () => ({ state: 'TRANSFERRING' as const })),
    transferResult: vi.fn(async () => {
      throw new Error('Disabled');
    }),
  };
}

async function openTestStream(
  api: VoiceApiClient,
  clock?: () => number,
  cfg = config(),
  controller?: CallController,
) {
  const provider = new Peer();
  const connect = vi.fn(() => provider);
  const app = await createVoiceGateway(cfg, {
    api,
    connectProvider: connect,
    ...(clock ? { now: clock } : {}),
    ...(controller ? { controller } : {}),
  });
  await app.ready();
  const admission = await app.inject(callback());
  const socket = await app.injectWS('/twilio/media', { headers: socketHeaders });
  const playback: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => playback.push(JSON.parse(data.toString())));
  socket.send(connected);
  socket.send(JSON.stringify(start(grant(admission.body))));
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  provider.emit('open');
  provider.emit('message', JSON.stringify({ type: 'session.updated' }), false);
  const response = (id = 'policy-response') =>
    provider.emit('message', JSON.stringify({ type: 'response.created', response: { id } }), false);
  const audio = (bytes = 800, id = 'policy-response') =>
    provider.emit(
      'message',
      JSON.stringify({
        type: 'response.output_audio.delta',
        response_id: id,
        item_id: 'policy-item',
        content_index: 0,
        delta: Buffer.alloc(bytes).toString('base64'),
      }),
      false,
    );
  return { app, socket, provider, connect, playback, response, audio };
}

describe('current phone policy and knowledge boundaries', () => {
  it.each(['revoked', 'revision', 'outage'] as const)(
    'stops both peers and clears queued playback after heartbeat %s',
    async (scenario) => {
      vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 10 });
      const api = fixtureApi();
      const originalPolicy = api.policy;
      let policyChecks = 0;
      api.policy = vi.fn<VoiceApiClient['policy']>(async (binding, signal) => {
        if (++policyChecks === 1) return originalPolicy(binding, signal);
        if (scenario === 'outage') throw new Error('Private service diagnostic');
        return {
          allowed: scenario !== 'revoked',
          configurationVersion: scenario === 'revision' ? 2 : 1,
          actionsEnabled: true,
          transfersEnabled: true,
        };
      });
      const f = await openTestStream(api);
      try {
        f.response();
        f.audio();
        await vi.waitFor(() =>
          expect(f.playback.some((event) => event.event === 'media')).toBe(true),
        );
        await vi.advanceTimersByTimeAsync(5000);
        await vi.waitFor(() => expect(f.provider.readyState).toBe(3));
        expect(f.playback.some((event) => event.event === 'clear')).toBe(true);
        expect(api.end).toHaveBeenCalledWith(
          expect.objectContaining({ providerCallSid: call, reason: 'stream_closed' }),
        );
        const providerEvents = f.provider.events.length;
        const checks = policyChecks;
        f.response('late-response');
        f.audio(800, 'late-response');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.provider.events).toHaveLength(providerEvents);
        expect(policyChecks).toBe(checks);
      } finally {
        vi.useRealTimers();
        await f.app.close();
      }
    },
  );

  it('does not open an AI provider when current policy is denied after grant redemption', async () => {
    const api = fixtureApi();
    api.policy = vi.fn<VoiceApiClient['policy']>(async () => ({
      allowed: false,
      configurationVersion: 1,
      actionsEnabled: false,
      transfersEnabled: false,
    }));
    const connect = vi.fn(() => new Peer());
    const app = await createVoiceGateway(config(), { api, connectProvider: connect });
    await app.ready();
    try {
      const admission = await app.inject(callback());
      const socket = await app.injectWS('/twilio/media', { headers: socketHeaders });
      const closed = once(socket, 'close');
      socket.send(connected);
      socket.send(JSON.stringify(start(grant(admission.body))));
      await closed;
      expect(connect).not.toHaveBeenCalled();
      expect(api.end).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'stream_closed', generation: expect.any(String) }),
      );
    } finally {
      await app.close();
    }
  });

  it.each(['allowed', 'denied', 'terminal', 'overflow', 'interrupted'] as const)(
    'buffers a new response until current policy resolves (%s)',
    async (scenario) => {
      let clock = Date.now();
      const api = fixtureApi();
      const originalPolicy = api.policy;
      let release: ((policy: Awaited<ReturnType<VoiceApiClient['policy']>>) => void) | undefined;
      let pendingSignal: AbortSignal | undefined;
      let checks = 0;
      api.policy = vi.fn<VoiceApiClient['policy']>(async (binding, signal) => {
        if (++checks === 1) return originalPolicy(binding, signal);
        pendingSignal = signal;
        return new Promise<Awaited<ReturnType<VoiceApiClient['policy']>>>((resolve) => {
          release = resolve;
        });
      });
      const f = await openTestStream(api, () => clock);
      try {
        clock += 1001;
        f.response();
        f.audio(scenario === 'overflow' ? 16_001 : 800);
        if (scenario === 'overflow') {
          await vi.waitFor(() => expect(f.provider.readyState).toBe(3));
          expect(f.playback.some((event) => event.event === 'media')).toBe(false);
          return;
        }
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        expect(f.playback.some((event) => event.event === 'media')).toBe(false);
        expect(api.policy).toHaveBeenCalledTimes(2);
        if (scenario === 'terminal') {
          await f.app.inject(
            callback('/twilio/status', { ...callbackParams(), CallStatus: 'completed' }),
          );
          expect(pendingSignal?.aborted).toBe(true);
        }
        if (scenario === 'interrupted') {
          f.provider.emit(
            'message',
            JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
            false,
          );
          expect(f.provider.events).toContainEqual({
            type: 'response.cancel',
            response_id: 'policy-response',
          });
        }
        release?.({
          allowed: scenario !== 'denied',
          configurationVersion: 1,
          actionsEnabled: true,
          transfersEnabled: true,
        });
        if (scenario === 'allowed')
          await vi.waitFor(() =>
            expect(f.playback.some((event) => event.event === 'media')).toBe(true),
          );
        else if (scenario === 'interrupted') {
          f.provider.emit(
            'message',
            JSON.stringify({
              type: 'response.done',
              response: { id: 'policy-response', status: 'cancelled' },
            }),
            false,
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          await vi.waitFor(() => expect(f.provider.readyState).toBe(1));
          expect(f.playback.some((event) => event.event === 'media')).toBe(false);
        } else {
          await vi.waitFor(() => expect(f.provider.readyState).toBe(3));
          expect(f.playback.some((event) => event.event === 'media')).toBe(false);
        }
        expect(api.policy).toHaveBeenCalledTimes(2);
      } finally {
        await f.app.close();
      }
    },
  );

  it('bounds an unresponsive policy check and aborts remaining work on close', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 10 });
    const api = fixtureApi();
    const originalPolicy = api.policy;
    let checks = 0;
    let pendingSignal: AbortSignal | undefined;
    api.policy = vi.fn<VoiceApiClient['policy']>(async (binding, signal) => {
      if (++checks === 1) return originalPolicy(binding, signal);
      pendingSignal = signal;
      return new Promise<Awaited<ReturnType<VoiceApiClient['policy']>>>(() => {});
    });
    const f = await openTestStream(api);
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(api.policy).toHaveBeenCalledTimes(2);
      expect(f.provider.readyState).toBe(1);
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => expect(f.provider.readyState).toBe(3));
      expect(pendingSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(api.policy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await f.app.close();
    }
  });

  it.each(['denied', 'outage', 'rejected_resume'] as const)(
    'preserves controlled dispatch and closes a denied resume after a late audio heartbeat (%s)',
    async (scenario) => {
      vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 10 });
      const cfg = loadVoiceConfig({ ...environment, VOICE_ACTIONS_ENABLED: 'true' });
      if (!cfg.enabled) throw new Error('disabled');
      const api = fixtureApi();
      const originalRedeem = api.redeem;
      api.redeem = vi.fn(async (input) => ({
        ...(await originalRedeem(input)),
        actionsEnabled: true,
      }));
      const originalPolicy = api.policy;
      let checks = 0;
      let finishPolicy: (() => void) | undefined;
      api.policy = vi.fn<VoiceApiClient['policy']>(async (binding, signal) => {
        if (++checks <= 2) return originalPolicy(binding, signal);
        if (checks > 3) throw new Error('Voice policy remains unavailable');
        await new Promise<void>((resolve) => {
          finishPolicy = resolve;
        });
        if (scenario !== 'denied') throw new Error('Private service diagnostic');
        return {
          allowed: false,
          configurationVersion: 1,
          actionsEnabled: false,
          transfersEnabled: false,
        };
      });
      const controlId = randomUUID();
      api.propose = vi.fn(async () => ({ controlId, twiml: '<Response/>' }));
      api.dispatch = vi.fn(async () => ({
        dispatch: true,
        twiml: '<Response><Say>Canonical controlled readback</Say></Response>',
        unavailable: false,
      }));
      if (scenario === 'rejected_resume')
        api.dispatched = vi.fn(async () => {
          // Let the old heartbeat's failure settle during the known-unsent
          // rejection transition, before its in-flight handle is cleared.
          await Promise.resolve();
          return { state: 'STREAMING' as const };
        });
      let finishDispatch: (() => void) | undefined;
      const controller: CallController = {
        dispatch: vi.fn<CallController['dispatch']>(async () => {
          await new Promise<void>((resolve) => {
            finishDispatch = resolve;
          });
          if (scenario === 'rejected_resume')
            return { outcome: 'rejected', code: 'PROVIDER_REJECTED' };
          return { outcome: 'accepted' };
        }),
      };
      let clock = Date.now();
      const f = await openTestStream(api, () => clock, cfg, controller);
      try {
        f.socket.send(
          JSON.stringify({
            event: 'media',
            sequenceNumber: '2',
            streamSid: stream,
            media: {
              track: 'inbound',
              timestamp: '0',
              chunk: '1',
              payload: Buffer.alloc(160).toString('base64'),
            },
          }),
        );
        await vi.waitFor(() =>
          expect(
            f.provider.events.some((event) => event.type === 'input_audio_buffer.append'),
          ).toBe(true),
        );
        for (const event of [
          { type: 'input_audio_buffer.speech_started', item_id: 'message1', audio_start_ms: 0 },
          { type: 'input_audio_buffer.speech_stopped', item_id: 'message1', audio_end_ms: 20 },
          { type: 'conversation.item.added', item: { id: 'message1', role: 'user' } },
        ])
          f.provider.emit('message', JSON.stringify(event), false);
        clock += 1001;
        f.response();
        await vi.waitFor(() => expect(api.policy).toHaveBeenCalledTimes(2));
        await vi.advanceTimersByTimeAsync(5000);
        await vi.waitFor(() => expect(finishPolicy).toBeTypeOf('function'));
        f.provider.emit(
          'message',
          JSON.stringify({
            type: 'response.function_call_arguments.done',
            response_id: 'policy-response',
            call_id: 'message-tool',
            name: 'prepare_message',
            arguments: JSON.stringify({
              name: 'Synthetic Guest',
              callbackNumber: '+12125550111',
              message: 'Please call about a private dinner.',
            }),
          }),
          false,
        );
        await vi.waitFor(() => expect(finishDispatch).toBeTypeOf('function'));
        finishPolicy?.();
        if (scenario !== 'rejected_resume') {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(f.provider.readyState).toBe(1);
          expect(api.end).not.toHaveBeenCalled();
          expect(controller.dispatch).toHaveBeenCalledOnce();
        }
        finishDispatch?.();
        await vi.waitFor(() => expect(f.provider.readyState).toBe(3));
        expect(api.dispatched).toHaveBeenCalledWith(
          expect.objectContaining({
            controlId,
            outcome: scenario === 'rejected_resume' ? 'rejected' : 'accepted',
          }),
        );
        expect(controller.dispatch).toHaveBeenCalledOnce();
        if (scenario === 'rejected_resume') {
          expect(api.policy).toHaveBeenCalledTimes(3);
          expect(api.end).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'stream_closed' }),
          );
          expect(JSON.stringify(f.provider.events)).not.toContain('The server could not begin');
        }
      } finally {
        finishPolicy?.();
        finishDispatch?.();
        vi.useRealTimers();
        await f.app.close();
      }
    },
  );
});

describe('voice admission and limits', () => {
  it('is disabled without secrets and refuses incomplete or production activation', async () => {
    expect(loadVoiceConfig({})).toEqual({ enabled: false, port: 3002, host: '127.0.0.1' });
    expect(loadVoiceConfig({ VOICE_HOST: '0.0.0.0' })).toMatchObject({
      enabled: false,
      host: '0.0.0.0',
    });
    expect(() => loadVoiceConfig({ VOICE_HOST: 'untrusted.example' })).toThrow('VOICE_HOST');
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
    const app = await createVoiceGateway(config(), { api: fixtureApi() });
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

    const app = await createVoiceGateway(config(), { api: fixtureApi() });
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
    const api = fixtureApi();
    const connect = vi.fn(() => new Peer());
    const app = await createVoiceGateway(config(), { api, connectProvider: connect });
    await app.ready();
    try {
      await expect(app.injectWS('/twilio/media')).rejects.toThrow();
      const response = await app.inject(callback());
      const socket = await app.injectWS('/twilio/media', { headers: socketHeaders });
      const closed = once(socket, 'close');
      socket.send(connected);
      socket.send(JSON.stringify(start(grant(response.body), `CA${'e'.repeat(32)}`)));
      await closed;
      expect(api.redeem).toHaveBeenCalledOnce();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('opens a provider only after verified start and closes both peers on stream mismatch', async () => {
    const provider = new Peer();
    const connect = vi.fn(() => provider);
    const app = await createVoiceGateway(config(), {
      api: fixtureApi(),
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

  it('does not open a provider when terminal status arrives during a delayed redemption response', async () => {
    const api = fixtureApi();
    const baseRedeem = api.redeem;
    let release: (() => void) | undefined;
    api.redeem = vi.fn(async (input) => {
      const context = await baseRedeem(input);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return context;
    });
    const connect = vi.fn(() => new Peer());
    const app = await createVoiceGateway(config(), { api, connectProvider: connect });
    await app.ready();
    try {
      const admission = await app.inject(callback());
      const socket = await app.injectWS('/twilio/media', { headers: socketHeaders });
      const closed = once(socket, 'close');
      socket.send(connected);
      socket.send(JSON.stringify(start(grant(admission.body))));
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      expect(
        (
          await app.inject(
            callback('/twilio/status', { ...callbackParams(), CallStatus: 'completed' }),
          )
        ).statusCode,
      ).toBe(204);
      await closed;
      release?.();
      await vi.waitFor(() =>
        expect(api.end).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'stream_closed', generation: expect.any(String) }),
        ),
      );
      expect(connect).not.toHaveBeenCalled();
    } finally {
      release?.();
      await app.close();
    }
  });

  it('authenticates call-bound confirmation and child-leg callbacks on their exact configured paths', async () => {
    const api = fixtureApi();
    api.confirmation = vi.fn(async () => ({
      tenantId: restaurant.id,
      twiml: '<Response><Say>Request saved for staff review.</Say></Response>',
      outcome: 'Request saved',
    }));
    api.transferResult = vi.fn(async () => ({
      tenantId: restaurant.id,
      twiml: '<Response><Hangup/></Response>',
      outcome: 'Staff call completed',
    }));
    const app = await createVoiceGateway(config(), { api });
    const token = 'd'.repeat(64);
    try {
      const confirmPath = `/twilio/confirmation/${token}`;
      const confirmation = callback(confirmPath, {
        ...callbackParams(),
        SpeechResult: 'yes',
        Confidence: '0.96',
      });
      expect((await app.inject(confirmation)).statusCode).toBe(200);
      expect(api.confirmation).toHaveBeenCalledWith({
        providerCallSid: call,
        confirmationToken: token,
        speechResult: 'yes',
        confidence: 0.96,
      });
      expect(
        (await app.inject({ ...confirmation, url: `${confirmPath}?unsafe=1` })).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject(
            callback(confirmPath, { ...callbackParams(), Confidence: 'not-a-number' }),
          )
        ).statusCode,
      ).toBe(400);
      const childSid = `CA${'e'.repeat(32)}`;
      const childParams = {
        AccountSid: account,
        CallSid: childSid,
        ParentCallSid: call,
        To: restaurant.transferNumber,
        Direction: 'outbound-dial',
        CallStatus: 'answered',
      };
      expect(
        (await app.inject(callback(`/twilio/transfer-status/${token}`, childParams))).statusCode,
      ).toBe(204);
      expect(api.transferStatus).toHaveBeenCalledWith({
        transferToken: token,
        childCallSid: childSid,
        parentCallSid: call,
        status: 'answered',
      });
      expect(
        (
          await app.inject(
            callback(`/twilio/transfer-status/${token}`, {
              ...childParams,
              AccountSid: `AC${'f'.repeat(32)}`,
            }),
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject(
            callback(`/twilio/transfer-result/${token}`, {
              ...callbackParams(),
              DialCallSid: childSid,
              DialCallStatus: 'completed',
              DialBridged: 'true',
            }),
          )
        ).statusCode,
      ).toBe(200);
      expect(api.transferResult).toHaveBeenCalledWith({
        providerCallSid: call,
        transferToken: token,
        dialCallSid: childSid,
        dialCallStatus: 'completed',
        bridged: true,
      });
    } finally {
      await app.close();
    }
  });

  it.each(['unknown', 'expired'] as const)(
    'dispatches controlled readback once or fences an overdue dispatch (%s)',
    async (scenario) => {
      let clock = Date.now();
      const cfg = loadVoiceConfig({ ...environment, VOICE_ACTIONS_ENABLED: 'true' });
      if (!cfg.enabled) throw new Error('disabled');
      const api = fixtureApi();
      const baseRedeem = api.redeem;
      api.redeem = vi.fn(async (input) => ({ ...(await baseRedeem(input)), actionsEnabled: true }));
      const controlId = randomUUID();
      api.propose = vi.fn(async () => ({
        controlId,
        twiml: '<Response><Say>Canonical readback</Say></Response>',
      }));
      api.dispatch = vi.fn(async () => {
        if (scenario === 'expired') clock += 301_000;
        return {
          dispatch: true,
          unavailable: false,
          twiml: '<Response><Say>Canonical readback</Say></Response>',
        };
      });
      api.dispatched = vi.fn(async () => ({ state: 'NEEDS_RECONCILIATION' as const }));
      const controller = {
        dispatch: vi.fn(async (_callSid: string, _twiml: string, _signal?: AbortSignal) => ({
          outcome: 'unknown' as const,
        })),
      };
      const provider = new Peer();
      const app = await createVoiceGateway(cfg, {
        now: () => clock,
        api,
        controller,
        connectProvider: () => provider,
      });
      await app.ready();
      try {
        const admission = await app.inject(callback());
        const socket = await app.injectWS('/twilio/media', { headers: socketHeaders });
        const closed = once(socket, 'close');
        socket.send(connected);
        socket.send(JSON.stringify(start(grant(admission.body))));
        await vi.waitFor(() => expect(api.redeem).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(provider.listenerCount('open')).toBe(1));
        provider.emit('open');
        provider.emit('message', JSON.stringify({ type: 'session.updated' }), false);
        socket.send(
          JSON.stringify({
            event: 'media',
            sequenceNumber: '2',
            streamSid: stream,
            media: {
              timestamp: '0',
              chunk: '1',
              track: 'inbound',
              payload: Buffer.alloc(160).toString('base64'),
            },
          }),
        );
        await vi.waitFor(() =>
          expect(provider.events.some((value) => value.type === 'input_audio_buffer.append')).toBe(
            true,
          ),
        );
        for (const event of [
          { type: 'input_audio_buffer.speech_started', item_id: 'caller1', audio_start_ms: 0 },
          { type: 'input_audio_buffer.speech_stopped', item_id: 'caller1', audio_end_ms: 20 },
          { type: 'conversation.item.added', item: { id: 'caller1', role: 'user' } },
          { type: 'response.created', response: { id: 'tool-response' } },
          {
            type: 'response.function_call_arguments.done',
            response_id: 'tool-response',
            call_id: 'request-tool',
            name: 'prepare_message',
            arguments: JSON.stringify({
              name: 'Synthetic Guest',
              callbackNumber: '+12125550111',
              message: 'Please call about a private dinner.',
            }),
          },
        ])
          provider.emit('message', JSON.stringify(event), false);
        await closed;
        expect(api.propose).toHaveBeenCalledOnce();
        expect(api.dispatch).toHaveBeenCalledOnce();
        if (scenario === 'unknown') expect(controller.dispatch).toHaveBeenCalledOnce();
        else expect(controller.dispatch).not.toHaveBeenCalled();
        expect(api.dispatched).toHaveBeenCalledWith(
          expect.objectContaining({
            providerCallSid: call,
            controlId,
            outcome: scenario === 'expired' ? 'rejected' : 'unknown',
          }),
        );
        expect(api.end).toHaveBeenCalledWith(
          expect.objectContaining({
            providerCallSid: call,
            generation: expect.any(String),
            reason: 'stream_closed',
          }),
        );
        if (scenario === 'unknown') {
          expect(controller.dispatch.mock.calls[0]?.[0]).toBe(call);
          expect(controller.dispatch.mock.calls[0]?.[1]).toContain('Canonical readback');
          expect(controller.dispatch.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
        }
      } finally {
        await app.close();
      }
    },
  );

  it('enforces the provisional socket cap across simultaneous verified upgrades', async () => {
    const app = await createVoiceGateway(config(), { api: fixtureApi() });
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
