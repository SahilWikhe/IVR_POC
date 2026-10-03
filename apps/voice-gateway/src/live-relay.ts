import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { voiceProposalInputSchema } from '@hostline/contracts';
import type { VoiceTranscriptEvent } from '@hostline/observability';
import {
  LiveReadback,
  LiveSpeechBoundary,
  audiblePcmu,
  type LiveReadbackDiagnostic,
} from './live-readback.js';
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
  | { kind: 'reply'; text: string; awaitingCaller?: boolean }
  | { kind: 'tool'; name: string; arguments: string; callId: string };
type LiveProtocolFailure =
  | 'protocol_configuration_invalid'
  | 'protocol_input_audio_invalid'
  | 'protocol_envelope_invalid'
  | 'protocol_event_before_ready'
  | 'protocol_instruction_ack_invalid'
  | 'protocol_output_audio_invalid'
  | `protocol_${'caller' | 'assistant'}_transcript_${'invalid' | 'before_input' | 'reversed' | 'ahead'}`
  | 'protocol_delegation_invalid'
  | 'protocol_handler_failed';
export type LiveWorkflowStage =
  | LiveReadbackDiagnostic
  | LiveProtocolFailure
  | 'session_ready'
  | 'delegation_requested'
  | 'backend_started'
  | 'backend_reply'
  | 'backend_waiting_for_caller'
  | 'backend_tool'
  | 'backend_stale'
  | 'backend_cancelled'
  | 'backend_failed'
  | 'tool_validation_rejected'
  | 'date_handle_rejected'
  | 'control_handoff_started'
  | 'control_handoff_unavailable'
  | 'control_handoff_accepted'
  | 'readback_playback_started'
  | 'readback_playback_checked'
  | 'readback_playback_rejected'
  | 'control_handoff_failed';
export interface LiveRelayOptions extends RelayOptions {
  opening: string;
  onDelegate(input: LiveDelegationInput): Promise<LiveDelegationResult>;
  onStage?: (code: LiveWorkflowStage) => void;
  onTranscript?: (event: VoiceTranscriptEvent) => void;
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
  z
    .object({ kind: z.literal('reply'), text: appendText, awaitingCaller: z.boolean().optional() })
    .strict(),
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
  state: 'waiting' | 'running' | 'awaiting_caller' | 'settled';
}
const unavailable =
  'The server could not begin the controlled step. No request was saved and no transfer is confirmed. Ask the caller to clarify the details or ask another question.';

/** Continuous Live protocol. Context is transient; optional capture is owned by the caller. */
export class LiveAudioRelay {
  private ready = false;
  private configured = false;
  private closed = false;
  private controlled = false;
  private controlRevision = 0;
  private readback: LiveReadback | undefined;
  private recoveryBoundary: LiveSpeechBoundary | undefined;
  private retryAfterRevision: number | undefined;
  private approvedReadbackRevision: number | undefined;
  private controlSpeechMs = 0;
  private readbackFailed = false;
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
      return this.protocolFailure('protocol_configuration_invalid');
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
        // Startup input is available immediately. A short, one-time cue below
        // avoids streaming the entire greeting into the running timeline.
        input: [
          {
            type: 'message',
            role: 'developer',
            content: [
              {
                type: 'input_text',
                text: `Opening instructions: ${this.options.opening} Wait until the application says "Begin the opening" before executing these instructions.`,
              },
            ],
          },
        ],
      },
    });
  }

  input(payload: string, receivedAt = (this.options.now ?? Date.now)()): void {
    if (this.closed) return;
    const audio = decodeAudio(payload, 3200);
    if (!audio || !Number.isFinite(receivedAt))
      return this.protocolFailure('protocol_input_audio_invalid');
    if (this.readback)
      for (let offset = 0; offset < audio.length; offset += 160)
        this.readback.callerAudio(audio.subarray(offset, offset + 160));
    if (this.approvedReadbackRevision !== undefined) {
      for (let offset = 0; offset < audio.length; offset += 160) {
        const frame = audio.subarray(offset, offset + 160);
        this.controlSpeechMs = audiblePcmu(frame) ? this.controlSpeechMs + frame.length / 8 : 0;
        if (this.controlSpeechMs >= 160) {
          this.interruptReadback();
          break;
        }
      }
    }
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
    let event: z.infer<typeof envelopeSchema>;
    try {
      event = envelopeSchema.parse(JSON.parse(raw));
    } catch {
      return this.protocolFailure('protocol_envelope_invalid');
    }
    try {
      if (event.type === 'error') return this.close('provider_error');
      if (event.type === 'session.closed') {
        this.providerFinalized = true;
        return this.close();
      }
      if (event.type === 'session.started') {
        if (!this.configured) return this.protocolFailure('protocol_event_before_ready');
        if (this.ready) return;
        this.ready = true;
        this.stage('session_ready');
        for (const payload of this.pendingInput)
          this.appendInput(payload, Buffer.from(payload, 'base64').length);
        this.pendingInput = [];
        this.pendingInputBytes = 0;
        this.send(this.provider, {
          type: 'session.instructions.append',
          event_id: randomUUID(),
          delegation_id: null,
          content: 'Begin the opening now.',
        });
        return;
      }
      if (event.type === 'session.instructions.appended') {
        const parsed = z.object({ client_event_id: identifier }).safeParse(event);
        if (!parsed.success) return this.protocolFailure('protocol_instruction_ack_invalid');
        const ack = parsed.data;
        this.readback?.acknowledge(ack.client_event_id);
        this.recoveryBoundary?.acknowledge(ack.client_event_id);
        return;
      }
      if (
        this.controlled &&
        !this.readback &&
        !this.recoveryBoundary &&
        event.type !== 'session.input_transcript.delta' &&
        event.type !== 'session.delegation.created'
      )
        return;
      if (
        [
          'session.output_audio.delta',
          'session.input_transcript.delta',
          'session.output_transcript.delta',
          'session.delegation.created',
        ].includes(event.type) &&
        !this.ready
      )
        return this.protocolFailure('protocol_event_before_ready');
      switch (event.type) {
        case 'session.output_audio.delta': {
          const parsed = z.object({ delta: z.string().max(128 * 1024) }).safeParse(event);
          if (!parsed.success) return this.protocolFailure('protocol_output_audio_invalid');
          const audio = decodeAudio(parsed.data.delta, 96 * 1024);
          if (!audio) return this.protocolFailure('protocol_output_audio_invalid');
          if (this.recoveryBoundary) {
            this.recoveryBoundary.output(audio);
            return;
          }
          // Live emits a continuous stream, including silence. There are no
          // response/item playback boundaries or Realtime cancellation events.
          const frameBytes = this.readback ? 160 : 800;
          for (let offset = 0; offset < audio.length; offset += frameBytes) {
            const part = audio.subarray(offset, offset + frameBytes);
            if (this.readback && !this.readback.output(part)) continue;
            if (!this.playAudioFrame(part)) return;
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
          const parsed = delegationSchema.safeParse(event);
          if (!parsed.success) return this.protocolFailure('protocol_delegation_invalid');
          const { delegation } = parsed.data;
          if (this.delegations.has(delegation.id)) return;
          if (this.delegations.size >= 80) return this.close('relay_buffer_limit');
          if (
            this.controlled ||
            (this.retryAfterRevision !== undefined &&
              this.callerRevision <= this.retryAfterRevision)
          ) {
            // Remember a stale request so replaying its ID after later speech
            // cannot turn the failed readback into an automatic retry.
            this.delegations.set(delegation.id, { id: delegation.id, state: 'settled' });
            return;
          }
          this.retryAfterRevision = undefined;
          // A new provider request supersedes unfinished local work. Keep one
          // current task, so a repeated delegation cannot prepare two proposals.
          this.settleDelegations();
          this.cancelBackend();
          this.delegations.set(delegation.id, { id: delegation.id, state: 'waiting' });
          this.stage('delegation_requested');
          this.scheduleDelegation();
          return;
        }
        default:
          // Acknowledgments and usage do not prove spoken playback or authorize actions.
          return;
      }
    } catch {
      this.protocolFailure('protocol_handler_failed');
    }
  }

  private transcript(event: unknown, role: 'user' | 'assistant'): void {
    const source = role === 'user' ? 'caller' : 'assistant';
    const parsed = transcriptSchema.safeParse(event);
    if (!parsed.success) return this.protocolFailure(`protocol_${source}_transcript_invalid`);
    const fragment = parsed.data;
    if (this.transcriptEvents.has(fragment.event_id)) return;
    if (this.firstInputAt === undefined)
      return this.protocolFailure(`protocol_${source}_transcript_before_input`);
    if (fragment.end_ms < fragment.start_ms)
      return this.protocolFailure(`protocol_${source}_transcript_reversed`);
    // Live's approximate fragment boundaries can precede the next audio
    // append. Defer bounded lookahead rather than minting a future reference.
    if (fragment.end_ms > this.forwardedDurationMs + 1000)
      return this.protocolFailure(`protocol_${source}_transcript_ahead`);
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
      if (this.controlled) this.readbackFailed = true;
      this.readback?.cancel();
      // Invalidate work immediately, even while this fragment waits for audio.
      this.callerRevision += 1;
      if (this.delegateTimer) clearTimeout(this.delegateTimer);
      this.delegateTimer = undefined;
      const active = this.activeDelegation;
      if (active?.task.state === 'running' && !active.controller.signal.aborted) {
        active.task.state = 'waiting';
        this.cancelBackend();
      }
      // Only an explicit backend clarification continues without another Live
      // delegation. Arbitrary factual replies and silence never start work.
      for (const task of this.delegations.values())
        if (task.state === 'awaiting_caller') task.state = 'waiting';
    }
    this.flushTranscripts();
  }

  private playAudioFrame(part: Uint8Array): boolean {
    if (this.closed) return false;
    if (this.queuedOutputBytes + part.length > 16_000 || this.marks.size >= 200) {
      this.close('relay_buffer_limit');
      return false;
    }
    const mark = `p${++this.markCounter}`;
    this.marks.set(mark, part.length);
    this.queuedOutputBytes += part.length;
    return (
      this.send(this.twilio, {
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: Buffer.from(part).toString('base64') },
      }) &&
      this.send(this.twilio, { event: 'mark', streamSid: this.streamSid, mark: { name: mark } })
    );
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
      if (fragment.role === 'assistant') {
        this.readback?.text(fragment.text);
        this.recoveryBoundary?.text();
      }
      // Preserve arrival order and exact spacing, including late/overlapping
      // fragments. Approximate timing cannot reorder a speaker's words.
      if (Buffer.byteLength(JSON.stringify(this.fragments.map((value) => value.entry))) > 48 * 1024)
        return this.close('relay_buffer_limit');
      this.capture({
        kind: 'speech',
        source: fragment.role === 'user' ? 'caller' : 'assistant',
        text: fragment.text,
        startMs: fragment.startMs,
        endMs: fragment.endMs,
      });
    }
    if (callerChanged) this.scheduleDelegation();
  }

  private scheduleDelegation(): void {
    if (
      this.closed ||
      this.controlled ||
      this.retryAfterRevision !== undefined ||
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
      this.retryAfterRevision !== undefined ||
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
      if (this.activeDelegation === active) {
        this.stage('backend_failed');
        this.close('provider_error');
      }
    }, 13_000);
    this.delegateDeadline.unref();
    this.stage('backend_started');
    try {
      const result = resultSchema.parse(
        await this.options.onDelegate({ transcript, signal: controller.signal }),
      );
      if (this.closed || controller.signal.aborted || active.revision !== this.callerRevision)
        return;
      if (this.delegateDeadline) clearTimeout(this.delegateDeadline);
      this.delegateDeadline = undefined;
      task.state = 'settled';
      if (result.kind === 'reply') {
        this.stage('backend_reply');
        if (result.awaitingCaller && this.options.actionsEnabled) {
          task.state = 'awaiting_caller';
          this.stage('backend_waiting_for_caller');
        }
        this.capture({
          kind: 'backend_reply',
          text: result.text,
          awaitingCaller: task.state === 'awaiting_caller',
        });
        this.commentary(task.id, result.text);
      } else {
        this.stage('backend_tool');
        await this.handleTool(task.id, result, transcript);
      }
    } catch {
      if (!this.closed && !controller.signal.aborted) {
        if (task.state === 'running') this.stage('backend_failed');
        this.close('provider_error');
      }
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
    let rejection: 'tool_validation_rejected' | 'date_handle_rejected' = 'tool_validation_rejected';
    try {
      if (!this.options.onTool) throw new Error('Unavailable action handler');
      const args: unknown = JSON.parse(result.arguments);
      if (result.name === 'prepare_request' && this.options.actionsEnabled) {
        const { date_utterance_id, ...reservation } = reservationSchema.parse(args);
        const reference = transcript.find(
          (entry) => entry.role === 'user' && entry.dateReference === date_utterance_id,
        );
        if (!reference?.startedAt) {
          rejection = 'date_handle_rejected';
          throw new Error('Unknown date reference');
        }
        request = {
          toolCallId: result.callId,
          utteranceStartedAt: reference.startedAt,
          kind: 'proposal',
          proposal: voiceProposalInputSchema.parse({ kind: 'reservation', reservation }),
        };
      } else {
        const reference = transcript.findLast((entry) => entry.role === 'user');
        if (!reference?.startedAt) {
          rejection = 'date_handle_rejected';
          throw new Error('Missing caller reference');
        }
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
      this.stage(rejection);
      this.commentary(delegationId, unavailable);
      return;
    }
    this.controlled = true;
    this.settleDelegations();
    this.controlRevision = this.callerRevision;
    this.readbackFailed = false;
    this.clearPlayback();
    if (this.closed) return;
    // Ordinary model output/delegation is suppressed during server control.
    // Input stays continuous so corrections can invalidate the readback.
    this.capture({
      kind: 'tool_proposal',
      tool:
        request.kind === 'transfer'
          ? 'request_staff_transfer'
          : request.proposal.kind === 'reservation'
            ? 'prepare_request'
            : 'prepare_message',
      text: JSON.stringify(request.kind === 'proposal' ? request.proposal : request.context),
    });
    this.stage('control_handoff_started');
    let outcome;
    try {
      outcome = await this.options.onTool?.(request);
    } catch {
      if (!this.closed) this.stage('control_handoff_failed');
      throw new Error('Voice control unavailable');
    }
    if (this.closed) return;
    if (outcome === 'unavailable') {
      this.stage('control_handoff_unavailable');
      this.settleDelegations();
      if (this.readbackFailed) {
        this.clearPlayback();
        const boundary = new LiveSpeechBoundary({
          instructions: (eventId, content) => {
            this.send(this.provider, {
              type: 'session.instructions.append',
              event_id: eventId,
              delegation_id: null,
              content,
            });
          },
          drained: () => this.playbackAndTranscriptDrained(),
          diagnostic: (code) => this.stage(code),
          now: this.options.now ?? Date.now,
        });
        this.recoveryBoundary = boundary;
        const quiet = await boundary.run();
        if (this.recoveryBoundary === boundary) this.recoveryBoundary = undefined;
        if (this.closed) return;
        if (!quiet) return this.close('provider_error');
        // This includes received-but-deferred fragments: admission later does
        // not create a newer caller revision or authorize another preparation.
        this.retryAfterRevision = this.callerRevision;
        this.settleDelegations();
        this.controlled = false;
        this.send(this.provider, {
          type: 'session.instructions.append',
          event_id: randomUUID(),
          delegation_id: null,
          content:
            'Resume normal conversation. Say only: "Nothing has been saved. Would you like me to read the details again? Please wait for the tone before confirming." Then listen. Keep all details already collected. Do not delegate or prepare again until the caller explicitly asks to retry or gives a new correction after this question.',
        });
      } else {
        this.controlled = false;
        this.commentary(delegationId, unavailable);
      }
    } else if (outcome === 'controlled') this.stage('control_handoff_accepted');
    else {
      this.stage('control_handoff_failed');
      this.close('provider_error');
    }
  }

  private commentary(delegationId: string, content: string): void {
    this.send(this.provider, {
      type: 'session.commentary.append',
      event_id: randomUUID(),
      delegation_id: delegationId,
      content: appendText.parse(content),
    });
  }

  /** Only the gateway supplies API-authored text; this is not a model tool. */
  async speakReadback(text: string): Promise<string | null> {
    this.readbackFailed = true;
    if (
      this.closed ||
      !this.controlled ||
      this.controlRevision !== this.callerRevision ||
      this.readback
    )
      return null;
    this.clearPlayback();
    this.approvedReadbackRevision = undefined;
    const readback = new LiveReadback(text, {
      instructions: (eventId, content) => {
        this.send(this.provider, {
          type: 'session.instructions.append',
          event_id: eventId,
          delegation_id: null,
          content,
        });
      },
      drained: () => this.playbackAndTranscriptDrained(),
      diagnostic: (code) => this.stage(code),
      playBuffered: (audio) => {
        this.playAudioFrame(audio);
      },
      now: this.options.now ?? Date.now,
    });
    this.readback = readback;
    this.stage('readback_playback_started');
    const transcript = await readback.run();
    if (this.readback === readback) this.readback = undefined;
    if (transcript === null) this.clearPlayback();
    if (this.closed || this.controlRevision !== this.callerRevision || transcript === null) {
      this.stage('readback_playback_rejected');
      return null;
    }
    this.approvedReadbackRevision = this.callerRevision;
    this.readbackFailed = false;
    this.controlSpeechMs = 0;
    this.stage('readback_playback_checked');
    return transcript;
  }

  get readbackIsCurrent(): boolean {
    return (
      !this.closed &&
      this.approvedReadbackRevision !== undefined &&
      this.approvedReadbackRevision === this.callerRevision
    );
  }

  interruptReadback(): void {
    if (!this.controlled) return;
    this.readbackFailed = true;
    this.approvedReadbackRevision = undefined;
    this.callerRevision += 1;
    this.readback?.cancel();
  }

  played(mark: string): void {
    if (this.closed) return;
    const bytes = this.marks.get(mark);
    if (bytes === undefined) return;
    this.queuedOutputBytes -= bytes;
    this.marks.delete(mark);
  }

  private playbackAndTranscriptDrained(): boolean {
    return (
      this.marks.size === 0 && !this.pendingFragments.some((entry) => entry.role === 'assistant')
    );
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

  private stage(code: LiveWorkflowStage): void {
    try {
      this.options.onStage?.(code);
    } catch {
      // Static observability cannot affect authorization, playback or cleanup.
    }
  }

  private protocolFailure(code: LiveProtocolFailure): void {
    // Only fixed reason codes cross the diagnostic boundary; rejected text,
    // event identifiers, audio and raw validation/provider errors never do.
    this.stage(code);
    this.close('provider_protocol_error');
  }

  private capture(event: VoiceTranscriptEvent): void {
    if (!this.options.onTranscript) return;
    try {
      // A caller may supply an asynchronous sink despite the void callback
      // contract. Do not await it on the audio loop or leak a rejected promise.
      void Promise.resolve(this.options.onTranscript(event)).catch(() => {});
    } catch {
      // Optional capture cannot change audio, consent or control execution.
    }
  }

  private cancelBackend(): void {
    const active = this.activeDelegation;
    if (!active || active.controller.signal.aborted) return;
    this.stage('backend_stale');
    this.stage('backend_cancelled');
    active.controller.abort();
  }

  private settleDelegations(): void {
    if (this.delegateTimer) clearTimeout(this.delegateTimer);
    this.delegateTimer = undefined;
    for (const task of this.delegations.values()) task.state = 'settled';
  }

  close(reason?: RelayDiagnosticCode): void {
    if (this.closed) return;
    this.closed = true;
    this.readback?.cancel();
    this.readback = undefined;
    this.recoveryBoundary?.cancel();
    this.recoveryBoundary = undefined;
    if (reason) {
      try {
        this.options.onDiagnostic?.(reason);
      } catch {
        /* diagnostics cannot prevent cleanup */
      }
    }
    if (this.delegateTimer) clearTimeout(this.delegateTimer);
    if (this.delegateDeadline) clearTimeout(this.delegateDeadline);
    if (this.activeDelegation && !this.activeDelegation.controller.signal.aborted) {
      if (this.activeDelegation.task.state === 'running') this.stage('backend_cancelled');
      this.activeDelegation.controller.abort();
    }
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
