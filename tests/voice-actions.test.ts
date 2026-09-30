import { describe, expect, it, vi } from 'vitest';
import {
  AudioRelay,
  type AudioPeer,
  type VoiceToolRequest,
} from '../apps/voice-gateway/src/relay.js';
import { createVoiceApiClient } from '../apps/voice-gateway/src/client.js';
import { loadVoiceConfig, type EnabledVoiceConfig } from '../apps/voice-gateway/src/config.js';

const environment = {
  LIVE_VOICE_ENABLED: 'true',
  VOICE_MODE: 'sandbox',
  VOICE_ACTIONS_ENABLED: 'true',
  VOICE_TRANSFERS_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'synthetic-test-auth-token',
  TWILIO_PHONE_NUMBER: '+12125550142',
  OPENAI_API_KEY: 'synthetic-test-openai-key',
  VOICE_PUBLIC_URL: 'https://voice.example.test',
  VOICE_SERVICE_TOKEN: 'synthetic-internal-service-token-32-characters',
  VOICE_TENANT_ID: '11111111-1111-4111-8111-111111111111',
};
function config(): EnabledVoiceConfig {
  const value = loadVoiceConfig(environment);
  if (!value.enabled) throw new Error('disabled');
  return value;
}
class Peer implements AudioPeer {
  readyState = 1;
  bufferedAmount = 0;
  events: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.events.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}
function fixture(
  onTool: (request: VoiceToolRequest) => Promise<'controlled' | 'unavailable'> = async () =>
    'controlled',
) {
  const telephone = new Peer();
  const provider = new Peer();
  const close = vi.fn();
  let now = Date.parse('2026-10-01T03:59:59.500Z');
  const relay = new AudioRelay(telephone, provider, `MZ${'c'.repeat(32)}`, close, {
    actionsEnabled: true,
    transfersEnabled: true,
    now: () => now,
    onTool,
  });
  relay.configure('Approved test knowledge only');
  const event = (value: object) => relay.providerEvent(JSON.stringify(value));
  event({ type: 'session.updated' });
  const input = () => relay.input(Buffer.alloc(3200).toString('base64'), now);
  const utterance = (id: string, audioStart: number, audioEnd: number) => {
    event({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: audioStart });
    event({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: audioEnd });
    event({ type: 'conversation.item.added', item: { id, role: 'user' } });
    const metadata = provider.events
      .filter((value) => value.type === 'conversation.item.create')
      .at(-1);
    const encoded = JSON.stringify(metadata);
    const handle = encoded.match(/utterance: ([a-f0-9-]{36})/)?.[1];
    if (!handle) throw new Error('Missing server utterance handle');
    return handle;
  };
  const tool = (name: string, args: object, callId = 'tool1') => {
    event({ type: 'response.created', response: { id: 'response1' } });
    event({
      type: 'response.function_call_arguments.done',
      response_id: 'response1',
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    });
  };
  return {
    relay,
    telephone,
    provider,
    close,
    event,
    input,
    utterance,
    tool,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
const reservation = {
  dateExpression: 'tomorrow',
  time: '19:00',
  partySize: 4,
  name: 'Synthetic Guest',
  callbackNumber: '+12125550111',
  notes: '',
};

describe('voice proposal boundaries and trusted date references', () => {
  it('exposes preparation and configured transfer tools, never confirmation or booking tools', () => {
    const f = fixture();
    const session = f.provider.events[0];
    const serialized = JSON.stringify(session);
    expect(serialized).toContain('prepare_request');
    expect(serialized).toContain('prepare_message');
    expect(serialized).toContain('request_staff_transfer');
    expect(serialized).not.toContain('save_request');
    expect(serialized).not.toContain('confirm_request');
    expect(serialized).not.toContain('make_reservation');
    expect(serialized).toContain('"create_response":false');
    f.relay.close();
  });

  it('preserves the date utterance across midnight while later fields are collected', async () => {
    const onTool = vi.fn(async (_request: VoiceToolRequest) => 'controlled' as const);
    const f = fixture(onTool);
    f.input();
    const dateHandle = f.utterance('date-utterance', 0, 300);
    f.advance(2000);
    for (let i = 0; i < 4; i += 1) f.input();
    f.utterance('contact-utterance', 1500, 1900);
    f.tool('prepare_request', { ...reservation, date_utterance_id: dateHandle });
    await vi.waitFor(() => expect(onTool).toHaveBeenCalledOnce());
    expect(onTool.mock.calls[0]?.[0]).toMatchObject({
      kind: 'proposal',
      utteranceStartedAt: '2026-10-01T03:59:59.500Z',
      proposal: { kind: 'reservation', reservation },
    });
    expect(JSON.stringify(onTool.mock.calls[0]?.[0])).not.toContain('date_utterance_id');
    f.relay.close();
  });

  it('rejects unknown handles, arbitrary timestamps, tenant fields and model confirmation tools', () => {
    for (const args of [
      { ...reservation, date_utterance_id: '22222222-2222-4222-8222-222222222222' },
      {
        ...reservation,
        date_utterance_id: '22222222-2222-4222-8222-222222222222',
        utteranceStartedAt: '2026-10-01T00:00:00Z',
      },
      {
        ...reservation,
        date_utterance_id: '22222222-2222-4222-8222-222222222222',
        tenantId: environment.VOICE_TENANT_ID,
      },
    ]) {
      const onTool = vi.fn(async () => 'controlled' as const);
      const f = fixture(onTool);
      f.input();
      f.utterance('u1', 0, 300);
      f.tool('prepare_request', args);
      expect(onTool).not.toHaveBeenCalled();
      f.relay.close();
    }
    const onTool = vi.fn(async () => 'controlled' as const);
    const f = fixture(onTool);
    f.input();
    f.utterance('u1', 0, 300);
    f.tool('confirm_request', {});
    expect(onTool).not.toHaveBeenCalled();
    f.relay.close();
  });

  it('admits one metadata response for duplicate GA and legacy item acknowledgements', () => {
    const f = fixture();
    f.input();
    f.utterance('u1', 0, 300);
    const before = f.provider.events.length;
    f.event({ type: 'conversation.item.created', item: { id: 'u1', role: 'user' } });
    f.event({ type: 'conversation.item.added', item: { id: 'u1', role: 'user' } });
    expect(f.provider.events).toHaveLength(before);
    f.relay.close();
  });

  it('freezes competing speech and duplicate tools while control is pending, then resumes after safe rejection', async () => {
    let release: ((result: 'controlled' | 'unavailable') => void) | undefined;
    const onTool = vi.fn(
      () =>
        new Promise<'controlled' | 'unavailable'>((resolve) => {
          release = resolve;
        }),
    );
    const f = fixture(onTool);
    f.input();
    const handle = f.utterance('u1', 0, 300);
    f.tool('prepare_request', { ...reservation, date_utterance_id: handle });
    const before = f.provider.events.length;
    f.input();
    f.event({ type: 'input_audio_buffer.speech_started', item_id: 'u2', audio_start_ms: 300 });
    f.event({
      type: 'response.function_call_arguments.done',
      response_id: 'response1',
      call_id: 'tool1',
      name: 'prepare_request',
      arguments: JSON.stringify({ ...reservation, date_utterance_id: handle }),
    });
    expect(onTool).toHaveBeenCalledOnce();
    expect(f.provider.events).toHaveLength(before);
    release?.('unavailable');
    await vi.waitFor(() =>
      expect(f.provider.events.at(-1)).toMatchObject({ type: 'conversation.item.create' }),
    );
    expect(f.provider.events.filter((event) => event.type === 'response.create')).toHaveLength(2);
    f.event({ type: 'response.done', response: { id: 'response1', status: 'cancelled' } });
    await vi.waitFor(() =>
      expect(f.provider.events.at(-1)).toMatchObject({ type: 'response.create' }),
    );
    expect(JSON.stringify(f.provider.events)).toContain('No request has been saved');
    f.relay.close();
  });

  it('retains cancellation acknowledgement arriving before a safe handoff rejection', async () => {
    let release: ((result: 'controlled' | 'unavailable') => void) | undefined;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.input();
    const handle = f.utterance('u1', 0, 300);
    f.tool('prepare_request', { ...reservation, date_utterance_id: handle });
    f.event({ type: 'response.done', response: { id: 'response1', status: 'cancelled' } });
    const before = f.provider.events.filter((event) => event.type === 'response.create').length;
    release?.('unavailable');
    await vi.waitFor(() =>
      expect(f.provider.events.filter((event) => event.type === 'response.create')).toHaveLength(
        before + 1,
      ),
    );
    expect(f.close).not.toHaveBeenCalled();
    f.relay.close();
  });

  it('waits for the original function response completion before invalid-argument clarification', () => {
    const onTool = vi.fn(async () => 'controlled' as const);
    const f = fixture(onTool);
    f.input();
    f.utterance('u1', 0, 300);
    const before = f.provider.events.filter((event) => event.type === 'response.create').length;
    f.tool('prepare_request', {
      ...reservation,
      date_utterance_id: '22222222-2222-4222-8222-222222222222',
    });
    expect(f.provider.events.filter((event) => event.type === 'response.create')).toHaveLength(
      before,
    );
    f.event({ type: 'response.done', response: { id: 'response1', status: 'completed' } });
    expect(f.provider.events.filter((event) => event.type === 'response.create')).toHaveLength(
      before + 1,
    );
    expect(onTool).not.toHaveBeenCalled();
    f.relay.close();
  });

  it('rejects VAD timestamps beyond authenticated input before creating tool authority', () => {
    const f = fixture();
    f.input();
    f.event({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 5000 });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.each([
    { args: {}, context: { reason: 'requested_staff', summary: '' } },
    {
      args: { reason: 'allergy_question', summary: 'Caller asks about cross-contamination.' },
      context: { reason: 'allergy_question', summary: 'Caller asks about cross-contamination.' },
    },
  ])(
    'passes bounded staff context only to deterministic call control ($context.reason)',
    async ({ args, context }) => {
      const onTool = vi.fn(async (_request: VoiceToolRequest) => 'controlled' as const);
      const f = fixture(onTool);
      f.input();
      f.utterance('staff-request', 0, 300);
      f.tool('request_staff_transfer', args);
      await vi.waitFor(() => expect(onTool).toHaveBeenCalledOnce());
      expect(onTool.mock.calls[0]?.[0]).toMatchObject({ kind: 'transfer', context });
      expect(JSON.stringify(f.provider.events)).not.toContain(context.summary || 'no-such-context');
      f.relay.close();
    },
  );

  it.each([
    { reason: 'unsupported' },
    { summary: 'x'.repeat(301) },
    { destination: '+12125550100' },
    { tenantId: environment.VOICE_TENANT_ID },
  ])('rejects invalid or authority-expanding transfer context ($reason)', (args) => {
    const onTool = vi.fn(async (_request: VoiceToolRequest) => 'controlled' as const);
    const f = fixture(onTool);
    f.input();
    f.utterance('staff-request', 0, 300);
    f.tool('request_staff_transfer', args);
    expect(onTool).not.toHaveBeenCalled();
    f.relay.close();
  });
});

describe('bounded scoped internal voice client', () => {
  it('posts the scoped service credential with redirects forbidden and validates durable admission', async () => {
    const cfg = config();
    const transport = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(
          JSON.stringify({
            voiceCallId: cfg.tenantId,
            generation: cfg.tenantId,
            tenantId: cfg.tenantId,
            state: 'WAITING_FOR_STREAM',
            twiml: '<Response/>',
          }),
        ),
    );
    const api = createVoiceApiClient(cfg, transport);
    await api.admit({ providerCallSid: `CA${'b'.repeat(32)}`, accountSid: cfg.accountSid });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${cfg.serviceToken}` },
    });
  });
  it('rejects cross-tenant, malformed and oversized internal responses without provider error disclosure', async () => {
    for (const body of [
      JSON.stringify({
        voiceCallId: environment.VOICE_TENANT_ID,
        generation: environment.VOICE_TENANT_ID,
        tenantId: '22222222-2222-4222-8222-222222222222',
        state: 'WAITING_FOR_STREAM',
        twiml: '<Response/>',
      }),
      JSON.stringify({ state: 'STREAMING', sensitiveProviderError: 'hidden' }),
      'x'.repeat(128 * 1024 + 1),
    ]) {
      const api = createVoiceApiClient(config(), async () => new Response(body));
      await expect(
        api.admit({
          providerCallSid: `CA${'b'.repeat(32)}`,
          accountSid: environment.TWILIO_ACCOUNT_SID,
        }),
      ).rejects.toThrow();
    }
  });
  it('requires exact boolean strings for each activation flag even while voice is disabled', () => {
    expect(() => loadVoiceConfig({ VOICE_ACTIONS_ENABLED: 'yes' })).toThrow(
      'Invalid voice activation',
    );
    expect(() => loadVoiceConfig({ VOICE_TRANSFERS_ENABLED: '1' })).toThrow(
      'Invalid voice activation',
    );
    expect(loadVoiceConfig({})).toEqual({ enabled: false, port: 3002 });
  });

  it('validates current-policy responses and carries call cancellation through the client', async () => {
    const cfg = config();
    const cancellation = new AbortController();
    const transport = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(
          JSON.stringify({
            allowed: true,
            configurationVersion: 3,
            actionsEnabled: false,
            transfersEnabled: true,
          }),
        ),
    );
    const api = createVoiceApiClient(cfg, transport);
    await expect(
      api.policy(
        { providerCallSid: `CA${'b'.repeat(32)}`, generation: cfg.tenantId },
        cancellation.signal,
      ),
    ).resolves.toMatchObject({ configurationVersion: 3, actionsEnabled: false });
    const signal = transport.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    cancellation.abort();
    expect(signal?.aborted).toBe(true);
    for (const invalid of [
      { allowed: true, configurationVersion: 0, actionsEnabled: true, transfersEnabled: true },
      { allowed: true, configurationVersion: 1, actionsEnabled: 'true', transfersEnabled: true },
      {
        allowed: true,
        configurationVersion: 1,
        actionsEnabled: true,
        transfersEnabled: true,
        tenantId: '22222222-2222-4222-8222-222222222222',
      },
    ]) {
      const invalidClient = createVoiceApiClient(
        cfg,
        async () => new Response(JSON.stringify(invalid)),
      );
      await expect(
        invalidClient.policy({ providerCallSid: `CA${'b'.repeat(32)}`, generation: cfg.tenantId }),
      ).rejects.toThrow();
    }
  });
});
