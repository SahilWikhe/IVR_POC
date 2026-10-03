import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveAudioRelay,
  type LiveDelegationInput,
  type LiveDelegationResult,
  type LiveRelayOptions,
  type LiveWorkflowStage,
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
  const stage = vi.fn<(code: LiveWorkflowStage) => void>();
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
    onStage: stage,
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
    stage,
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

type CapturedTranscriptEvent = Parameters<NonNullable<LiveRelayOptions['onTranscript']>>[0];

describe('optional Live transcript capture', () => {
  it.each([false, true])(
    'captures only when a hook is configured (enabled=%s)',
    async (enabled) => {
      vi.useFakeTimers();
      const capture = vi.fn<NonNullable<LiveRelayOptions['onTranscript']>>();
      const f = fixture(enabled ? { onTranscript: capture } : {});
      f.input();
      f.transcript('caller1', ' What time? ', 0, 100);
      f.transcript('assistant1', ' At seven. ', 100, 200, 'assistant');
      f.audio();
      f.delegate();
      await vi.advanceTimersByTimeAsync(700);
      expect(f.closed).not.toHaveBeenCalled();
      expect(f.telephone.events.some((event) => event.event === 'media')).toBe(true);
      expect(f.provider.events.at(-1)).toMatchObject({ type: 'session.commentary.append' });
      expect(capture.mock.calls).toEqual(
        enabled
          ? [
              [{ kind: 'speech', source: 'caller', text: ' What time? ', startMs: 0, endMs: 100 }],
              [
                {
                  kind: 'speech',
                  source: 'assistant',
                  text: ' At seven. ',
                  startMs: 100,
                  endMs: 200,
                },
              ],
              [
                {
                  kind: 'backend_reply',
                  text: 'Please provide the requested date.',
                  awaitingCaller: false,
                },
              ],
            ]
          : [],
      );
      f.dispose();
    },
  );

  it('preserves exact speaker text, timing and admission order once, including deferred fragments', () => {
    const events: CapturedTranscriptEvent[] = [];
    const f = fixture({
      onTranscript: (event) => {
        events.push(event);
      },
    });
    f.input();
    f.transcript('private-event1', 'My number is ', 0, 100);
    f.transcript('private-event1', 'Duplicate must not be retained', 0, 100);
    f.transcript('private-event2', ' two', 420, 440);
    f.transcript('private-event3', ' I heard that.', 200, 300, 'assistant');
    expect(events).toHaveLength(1);
    f.input(320);
    expect(events).toEqual([
      { kind: 'speech', source: 'caller', text: 'My number is ', startMs: 0, endMs: 100 },
      { kind: 'speech', source: 'caller', text: ' two', startMs: 420, endMs: 440 },
      { kind: 'speech', source: 'assistant', text: ' I heard that.', startMs: 200, endMs: 300 },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private-event|dateReference|startedAt|streamSid/);
    f.dispose();
    f.transcript('late', 'Closed speech must not be retained.', 300, 400);
    f.event({ type: 'session.closed' });
    expect(events).toHaveLength(3);
  });

  it.each([
    { delta: '', start_ms: 0, end_ms: 100 },
    { delta: 'Private malformed text', start_ms: -1, end_ms: 100 },
    { delta: 'Private future text', start_ms: 1401, end_ms: 1440 },
  ])('does not capture a rejected transcript fragment %j', (fragment) => {
    const capture = vi.fn<NonNullable<LiveRelayOptions['onTranscript']>>();
    const f = fixture({ onTranscript: capture });
    f.input();
    f.event({ type: 'session.input_transcript.delta', event_id: 'invalid', ...fragment });
    expect(f.closed).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    f.dispose();
  });

  it('captures only the current accepted backend reply, never stale or late results', async () => {
    vi.useFakeTimers();
    const events: CapturedTranscriptEvent[] = [];
    const pending: Array<(result: LiveDelegationResult) => void> = [];
    const f = fixture({
      actionsEnabled: true,
      onTranscript: (event) => {
        events.push(event);
      },
      onDelegate: () => new Promise((resolve) => pending.push(resolve)),
    });
    f.input();
    f.transcript('date1', 'Tomorrow');
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    f.transcript('date2', 'Actually Friday', 100, 200);
    pending[0]?.({ kind: 'reply', text: 'Stale question', awaitingCaller: true });
    await vi.advanceTimersByTimeAsync(700);
    pending[1]?.({ kind: 'reply', text: 'What time on Friday?', awaitingCaller: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter((event) => event.kind === 'backend_reply')).toEqual([
      { kind: 'backend_reply', text: 'What time on Friday?', awaitingCaller: true },
    ]);
    f.transcript('time', 'Seven', 200, 300);
    await vi.advanceTimersByTimeAsync(700);
    f.dispose();
    pending[2]?.({ kind: 'reply', text: 'Late result after close' });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter((event) => event.kind === 'backend_reply')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/Stale question|Late result/);
  });

  it.each(['prepare_request', 'prepare_message', 'request_staff_transfer'] as const)(
    'captures one normalized %s proposal without control identities before handoff',
    async (tool) => {
      vi.useFakeTimers();
      const events: CapturedTranscriptEvent[] = [];
      const f = fixture({
        actionsEnabled: true,
        transfersEnabled: true,
        onTranscript: (event) => {
          events.push(event);
        },
        onDelegate: async ({ transcript }) => ({
          kind: 'tool',
          name: tool,
          callId: 'private-provider-call-id',
          arguments: JSON.stringify(
            tool === 'prepare_request'
              ? {
                  ...reservation,
                  notes: '  Window please  ',
                  date_utterance_id: transcript[0]?.dateReference,
                }
              : tool === 'prepare_message'
                ? {
                    name: ' Synthetic Guest ',
                    callbackNumber: reservation.callbackNumber,
                    message: ' Please call back. ',
                  }
                : { reason: 'requested_staff', summary: '  Caller requests staff  ' },
          ),
        }),
        onTool: async () => {
          expect(events.filter((event) => event.kind === 'tool_proposal')).toHaveLength(1);
          return 'controlled';
        },
      });
      f.input();
      f.transcript('private-caller-event-id', 'Tomorrow');
      f.delegate('private-delegation-id');
      await vi.advanceTimersByTimeAsync(700);
      f.delegate('private-delegation-id');
      f.delegate('late-delegation');
      f.transcript('late', 'Controlled speech', 100, 200);
      await vi.advanceTimersByTimeAsync(700);
      expect(events.filter((event) => event.kind === 'tool_proposal')).toEqual([
        {
          kind: 'tool_proposal',
          tool,
          text: JSON.stringify(
            tool === 'prepare_request'
              ? { kind: 'reservation', reservation: { ...reservation, notes: 'Window please' } }
              : tool === 'prepare_message'
                ? {
                    kind: 'message',
                    message: {
                      name: 'Synthetic Guest',
                      callbackNumber: reservation.callbackNumber,
                      message: 'Please call back.',
                    },
                  }
                : { reason: 'requested_staff', summary: 'Caller requests staff' },
          ),
        },
      ]);
      expect(JSON.stringify(events)).not.toMatch(
        /private-|late-delegation|date_utterance_id|dateReference|toolCallId|utteranceStartedAt|streamSid/,
      );
      f.dispose();
    },
  );

  it.each(['invalid_arguments', 'forged_date', 'stale_result'] as const)(
    'does not capture rejected or stale tool payloads (%s)',
    async (reason) => {
      vi.useFakeTimers();
      const events: CapturedTranscriptEvent[] = [];
      let resolve: ((result: LiveDelegationResult) => void) | undefined;
      let input: LiveDelegationInput | undefined;
      const f = fixture({
        actionsEnabled: true,
        onTranscript: (event) => {
          events.push(event);
        },
        onDelegate: (value) => {
          input = value;
          return new Promise((release) => {
            resolve = release;
          });
        },
      });
      f.input();
      f.transcript('u1', 'Tomorrow');
      f.delegate();
      await vi.advanceTimersByTimeAsync(700);
      if (reason === 'stale_result') f.transcript('u2', 'Actually Friday', 100, 200);
      resolve?.({
        kind: 'tool',
        name: 'prepare_request',
        callId: 'discarded-tool',
        arguments: JSON.stringify({
          ...reservation,
          date_utterance_id:
            reason === 'forged_date'
              ? '22222222-2222-4222-8222-222222222222'
              : input?.transcript[0]?.dateReference,
          ...(reason === 'invalid_arguments' ? { providerCallSid: 'not-authorized' } : {}),
        }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(events.filter((event) => event.kind === 'tool_proposal')).toEqual([]);
      expect(f.onTool).not.toHaveBeenCalled();
      f.dispose();
    },
  );

  it.each(['sync', 'async'] as const)(
    'contains a %s capture failure without changing playback or control',
    async (mode) => {
      vi.useFakeTimers();
      const onTool = vi.fn<NonNullable<LiveRelayOptions['onTool']>>(async () => 'controlled');
      const f = fixture({
        actionsEnabled: true,
        onTranscript:
          mode === 'sync'
            ? () => {
                throw new Error('Synthetic capture failure');
              }
            : async () => {
                throw new Error('Synthetic async capture failure');
              },
        onTool,
        onDelegate: async ({ transcript }) => ({
          kind: 'tool',
          name: 'prepare_request',
          callId: 'valid-tool',
          arguments: JSON.stringify({
            ...reservation,
            date_utterance_id: transcript[0]?.dateReference,
          }),
        }),
      });
      f.input();
      f.transcript('date', 'Tomorrow');
      f.audio();
      expect(f.telephone.events.some((event) => event.event === 'media')).toBe(true);
      f.delegate();
      await vi.advanceTimersByTimeAsync(700);
      expect(onTool).toHaveBeenCalledOnce();
      expect(f.closed).not.toHaveBeenCalled();
      expect(f.telephone.events.at(-1)).toEqual({ event: 'clear', streamSid });
      f.dispose();
      expect(f.closed).toHaveBeenCalledOnce();
    },
  );
});

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
    expect(f.stage.mock.calls).toEqual([['session_ready']]);
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
    expect(f.stage.mock.calls.slice(-2)).toEqual([['backend_stale'], ['backend_cancelled']]);
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
    expect(f.stage).toHaveBeenCalledWith(
      kind === 'forged_reference' ? 'date_handle_rejected' : 'tool_validation_rejected',
    );
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
    expect(f.stage.mock.calls.slice(-2)).toEqual([['backend_failed'], ['backend_cancelled']]);
    release?.({ kind: 'reply', text: 'Unusable late result' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.events.some((event) => event.type === 'session.commentary.append')).toBe(
      false,
    );
    f.dispose();
  });
});

describe('Live incomplete task continuation and workflow diagnostics', () => {
  it('continues the original clarification into one proposal using the corrected date fragment', async () => {
    vi.useFakeTimers();
    const delegate = vi
      .fn<LiveRelayOptions['onDelegate']>()
      .mockResolvedValueOnce({ kind: 'reply', text: 'Which day?', awaitingCaller: true })
      .mockImplementation(async ({ transcript }) => ({
        kind: 'tool',
        name: 'prepare_request',
        callId: 'current-tool',
        arguments: JSON.stringify({
          ...reservation,
          dateExpression: 'Friday',
          date_utterance_id: transcript.at(-1)?.dateReference,
        }),
      }));
    const f = fixture({ actionsEnabled: true, onDelegate: delegate });
    f.input();
    f.transcript('intent', 'I would like to make a request.');
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    f.transcript('date', 'Tomorrow, with the remaining details.', 100, 200);
    f.transcript('correction', 'Actually Friday.', 200, 300);
    await vi.advanceTimersByTimeAsync(700);
    expect(delegate).toHaveBeenCalledTimes(2);
    expect(f.onTool).toHaveBeenCalledExactlyOnceWith({
      toolCallId: 'current-tool',
      utteranceStartedAt: new Date(initialTime + 200).toISOString(),
      kind: 'proposal',
      proposal: { kind: 'reservation', reservation: { ...reservation, dateExpression: 'Friday' } },
    });
    f.transcript('late', 'Do not execute anything again.', 300, 400);
    f.delegate('late-delegation');
    await vi.advanceTimersByTimeAsync(1000);
    expect(delegate).toHaveBeenCalledTimes(2);
    expect(f.onTool).toHaveBeenCalledOnce();
    f.dispose();
  });

  it('continues only an explicit clarification on new caller details, then settles cancellation', async () => {
    vi.useFakeTimers();
    const delegate = vi
      .fn<LiveRelayOptions['onDelegate']>()
      .mockResolvedValueOnce({ kind: 'reply', text: 'Which day?', awaitingCaller: true })
      .mockResolvedValueOnce({ kind: 'reply', text: 'What time on Friday?', awaitingCaller: true })
      .mockResolvedValueOnce({ kind: 'reply', text: 'Okay, no request has been saved.' });
    const f = fixture({ actionsEnabled: true, onDelegate: delegate });
    f.input();
    f.transcript('intent', 'I would like to make a request.');
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    f.transcript('question', 'Which day?', 0, 100, 'assistant');
    await vi.advanceTimersByTimeAsync(5000);
    expect(delegate).toHaveBeenCalledOnce();
    f.transcript('date', 'Tomorrow', 100, 200);
    f.transcript('correction', ' actually Friday', 200, 300);
    await vi.advanceTimersByTimeAsync(700);
    expect(delegate).toHaveBeenCalledTimes(2);
    expect(delegate.mock.calls[1]?.[0].transcript.map((entry) => entry.text)).toEqual([
      'I would like to make a request.',
      'Which day?',
      'Tomorrow',
      ' actually Friday',
    ]);
    f.transcript('cancel', 'Never mind, cancel this request.', 300, 400);
    await vi.advanceTimersByTimeAsync(700);
    f.input();
    f.transcript('faq', 'What are your hours?', 400, 500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(delegate).toHaveBeenCalledTimes(3);
    expect(f.onTool).not.toHaveBeenCalled();
    expect(
      f.provider.events
        .filter((event) => event.type === 'session.commentary.append')
        .map((event) => event.delegation_id),
    ).toEqual(['delegation1', 'delegation1', 'delegation1']);
    expect(f.stage.mock.calls.map(([code]) => code)).toEqual([
      'session_ready',
      'delegation_requested',
      'backend_started',
      'backend_reply',
      'backend_waiting_for_caller',
      'backend_started',
      'backend_reply',
      'backend_waiting_for_caller',
      'backend_started',
      'backend_reply',
    ]);
    f.dispose();
  });

  it.each(['waiting', 'running'] as const)(
    'supersedes %s continuation with a fresh delegation and executes only its current proposal',
    async (phase) => {
      vi.useFakeTimers();
      const pending: Array<{
        input: LiveDelegationInput;
        resolve(result: LiveDelegationResult): void;
      }> = [];
      const delegate = vi
        .fn<LiveRelayOptions['onDelegate']>()
        .mockResolvedValueOnce({ kind: 'reply', text: 'Which day?', awaitingCaller: true })
        .mockImplementation((input) => new Promise((resolve) => pending.push({ input, resolve })));
      const f = fixture({ actionsEnabled: true, onDelegate: delegate });
      const proposal = (input: LiveDelegationInput, id: string): LiveDelegationResult => ({
        kind: 'tool',
        name: 'prepare_request',
        callId: id,
        arguments: JSON.stringify({
          ...reservation,
          date_utterance_id: input.transcript.at(-1)?.dateReference,
        }),
      });
      f.input();
      f.transcript('intent', 'Please take a request.');
      f.delegate('original');
      await vi.advanceTimersByTimeAsync(700);
      f.transcript('date', 'Tomorrow', 100, 200);
      if (phase === 'running') await vi.advanceTimersByTimeAsync(700);
      f.delegate('replacement');
      f.delegate('replacement');
      if (phase === 'running') {
        expect(pending[0]?.input.signal.aborted).toBe(true);
        pending[0]?.resolve(proposal(pending[0].input, 'discarded-tool'));
      }
      await vi.advanceTimersByTimeAsync(700);
      const current = pending.at(-1)!;
      current.resolve(proposal(current.input, 'current-tool'));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onTool).toHaveBeenCalledOnce();
      expect(f.onTool.mock.calls[0]?.[0].toolCallId).toBe('current-tool');
      expect(f.stage.mock.calls.filter(([code]) => code === 'delegation_requested')).toHaveLength(
        2,
      );
      expect(
        f.stage.mock.calls.filter(([code]) => code === 'control_handoff_accepted'),
      ).toHaveLength(1);
      f.dispose();
    },
  );

  it('does not continue a clarification marker when request actions are disabled', async () => {
    vi.useFakeTimers();
    const delegate = vi.fn<LiveRelayOptions['onDelegate']>(async () => ({
      kind: 'reply',
      text: 'Which day?',
      awaitingCaller: true,
    }));
    const f = fixture({ onDelegate: delegate });
    f.input();
    f.transcript('intent', 'A question');
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    f.transcript('answer', 'Tomorrow', 100, 200);
    await vi.advanceTimersByTimeAsync(700);
    expect(delegate).toHaveBeenCalledOnce();
    expect(f.stage).not.toHaveBeenCalledWith('backend_waiting_for_caller');
    f.dispose();
  });

  it('bounds ongoing clarification by the existing total backend-attempt budget', async () => {
    vi.useFakeTimers();
    const delegate = vi.fn<LiveRelayOptions['onDelegate']>(async () => ({
      kind: 'reply',
      text: 'Please clarify.',
      awaitingCaller: true,
    }));
    const f = fixture({ actionsEnabled: true, onDelegate: delegate });
    f.input();
    f.delegate();
    for (let index = 0; index <= 80; index += 1) {
      f.transcript(`answer-${index}`, 'Synthetic detail');
      await vi.advanceTimersByTimeAsync(700);
    }
    expect(delegate).toHaveBeenCalledTimes(80);
    expect(f.closed).toHaveBeenCalledOnce();
    expect(f.diagnostic).toHaveBeenCalledWith('relay_buffer_limit');
    f.dispose();
  });

  it.each(['controlled', 'unavailable', 'failed'] as const)(
    'reports only static stages for a %s control handoff',
    async (outcome) => {
      vi.useFakeTimers();
      const privateText = 'Synthetic Guest +12125550111 SYNTHETIC_API_KEY private provider error';
      const f = fixture({
        actionsEnabled: true,
        onDelegate: async ({ transcript }) => ({
          kind: 'tool',
          name: 'prepare_request',
          callId: 'private-provider-tool-id',
          arguments: JSON.stringify({
            ...reservation,
            date_utterance_id: transcript[0]?.dateReference,
          }),
        }),
        onTool: async () => {
          if (outcome === 'failed') throw new Error(privateText);
          return outcome;
        },
      });
      f.input();
      f.transcript('private-provider-event-id', privateText);
      f.delegate('private-delegation-id');
      await vi.advanceTimersByTimeAsync(700);
      expect(f.stage.mock.calls.map(([code]) => code)).toEqual([
        'session_ready',
        'delegation_requested',
        'backend_started',
        'backend_tool',
        'control_handoff_started',
        outcome === 'controlled'
          ? 'control_handoff_accepted'
          : outcome === 'unavailable'
            ? 'control_handoff_unavailable'
            : 'control_handoff_failed',
      ]);
      expect(f.stage.mock.calls.every((args) => args.length === 1)).toBe(true);
      const diagnostics = JSON.stringify([f.stage.mock.calls, f.diagnostic.mock.calls]);
      for (const content of [
        privateText,
        'private-provider-tool-id',
        'private-provider-event-id',
        'private-delegation-id',
        streamSid,
      ])
        expect(diagnostics).not.toContain(content);
      f.dispose();
    },
  );

  it('keeps a throwing stage sink from affecting normal backend replies or cleanup', async () => {
    vi.useFakeTimers();
    const f = fixture({
      onStage: () => {
        throw new Error('Synthetic logging failure');
      },
    });
    f.input();
    f.transcript('u1', 'What time?');
    f.delegate();
    await vi.advanceTimersByTimeAsync(700);
    expect(f.provider.events.at(-1)).toMatchObject({ type: 'session.commentary.append' });
    expect(f.closed).not.toHaveBeenCalled();
    f.dispose();
    expect(f.closed).toHaveBeenCalledOnce();
  });
});
