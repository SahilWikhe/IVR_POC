import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveAudioRelay,
  type LiveDelegationInput,
  type LiveDelegationResult,
  type LiveRelayOptions,
} from '../apps/voice-gateway/src/live-relay.js';
import type {
  AudioPeer,
  RelayDiagnosticCode,
  VoiceToolRequest,
} from '../apps/voice-gateway/src/relay.js';

class Peer implements AudioPeer {
  readyState = 1;
  bufferedAmount = 0;
  events: Array<Record<string, unknown>> = [];
  closes = 0;
  send(value: string) {
    this.events.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
    this.closes += 1;
  }
}
const streamSid = `MZ${'c'.repeat(32)}`;
const initialTime = Date.parse('2026-10-02T03:59:59.700Z');
const reservation = {
  dateExpression: 'tomorrow',
  time: '19:00',
  partySize: 4,
  name: 'Synthetic Guest',
  callbackNumber: '+12125550111',
  notes: '',
};
function fixture(options: Partial<LiveRelayOptions> = {}, start = true) {
  const telephone = new Peer(),
    provider = new Peer();
  const closed = vi.fn();
  const diagnostic = vi.fn<(code: RelayDiagnosticCode) => void>();
  const onDelegate = vi.fn<LiveRelayOptions['onDelegate']>(async () => ({
    kind: 'reply',
    text: 'Please provide the requested date.',
  }));
  const onTool = vi.fn<NonNullable<LiveRelayOptions['onTool']>>(async () => 'controlled');
  let now = initialTime;
  const relay = new LiveAudioRelay(telephone, provider, streamSid, closed, {
    opening: 'Greet the caller now in English, then pause and listen.',
    onDelegate,
    onTool,
    now: () => now,
    onDiagnostic: diagnostic,
    ...options,
  });
  const event = (value: object) => relay.providerEvent(JSON.stringify(value));
  relay.configure('Approved restaurant facts; proposals require server-controlled readback.');
  if (start) event({ type: 'session.started' });
  const input = (bytes = 3200, at = now) =>
    relay.input(Buffer.alloc(bytes, 0xff).toString('base64'), at);
  const audio = (bytes = 800) =>
    event({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(bytes, 0xff).toString('base64'),
    });
  const transcript = (
    id: string,
    text: string,
    startMs = 0,
    endMs = 100,
    role: 'user' | 'assistant' = 'user',
  ) =>
    event({
      type: `session.${role === 'user' ? 'input' : 'output'}_transcript.delta`,
      event_id: id,
      delta: text,
      start_ms: startMs,
      end_ms: endMs,
    });
  const delegate = (id = 'delegation1') =>
    event({
      type: 'session.delegation.created',
      offset_ms: 100,
      delegation: { id, type: 'delegation', target: 'client' },
    });
  const dispose = () => {
    relay.close();
    event({ type: 'session.closed' });
  };
  return {
    telephone,
    provider,
    relay,
    closed,
    diagnostic,
    onDelegate,
    onTool,
    event,
    input,
    audio,
    transcript,
    delegate,
    dispose,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('Live continuous audio protocol', () => {
  it('starts client delegation without storage, preserves PCMU silence and appends one greeting', () => {
    const f = fixture({}, false);
    f.input(160);
    expect(f.provider.events).toEqual([
      {
        type: 'session.start',
        event_id: expect.any(String),
        session: {
          model: 'gpt-live-1',
          store: false,
          instructions: 'Approved restaurant facts; proposals require server-controlled readback.',
          audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
          delegation: { type: 'client' },
        },
      },
    ]);
    f.event({ type: 'session.started' });
    f.event({ type: 'session.started' });
    expect(
      f.provider.events.filter((event) => event.type === 'session.instructions.append'),
    ).toEqual([
      {
        type: 'session.instructions.append',
        event_id: expect.any(String),
        delegation_id: null,
        content: 'Greet the caller now in English, then pause and listen.',
      },
    ]);
    expect(f.provider.events).toContainEqual({
      type: 'session.input_audio.append',
      audio: Buffer.alloc(160, 0xff).toString('base64'),
    });
    f.audio(1600);
    expect(f.telephone.events.filter((event) => event.event === 'media')).toEqual(
      Array.from({ length: 2 }, () => ({
        event: 'media',
        streamSid,
        media: { payload: Buffer.alloc(800, 0xff).toString('base64') },
      })),
    );
    expect(
      f.provider.events.some((event) =>
        [
          'response.create',
          'response.cancel',
          'conversation.item.truncate',
          'input_audio_buffer.commit',
        ].includes(String(event.type)),
      ),
    ).toBe(false);
    f.dispose();
  });

  it('bounds playback at two seconds and releases only acknowledged marks', () => {
    const f = fixture();
    f.audio(16_000);
    expect(f.closed).not.toHaveBeenCalled();
    f.relay.played('p1');
    f.audio(800);
    f.relay.played('unknown-mark');
    f.audio(1);
    expect(f.closed).toHaveBeenCalledOnce();
    expect(f.diagnostic.mock.calls).toEqual([['relay_buffer_limit']]);
    expect(f.telephone.events.at(-1)).toEqual({ event: 'clear', streamSid });
    f.dispose();
  });

  it('does not confuse transcript arrival with an authoritative interruption signal', () => {
    const f = fixture();
    f.input();
    f.audio();
    f.transcript('user1', 'Actually,');
    expect(f.telephone.events.some((event) => event.event === 'clear')).toBe(false);
    expect(f.provider.events.some((event) => event.type === 'response.cancel')).toBe(false);
    f.dispose();
  });

  it.each(['malformed_audio', 'pending_input', 'backpressure', 'invalid_json'] as const)(
    'fails closed on %s with static diagnostics',
    (cause) => {
      const f = fixture({}, cause !== 'pending_input');
      if (cause === 'malformed_audio') f.relay.input('not base64!');
      if (cause === 'pending_input') for (let index = 0; index < 6; index += 1) f.input();
      if (cause === 'backpressure') {
        f.provider.bufferedAmount = 300_000;
        f.input();
      }
      if (cause === 'invalid_json') f.relay.providerEvent('{invalid');
      expect(f.closed).toHaveBeenCalledOnce();
      expect(f.diagnostic).toHaveBeenCalledOnce();
      expect(f.telephone.readyState).toBe(3);
      f.dispose();
    },
  );

  it.each(['terminal', 'timeout'] as const)(
    'closes local control immediately and bounds provider finalization (%s)',
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      f.audio();
      f.event({
        type: 'error',
        error: { message: `Private audio details ${streamSid} +12125550199` },
      });
      expect(f.closed).toHaveBeenCalledOnce();
      expect(f.telephone.readyState).toBe(3);
      expect(f.provider.readyState).toBe(1);
      expect(f.provider.events.at(-1)).toMatchObject({ type: 'session.close' });
      const before = f.telephone.events.length;
      f.audio();
      f.transcript('late', 'Late data');
      f.delegate();
      expect(f.telephone.events).toHaveLength(before);
      if (reason === 'terminal')
        f.event({ type: 'session.closed', usage: { privateField: 'never logged' } });
      else await vi.advanceTimersByTimeAsync(1500);
      expect(f.provider.readyState).toBe(3);
      expect(f.provider.closes).toBe(1);
      f.event({ type: 'session.closed' });
      expect(f.provider.closes).toBe(1);
      expect(f.diagnostic.mock.calls).toEqual([['provider_error']]);
      expect(f.closed).toHaveBeenCalledOnce();
    },
  );
});

describe('Live delegated action boundaries', () => {
  it('retains early delegation, exact late fragments and stable server date references across calls', async () => {
    vi.useFakeTimers();
    const f = fixture({}, false);
    f.input();
    f.advance(500);
    f.event({ type: 'session.started' });
    f.delegate();
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    expect(f.onDelegate).not.toHaveBeenCalled();
    f.transcript('later', 'A table', 200, 300);
    f.transcript('earlier', ' tomorrow', 0, 100);
    f.transcript('assistant1', 'Sure.', 100, 150, 'assistant');
    f.transcript('earlier', ' tomorrow', 0, 100); // Replayed event is not another caller revision.
    await vi.advanceTimersByTimeAsync(700);
    expect(f.onDelegate).toHaveBeenCalledOnce();
    const snapshot = f.onDelegate.mock.calls[0]?.[0].transcript;
    expect(snapshot?.map((entry) => entry.text)).toEqual(['A table', ' tomorrow', 'Sure.']);
    expect(snapshot?.[0]).toMatchObject({
      role: 'user',
      dateReference: expect.any(String),
      startedAt: new Date(initialTime + 200).toISOString(),
    });
    expect(snapshot?.[2]).toEqual({ role: 'assistant', text: 'Sure.' });
    expect(snapshot?.[1]?.startedAt).toBe(new Date(initialTime).toISOString());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.[0])).toBe(true);
    f.delegate('delegation2');
    await vi.advanceTimersByTimeAsync(700);
    expect(f.onDelegate.mock.calls[1]?.[0].transcript).toEqual(snapshot);
    expect(
      f.provider.events
        .filter((event) => event.type === 'session.commentary.append')
        .map((event) => event.delegation_id),
    ).toEqual(['delegation1', 'delegation2']);
    f.dispose();
  });

  it.each([
    { start: -1, end: 100 },
    { start: 200, end: 100 },
    { start: 1401, end: 1440 },
    { start: 0, end: 1401 },
  ])('rejects unsupported transcript time ranges %j', ({ start, end }) => {
    const f = fixture();
    f.input();
    f.transcript('bad', 'tomorrow', start, end);
    expect(f.closed).toHaveBeenCalledOnce();
    expect(f.onTool).not.toHaveBeenCalled();
    f.dispose();
  });

  it('discards a stale tool, aborts its backend, and reruns against the corrected caller context', async () => {
    vi.useFakeTimers();
    const calls: Array<{
      input: LiveDelegationInput;
      resolve(result: LiveDelegationResult): void;
    }> = [];
    const f = fixture({
      actionsEnabled: true,
      onDelegate: (input) => new Promise((resolve) => calls.push({ input, resolve })),
    });
    f.input();
    f.transcript('u1', 'Tomorrow');
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    const first = calls[0];
    expect(first).toBeDefined();
    f.transcript('u2', 'Actually, Friday', 100, 200);
    expect(first?.input.signal.aborted).toBe(true);
    first?.resolve({
      kind: 'tool',
      name: 'prepare_request',
      callId: 'stale-tool',
      arguments: JSON.stringify({
        ...reservation,
        date_utterance_id: first.input.transcript[0]?.dateReference,
      }),
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(f.onTool).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input.transcript.map((entry) => entry.text)).toEqual([
      'Tomorrow',
      'Actually, Friday',
    ]);
    calls[1]?.resolve({ kind: 'reply', text: 'What time on Friday?' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.events.filter((event) => event.type === 'session.commentary.append')).toEqual(
      [expect.objectContaining({ delegation_id: 'delegation1', content: 'What time on Friday?' })],
    );
    f.dispose();
  });

  it('uses the date-bearing fragment before midnight and freezes speech during canonical control', async () => {
    vi.useFakeTimers();
    let release: ((value: 'controlled' | 'unavailable') => void) | undefined;
    const onTool = vi.fn<(request: VoiceToolRequest) => Promise<'controlled' | 'unavailable'>>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const f = fixture({
      actionsEnabled: true,
      onTool,
      onDelegate: async ({ transcript }) => ({
        kind: 'tool',
        name: 'prepare_request',
        callId: 'tool1',
        arguments: JSON.stringify({
          ...reservation,
          date_utterance_id: transcript[0]?.dateReference,
        }),
      }),
    });
    f.input();
    f.transcript('date', 'Tomorrow', 0, 100);
    f.advance(1000);
    f.input();
    f.transcript('name', 'Synthetic Guest', 600, 700);
    f.audio();
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    expect(onTool).toHaveBeenCalledWith({
      toolCallId: 'tool1',
      utteranceStartedAt: new Date(initialTime).toISOString(),
      kind: 'proposal',
      proposal: { kind: 'reservation', reservation },
    });
    expect(f.telephone.events.at(-1)).toEqual({ event: 'clear', streamSid });
    const beforeAudio = f.telephone.events.length,
      beforeInput = f.provider.events.length;
    f.audio();
    f.input();
    f.transcript('controlled', 'Caller speech during deterministic control', 700, 750);
    expect(f.telephone.events).toHaveLength(beforeAudio);
    expect(f.provider.events).toHaveLength(beforeInput);
    release?.('unavailable');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.events.at(-1)).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: 'delegation1',
    });
    f.relay.played('p1'); // Late clear acknowledgment does not credit newer output.
    f.audio(16_000);
    f.relay.played('p1');
    f.audio(1);
    expect(f.closed).toHaveBeenCalledOnce();
    f.dispose();
  });

  it.each([
    'disabled',
    'forged_reference',
    'extra_timestamp',
    'confirm_tool',
    'arbitrary_transfer',
  ] as const)('rejects unauthorized or malformed tool authority (%s)', async (kind) => {
    vi.useFakeTimers();
    const f = fixture({
      actionsEnabled: kind !== 'disabled',
      transfersEnabled: kind === 'arbitrary_transfer',
      onDelegate: async ({ transcript }) => ({
        kind: 'tool',
        callId: 'tool1',
        name:
          kind === 'confirm_tool'
            ? 'confirm_request'
            : kind === 'arbitrary_transfer'
              ? 'request_staff_transfer'
              : 'prepare_request',
        arguments: JSON.stringify(
          kind === 'arbitrary_transfer'
            ? { destination: '+12125550199' }
            : {
                ...reservation,
                date_utterance_id:
                  kind === 'forged_reference'
                    ? '22222222-2222-4222-8222-222222222222'
                    : transcript[0]?.dateReference,
                ...(kind === 'extra_timestamp'
                  ? { utteranceStartedAt: new Date(initialTime - 86_400_000).toISOString() }
                  : {}),
              },
        ),
      }),
    });
    f.input();
    f.transcript('u1', 'Please reserve tomorrow');
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    expect(f.onTool).not.toHaveBeenCalled();
    expect(f.provider.events.at(-1)).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: 'delegation1',
    });
    expect(f.closed).not.toHaveBeenCalled();
    f.dispose();
  });

  it('holds approximate future fragment boundaries until the input audio catches up', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.input();
    f.transcript('lookahead', 'Tomorrow', 420, 440);
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    expect(f.closed).not.toHaveBeenCalled();
    expect(f.onDelegate).not.toHaveBeenCalled();
    f.input(320);
    await vi.advanceTimersByTimeAsync(700);
    expect(f.onDelegate.mock.calls[0]?.[0].transcript[0]?.startedAt).toBe(
      new Date(initialTime + 420).toISOString(),
    );
    f.dispose();
  });

  it('immediately invalidates a pending tool when a caller fragment is waiting for future audio', async () => {
    vi.useFakeTimers();
    const calls: Array<{
      input: LiveDelegationInput;
      resolve(result: LiveDelegationResult): void;
    }> = [];
    const f = fixture({
      actionsEnabled: true,
      onDelegate: (input) => new Promise((resolve) => calls.push({ input, resolve })),
    });
    f.input();
    f.transcript('u1', 'Tomorrow');
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    f.transcript('u2', 'Actually, Friday', 420, 440);
    expect(calls[0]?.input.signal.aborted).toBe(true);
    calls[0]?.resolve({
      kind: 'tool',
      name: 'prepare_request',
      callId: 'stale-tool',
      arguments: JSON.stringify({
        ...reservation,
        date_utterance_id: calls[0]?.input.transcript[0]?.dateReference,
      }),
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(f.onTool).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    f.input(320);
    await vi.advanceTimersByTimeAsync(700);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input.transcript.map((entry) => entry.text)).toEqual([
      'Tomorrow',
      'Actually, Friday',
    ]);
    f.dispose();
  });

  it.each(['count', 'bytes'] as const)(
    'bounds pending approximate transcript fragments by %s',
    (bound) => {
      const f = fixture();
      f.input();
      for (let index = 0; index < (bound === 'count' ? 65 : 6); index += 1)
        f.transcript(`future-${index}`, bound === 'count' ? 'x' : 'x'.repeat(3000), 420, 440);
      expect(f.closed).toHaveBeenCalledOnce();
      expect(f.diagnostic.mock.calls).toEqual([['relay_buffer_limit']]);
      expect(f.onDelegate).not.toHaveBeenCalled();
      f.dispose();
    },
  );

  it('keeps repeated caller corrections usable instead of closing after three stale attempts', async () => {
    vi.useFakeTimers();
    const calls: Array<{
      input: LiveDelegationInput;
      resolve(result: LiveDelegationResult): void;
    }> = [];
    const f = fixture({
      onDelegate: (input) => new Promise((resolve) => calls.push({ input, resolve })),
    });
    f.input();
    f.transcript('initial', 'A table');
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    for (let index = 0; index < 4; index += 1) {
      f.transcript(`revision-${index}`, ` detail ${index}`, 100, 200);
      expect(calls[index]?.input.signal.aborted).toBe(true);
      calls[index]?.resolve({ kind: 'reply', text: 'Stale reply' });
      await vi.advanceTimersByTimeAsync(700);
    }
    expect(calls).toHaveLength(5);
    expect(f.closed).not.toHaveBeenCalled();
    calls[4]?.resolve({ kind: 'reply', text: 'Please confirm the requested time.' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.events.filter((event) => event.type === 'session.commentary.append')).toEqual(
      [expect.objectContaining({ content: 'Please confirm the requested time.' })],
    );
    f.dispose();
  });

  it('never invokes an action after clearing playback fails and closes the relay', async () => {
    vi.useFakeTimers();
    const f = fixture({
      actionsEnabled: true,
      onDelegate: async ({ transcript }) => ({
        kind: 'tool',
        name: 'prepare_request',
        callId: 'tool1',
        arguments: JSON.stringify({
          ...reservation,
          date_utterance_id: transcript[0]?.dateReference,
        }),
      }),
    });
    f.input();
    f.transcript('u1', 'Tomorrow');
    f.audio();
    f.delegate();
    f.telephone.bufferedAmount = 300_000;
    await vi.advanceTimersByTimeAsync(700);
    expect(f.closed).toHaveBeenCalledOnce();
    expect(f.onTool).not.toHaveBeenCalled();
    f.dispose();
  });

  it('bounds backend duration and rejects late output after aborting on close', async () => {
    vi.useFakeTimers();
    let pending: LiveDelegationInput | undefined;
    let release: ((result: LiveDelegationResult) => void) | undefined;
    const f = fixture({
      onDelegate: (input) => {
        pending = input;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    f.input();
    f.transcript('u1', 'Tomorrow');
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(pending?.signal.aborted).toBe(true);
    expect(f.closed).toHaveBeenCalledOnce();
    release?.({ kind: 'reply', text: 'Unusable late result' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.events.some((event) => event.type === 'session.commentary.append')).toBe(
      false,
    );
    f.dispose();
  });
});
