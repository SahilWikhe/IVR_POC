import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { voiceProposalInputSchema } from '@hostline/contracts';
import {
  decodeAudio,
  type AudioPeer,
  type RelayDiagnosticCode,
  type RelayOptions,
  type VoiceToolRequest,
} from './relay.js';

export interface LiveDelegationInput {
  transcript: Array<{
    role: 'user' | 'assistant';
    text: string;
    dateReference?: string;
    startedAt?: string;
  }>;
  signal: AbortSignal;
}
export type LiveDelegationResult =
  | { kind: 'reply'; text: string }
  | { kind: 'tool'; name: string; arguments: string; callId: string };
export interface LiveRelayOptions extends RelayOptions {
  opening: string;
  onDelegate(input: LiveDelegationInput): Promise<LiveDelegationResult>;
}

const identifier = z.string().min(1).max(128);
const envelopeSchema = z.object({ type: z.string().max(120) }).passthrough();
const transcriptSchema = z.object({
  event_id: identifier,
  delta: z.string().min(1).max(4096),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
});
const delegationSchema = z.object({
  offset_ms: z.number().int().nonnegative().max(600_000),
  delegation: z.object({
    id: identifier,
    type: z.literal('delegation'),
    target: z.literal('client'),
  }),
});
// UTF-8 bytes conservatively bound the documented 500-token append limit
// without retaining a tokenizer or guessing a characters-to-tokens ratio.
const appendText = z
  .string()
  .min(1)
  .refine((text) => Buffer.byteLength(text) <= 480);
const resultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), text: appendText }).strict(),
  z
    .object({
      kind: z.literal('tool'),
      name: z.string().min(1).max(80),
      arguments: z.string().max(4096),
      callId: identifier,
    })
    .strict(),
]);
const reservationSchema = voiceProposalInputSchema.options[0].shape.reservation
  .extend({ date_utterance_id: z.uuid() })
  .strict();
const transferSchema = z
  .object({
    reason: z.enum(['requested_staff', 'allergy_question', 'other']).optional(),
    summary: z.string().trim().max(300).optional(),
  })
  .strict();
interface Fragment {
  eventId: string;
  startMs: number;
  endMs: number;
  entry: LiveDelegationInput['transcript'][number];
}
interface PendingFragment {
  eventId: string;
  startMs: number;
  endMs: number;
  role: 'user' | 'assistant';
  text: string;
  bytes: number;
}
interface Delegation {
  id: string;
  state: 'waiting' | 'running' | 'settled';
}
const unavailable =
  'The server could not begin the controlled step. No request was saved and no transfer is confirmed. Ask the caller to clarify the details or ask another question.';

/** Continuous Live protocol only. Transcript context is bounded, transient and never logged. */
export class LiveAudioRelay {
  private ready = false;
  private configured = false;
  private closed = false;
  private controlled = false;
  private pendingInput: string[] = [];
  private pendingInputBytes = 0;
  private firstInputAt: number | undefined;
  private forwardedDurationMs = 0;
  private readonly fragments: Fragment[] = [];
  private readonly pendingFragments: PendingFragment[] = [];
  private pendingFragmentBytes = 0;
  private readonly transcriptEvents = new Set<string>();
  private callerRevision = 0;
  private readonly delegations = new Map<string, Delegation>();
  private readonly toolCalls = new Set<string>();
  private delegateTimer: ReturnType<typeof setTimeout> | undefined;
  private delegateDeadline: ReturnType<typeof setTimeout> | undefined;
  private providerCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private providerFinalized = false;
  private providerTransportClosed = false;
  private activeDelegation:
    { task: Delegation; controller: AbortController; revision: number } | undefined;
  private delegationAttempts = 0;
  private readonly marks = new Map<string, number>();
  private queuedOutputBytes = 0;
  private markCounter = 0;

  constructor(
    private readonly twilio: AudioPeer,
    private readonly provider: AudioPeer,
    private readonly streamSid: string,
    private readonly onClose: () => void,
    private readonly options: LiveRelayOptions,
  ) {}

  get isReady(): boolean {
    return this.ready && !this.closed;
  }

  configure(instructions: string): void {
    if (this.closed) return;
    if (this.configured || !appendText.safeParse(this.options.opening).success)
      return this.close('provider_protocol_error');
    this.configured = true;
    this.send(this.provider, {
      type: 'session.start',
      event_id: randomUUID(),
      session: {
        model: 'gpt-live-1',
        store: false,
        instructions,
        audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
        delegation: { type: 'client' },
      },
    });
  }

  input(payload: string, receivedAt = (this.options.now ?? Date.now)()): void {
    if (this.closed || this.controlled) return;
    const audio = decodeAudio(payload, 3200);
    if (!audio || !Number.isFinite(receivedAt)) return this.close('provider_protocol_error');
    this.firstInputAt ??= receivedAt;
    if (!this.ready) {
      this.pendingInputBytes += audio.length;
      if (this.pendingInputBytes > 16_000 || this.pendingInput.length >= 150)
        return this.close('relay_buffer_limit');
      this.pendingInput.push(payload);
      return;
    }
    this.appendInput(payload, audio.length);
  }

  private appendInput(payload: string, bytes: number): void {
    if (this.send(this.provider, { type: 'session.input_audio.append', audio: payload })) {
      this.forwardedDurationMs += bytes / 8;
      this.flushTranscripts();
    }
  }

  providerEvent(raw: string): void {
    if (this.closed) {
      // Allow bounded finalization only; closed sessions never resume playback,
      // accept transcripts or execute late delegated work.
      if (Buffer.byteLength(raw) <= 192 * 1024) {
        try {
          if (envelopeSchema.parse(JSON.parse(raw)).type === 'session.closed')
            this.finishProviderClose();
        } catch {
          /* unusable terminal evidence is ignored until the close deadline */
        }
      }
      return;
    }
    if (Buffer.byteLength(raw) > 192 * 1024) return this.close('relay_buffer_limit');
    try {
      const event = envelopeSchema.parse(JSON.parse(raw));
      if (event.type === 'error') return this.close('provider_error');
      if (event.type === 'session.closed') {
        this.providerFinalized = true;
        return this.close();
      }
      if (event.type === 'session.started') {
        if (!this.configured) return this.close('provider_protocol_error');
        if (this.ready) return;
        this.ready = true;
        for (const payload of this.pendingInput)
          this.appendInput(payload, Buffer.from(payload, 'base64').length);
        this.pendingInput = [];
        this.pendingInputBytes = 0;
        this.send(this.provider, {
          type: 'session.instructions.append',
          event_id: randomUUID(),
          delegation_id: null,
          content: this.options.opening,
        });
        return;
      }
      if (this.controlled) return;
      if (
        [
          'session.output_audio.delta',
          'session.input_transcript.delta',
          'session.output_transcript.delta',
          'session.delegation.created',
        ].includes(event.type) &&
        !this.ready
      )
        return this.close('provider_protocol_error');
      switch (event.type) {
        case 'session.output_audio.delta': {
          const delta = z.object({ delta: z.string().max(128 * 1024) }).parse(event);
          const audio = decodeAudio(delta.delta, 96 * 1024);
          if (!audio) return this.close('provider_protocol_error');
          // Live emits a continuous stream, including silence. There are no
          // response/item playback boundaries or Realtime cancellation events.
          for (let offset = 0; offset < audio.length; offset += 800) {
            const part = audio.subarray(offset, offset + 800);
            if (this.queuedOutputBytes + part.length > 16_000 || this.marks.size >= 200)
              return this.close('relay_buffer_limit');
            const mark = `p${++this.markCounter}`;
            this.marks.set(mark, part.length);
            this.queuedOutputBytes += part.length;
            if (
              !this.send(this.twilio, {
                event: 'media',
                streamSid: this.streamSid,
                media: { payload: part.toString('base64') },
              })
            )
              return;
            if (
              !this.send(this.twilio, {
                event: 'mark',
                streamSid: this.streamSid,
                mark: { name: mark },
              })
            )
              return;
          }
          return;
        }
        case 'session.input_transcript.delta':
        case 'session.output_transcript.delta':
          this.transcript(
            event,
            event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
          );
          return;
        case 'session.delegation.created': {
          const { delegation } = delegationSchema.parse(event);
          if (this.delegations.has(delegation.id)) return;
          if (this.delegations.size >= 80) return this.close('relay_buffer_limit');
          this.delegations.set(delegation.id, { id: delegation.id, state: 'waiting' });
          this.scheduleDelegation();
          return;
        }
        default:
          // Acknowledgments and usage do not prove spoken playback or authorize actions.
          return;
      }
    } catch {
      this.close('provider_protocol_error');
    }
  }

  private transcript(event: unknown, role: 'user' | 'assistant'): void {
    const fragment = transcriptSchema.parse(event);
    if (this.transcriptEvents.has(fragment.event_id)) return;
    if (
      this.firstInputAt === undefined ||
      fragment.end_ms < fragment.start_ms ||
      // Live's approximate fragment boundaries can precede the next audio
      // append. Defer bounded lookahead rather than minting a future reference.
      fragment.end_ms > this.forwardedDurationMs + 1000
    )
      return this.close('provider_protocol_error');
    const bytes = Buffer.byteLength(JSON.stringify(fragment));
    if (
      this.fragments.length + this.pendingFragments.length >= 1024 ||
      this.pendingFragments.length >= 64 ||
      this.pendingFragmentBytes + bytes > 16 * 1024
    )
      return this.close('relay_buffer_limit');
    this.pendingFragments.push({
      eventId: fragment.event_id,
      startMs: fragment.start_ms,
      endMs: fragment.end_ms,
      role,
      text: fragment.delta,
      bytes,
    });
    this.pendingFragmentBytes += bytes;
    this.transcriptEvents.add(fragment.event_id);
    if (role === 'user') {
      // Invalidate work immediately, even while this fragment waits for audio.
      this.callerRevision += 1;
      if (this.delegateTimer) clearTimeout(this.delegateTimer);
      this.delegateTimer = undefined;
      const active = this.activeDelegation;
      if (active) {
        active.controller.abort();
        active.task.state = 'waiting';
      }
    }
    this.flushTranscripts();
  }

  private flushTranscripts(): void {
    if (this.closed || this.firstInputAt === undefined) return;
    let callerChanged = false;
    while (this.pendingFragments[0] && this.pendingFragments[0].endMs <= this.forwardedDurationMs) {
      const fragment = this.pendingFragments.shift();
      if (!fragment) break;
      this.pendingFragmentBytes -= fragment.bytes;
      const entry: LiveDelegationInput['transcript'][number] = {
        role: fragment.role,
        text: fragment.text,
      };
      if (fragment.role === 'user') {
        // A fragment reference is approximate, not a whole-utterance onset.
        // Both boundaries are now within successfully forwarded input audio.
        entry.dateReference = randomUUID();
        entry.startedAt = new Date(this.firstInputAt + fragment.startMs).toISOString();
        callerChanged = true;
      }
      this.fragments.push({
        eventId: fragment.eventId,
        startMs: fragment.startMs,
        endMs: fragment.endMs,
        entry,
      });
      // Preserve arrival order and exact spacing, including late/overlapping
      // fragments. Approximate timing cannot reorder a speaker's words.
      if (Buffer.byteLength(JSON.stringify(this.fragments.map((value) => value.entry))) > 48 * 1024)
        return this.close('relay_buffer_limit');
    }
    if (callerChanged) this.scheduleDelegation();
  }

  private scheduleDelegation(): void {
    if (
      this.closed ||
      this.controlled ||
      this.pendingFragments.some((fragment) => fragment.role === 'user') ||
      !this.fragments.some((value) => value.entry.role === 'user')
    )
      return;
    if (this.delegateTimer) clearTimeout(this.delegateTimer);
    // Transcript fragments have no turn-complete event. This coalesces bursts;
    // revisions, not the timer, determine whether a result is still usable.
    this.delegateTimer = setTimeout(() => {
      this.delegateTimer = undefined;
      void this.runDelegation();
    }, 700);
    this.delegateTimer.unref();
  }

  private async runDelegation(): Promise<void> {
    if (
      this.closed ||
      this.controlled ||
      this.activeDelegation ||
      this.pendingFragments.some((fragment) => fragment.role === 'user')
    )
      return;
    const task = [...this.delegations.values()].find((value) => value.state === 'waiting');
    if (!task) return;
    if (this.delegationAttempts >= 80) return this.close('relay_buffer_limit');
    this.delegationAttempts += 1;
    task.state = 'running';
    const controller = new AbortController();
    const active = { task, controller, revision: this.callerRevision };
    this.activeDelegation = active;
    const transcript = this.fragments.map((fragment) => Object.freeze({ ...fragment.entry }));
    Object.freeze(transcript);
    this.delegateDeadline = setTimeout(() => {
      if (this.activeDelegation === active) this.close('provider_error');
    }, 13_000);
    this.delegateDeadline.unref();
    try {
      const result = resultSchema.parse(
        await this.options.onDelegate({ transcript, signal: controller.signal }),
      );
      if (this.closed || controller.signal.aborted || active.revision !== this.callerRevision)
        return;
      if (this.delegateDeadline) clearTimeout(this.delegateDeadline);
      this.delegateDeadline = undefined;
      task.state = 'settled';
      if (result.kind === 'reply') this.commentary(task.id, result.text);
      else await this.handleTool(task.id, result, transcript);
    } catch {
      if (!this.closed && !controller.signal.aborted) this.close('provider_error');
    } finally {
      if (this.activeDelegation === active) {
        if (this.delegateDeadline) clearTimeout(this.delegateDeadline);
        this.delegateDeadline = undefined;
        this.activeDelegation = undefined;
        if (
          !this.closed &&
          !this.controlled &&
          [...this.delegations.values()].some((value) => value.state === 'waiting')
        )
          this.scheduleDelegation();
      }
    }
  }

  private async handleTool(
    delegationId: string,
    result: Extract<LiveDelegationResult, { kind: 'tool' }>,
    transcript: LiveDelegationInput['transcript'],
  ): Promise<void> {
    if (this.toolCalls.has(result.callId)) return;
    if (this.toolCalls.size >= 80) return this.close('relay_buffer_limit');
    this.toolCalls.add(result.callId);
    let request: VoiceToolRequest;
    try {
      if (!this.options.onTool) throw new Error('Unavailable action handler');
      const args: unknown = JSON.parse(result.arguments);
      if (result.name === 'prepare_request' && this.options.actionsEnabled) {
        const { date_utterance_id, ...reservation } = reservationSchema.parse(args);
        const reference = transcript.find(
          (entry) => entry.role === 'user' && entry.dateReference === date_utterance_id,
        );
        if (!reference?.startedAt) throw new Error('Unknown date reference');
        request = {
          toolCallId: result.callId,
          utteranceStartedAt: reference.startedAt,
          kind: 'proposal',
          proposal: voiceProposalInputSchema.parse({ kind: 'reservation', reservation }),
        };
      } else {
        const reference = transcript.findLast((entry) => entry.role === 'user');
        if (!reference?.startedAt) throw new Error('Missing caller reference');
        if (result.name === 'prepare_message' && this.options.actionsEnabled) {
          request = {
            toolCallId: result.callId,
            utteranceStartedAt: reference.startedAt,
            kind: 'proposal',
            proposal: voiceProposalInputSchema.parse({ kind: 'message', message: args }),
          };
        } else if (result.name === 'request_staff_transfer' && this.options.transfersEnabled) {
          const context = transferSchema.parse(args);
          request = {
            toolCallId: result.callId,
            utteranceStartedAt: reference.startedAt,
            kind: 'transfer',
            context: {
              reason: context.reason ?? 'requested_staff',
              summary: context.summary ?? '',
            },
          };
        } else throw new Error('Unavailable tool');
      }
    } catch {
      this.commentary(delegationId, unavailable);
      return;
    }
    this.controlled = true;
    this.clearPlayback();
    if (this.closed) return;
    // All model output/input is suppressed while deterministic server control
    // prepares the canonical readback. A model tool never confirms or saves.
    const outcome = await this.options.onTool?.(request);
    if (this.closed) return;
    if (outcome === 'unavailable') {
      this.controlled = false;
      this.commentary(delegationId, unavailable);
    } else if (outcome !== 'controlled') this.close('provider_error');
  }

  private commentary(delegationId: string, content: string): void {
    this.send(this.provider, {
      type: 'session.commentary.append',
      event_id: randomUUID(),
      delegation_id: delegationId,
      content: appendText.parse(content),
    });
  }

  played(mark: string): void {
    if (this.closed) return;
    const bytes = this.marks.get(mark);
    if (bytes === undefined) return;
    this.queuedOutputBytes -= bytes;
    this.marks.delete(mark);
  }

  private clearPlayback(): void {
    const hadOutput = this.marks.size > 0;
    this.marks.clear();
    this.queuedOutputBytes = 0;
    if (hadOutput) this.send(this.twilio, { event: 'clear', streamSid: this.streamSid });
  }

  private send(peer: AudioPeer, event: object): boolean {
    if (this.closed) return false;
    if (peer.readyState !== 1) {
      this.close('relay_transport_unavailable');
      return false;
    }
    if (peer.bufferedAmount > 256 * 1024) {
      this.close('relay_buffer_limit');
      return false;
    }
    try {
      peer.send(JSON.stringify(event));
      return true;
    } catch {
      this.close('relay_transport_unavailable');
      return false;
    }
  }

  close(reason?: RelayDiagnosticCode): void {
    if (this.closed) return;
    this.closed = true;
    if (reason) {
      try {
        this.options.onDiagnostic?.(reason);
      } catch {
        /* diagnostics cannot prevent cleanup */
      }
    }
    if (this.delegateTimer) clearTimeout(this.delegateTimer);
    if (this.delegateDeadline) clearTimeout(this.delegateDeadline);
    this.activeDelegation?.controller.abort();
    this.activeDelegation = undefined;
    if (this.marks.size > 0 && this.twilio.readyState === 1) {
      try {
        this.twilio.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
      } catch {
        /* already unavailable */
      }
    }
    this.pendingInput = [];
    this.pendingInputBytes = 0;
    this.fragments.length = 0;
    this.pendingFragments.length = 0;
    this.pendingFragmentBytes = 0;
    this.transcriptEvents.clear();
    this.delegations.clear();
    this.toolCalls.clear();
    this.marks.clear();
    this.queuedOutputBytes = 0;
    try {
      this.twilio.close(1000, 'Session ended');
    } catch {
      /* already closed */
    }
    if (this.ready && !this.providerFinalized && this.provider.readyState === 1) {
      this.providerCloseTimer = setTimeout(() => this.finishProviderClose(), 1500);
      this.providerCloseTimer.unref();
      try {
        this.provider.send(JSON.stringify({ type: 'session.close', event_id: randomUUID() }));
      } catch {
        this.finishProviderClose();
      }
    } else this.finishProviderClose();
    this.onClose();
  }

  private finishProviderClose(): void {
    if (this.providerTransportClosed) return;
    this.providerTransportClosed = true;
    if (this.providerCloseTimer) clearTimeout(this.providerCloseTimer);
    this.providerCloseTimer = undefined;
    this.providerFinalized = true;
    try {
      this.provider.close(1000, 'Session ended');
    } catch {
      /* already closed */
    }
  }
}
