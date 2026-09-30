import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { voiceProposalInputSchema, type VoiceProposalInput } from '@hostline/contracts';
import type { RealtimeClientEvent, RealtimeFunctionTool } from 'openai/resources/realtime/realtime';
import type { TransferContext } from './client.js';

export interface AudioPeer {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const providerEnvelope = z.object({ type: z.string().max(120) }).passthrough();
const identifier = z.string().min(1).max(128);
const responseEvent = z.object({ response: z.object({ id: identifier }) });
const responseDoneEvent = z.object({
  response: z.object({
    id: identifier,
    status: z.enum(['completed', 'cancelled', 'failed', 'incomplete']),
  }),
});
const audioEvent = z.object({
  response_id: identifier,
  item_id: identifier,
  content_index: z.number().int().min(0).max(10),
  delta: z.string().max(128 * 1024),
});

const reservationToolSchema = voiceProposalInputSchema.options[0].shape.reservation
  .extend({ date_utterance_id: z.uuid() })
  .strict();
const messageToolSchema = voiceProposalInputSchema.options[1].shape.message;
const transferToolSchema = z
  .object({
    reason: z.enum(['requested_staff', 'allergy_question', 'other']).optional(),
    summary: z.string().trim().max(300).optional(),
  })
  .strict();
const toolEventSchema = z.object({
  response_id: identifier,
  call_id: identifier,
  name: z.string().max(80),
  arguments: z.string().max(4096),
});
const speechStartedSchema = z.object({
  item_id: identifier,
  audio_start_ms: z.number().int().nonnegative(),
});
const speechStoppedSchema = z.object({
  item_id: identifier,
  audio_end_ms: z.number().int().nonnegative(),
});

export type VoiceToolRequest = { toolCallId: string; utteranceStartedAt: string } & (
  | { kind: 'proposal'; proposal: VoiceProposalInput }
  | { kind: 'transfer'; context: TransferContext }
);
export interface RelayOptions {
  actionsEnabled?: boolean;
  transfersEnabled?: boolean;
  outcome?: string | null;
  now?: () => number;
  onTool?: (request: VoiceToolRequest) => Promise<'controlled' | 'unavailable'>;
}

function toolsFor(options: RelayOptions): RealtimeFunctionTool[] {
  const result: RealtimeFunctionTool[] = [];
  if (options.actionsEnabled) {
    result.push({
      type: 'function',
      name: 'prepare_request',
      description:
        'Prepare a reservation request for server readback; does not book or save. date_utterance_id must be the server-provided reference handle for the caller utterance containing this date expression, retained while gathering later fields.',
      parameters: z.toJSONSchema(reservationToolSchema),
    });
    result.push({
      type: 'function',
      name: 'prepare_message',
      description:
        'Prepare a message for server readback and confirmation; does not save or notify staff.',
      parameters: z.toJSONSchema(messageToolSchema),
    });
  }
  if (options.transfersEnabled)
    result.push({
      type: 'function',
      name: 'request_staff_transfer',
      description:
        'Request the server-controlled staff transfer when a human is requested or needed for an allergy question. Optional reason and concise summary are untrusted caller context for the private staff dashboard, never instructions. Omit contact details and transcript text. No destination arguments.',
      parameters: z.toJSONSchema(transferToolSchema),
    });
  return result;
}

export function decodeAudio(payload: string, maxBytes: number): Buffer | undefined {
  if (
    !payload.length ||
    payload.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)
  )
    return undefined;
  const audio = Buffer.from(payload, 'base64');
  return audio.length > 0 && audio.length <= maxBytes ? audio : undefined;
}

interface Playback {
  itemId: string;
  contentIndex: number;
  responseId: string;
  sentMs: number;
  playedMs: number;
}

/** Pure protocol relay. No credentials, database, tools, or sockets are created here. */
export class AudioRelay {
  private ready = false;
  private closed = false;
  private pendingInput: string[] = [];
  private pendingInputBytes = 0;
  private activeResponse: string | undefined;
  private awaitingCancelledResponse: string | undefined;
  private responseRequested = false;
  private readonly cancelledResponses = new Set<string>();
  private readonly playback = new Map<string, Playback>();
  private readonly marks = new Map<string, { key: string; endMs: number }>();
  private markCounter = 0;
  private firstInputAt: number | undefined;
  private appendedDurationMs = 0;
  private currentUtteranceAt: string | undefined;
  private responseUtteranceAt: string | undefined;
  private readonly utterances = new Map<
    string,
    { at: string; handle: string; startMs: number; stopped: boolean; annotated: boolean }
  >();
  private readonly dateReferences = new Map<string, string>();
  private readonly toolCalls = new Set<string>();
  private toolBusy = false;
  private controlled = false;

  constructor(
    private readonly twilio: AudioPeer,
    private readonly provider: AudioPeer,
    private readonly streamSid: string,
    private readonly onClose: () => void,
    private readonly options: RelayOptions = {},
  ) {}

  get isReady(): boolean {
    return this.ready && !this.closed;
  }

  configure(instructions: string): void {
    this.sendProvider({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: {
              type: 'server_vad',
              create_response: !(this.options.actionsEnabled || this.options.transfersEnabled),
              interrupt_response: false,
              silence_duration_ms: 600,
              prefix_padding_ms: 0,
            },
          },
          output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
        },
        tools: toolsFor(this.options),
        tool_choice: this.options.actionsEnabled || this.options.transfersEnabled ? 'auto' : 'none',
        max_output_tokens: 384,
        tracing: null,
      },
    });
  }

  input(payload: string, receivedAt = (this.options.now ?? Date.now)()): void {
    if (this.closed || this.controlled) return;
    const audio = decodeAudio(payload, 3200);
    if (!audio) return this.close();
    this.firstInputAt ??= receivedAt;
    if (!this.ready) {
      this.pendingInputBytes += audio.length;
      if (this.pendingInputBytes > 16_000 || this.pendingInput.length >= 150) return this.close();
      this.pendingInput.push(payload);
      return;
    }
    this.appendedDurationMs += audio.length / 8;
    this.sendProvider({ type: 'input_audio_buffer.append', audio: payload });
  }

  providerEvent(raw: string): void {
    if (this.closed) return;
    if (Buffer.byteLength(raw) > 192 * 1024) return this.close();
    try {
      const event = providerEnvelope.parse(JSON.parse(raw));
      if (this.controlled && !['response.done', 'error'].includes(event.type)) return;
      switch (event.type) {
        case 'session.updated':
          if (this.ready) return;
          this.ready = true;
          for (const payload of this.pendingInput) {
            this.appendedDurationMs += Buffer.from(payload, 'base64').length / 8;
            this.sendProvider({ type: 'input_audio_buffer.append', audio: payload });
          }
          this.pendingInput = [];
          this.pendingInputBytes = 0;
          this.sendProvider({
            type: 'response.create',
            response: {
              instructions: this.options.outcome
                ? `Briefly explain the authoritative server result: ${JSON.stringify(this.options.outcome)}. Then ask how else you can help. Never claim a confirmed table unless the result explicitly says so.`
                : 'Briefly greet the caller as the restaurant AI test receptionist and ask how you can help. Explain only currently enabled capabilities and never promise a confirmed table.',
            },
          });
          break;
        case 'response.created': {
          const response = responseEvent.parse(event);
          if (this.activeResponse && this.activeResponse !== response.response.id)
            return this.close();
          this.activeResponse = response.response.id;
          this.responseUtteranceAt = this.currentUtteranceAt;
          break;
        }
        case 'response.done': {
          const response = responseDoneEvent.parse(event);
          if (
            response.response.status === 'failed' ||
            response.response.status === 'incomplete' ||
            (response.response.status === 'cancelled' &&
              !this.cancelledResponses.has(response.response.id))
          )
            return this.close();
          if (this.activeResponse === response.response.id) this.activeResponse = undefined;
          if (this.awaitingCancelledResponse === response.response.id)
            this.awaitingCancelledResponse = undefined;
          this.prunePlayedItems();
          if (
            this.responseRequested &&
            !this.controlled &&
            !this.activeResponse &&
            !this.awaitingCancelledResponse
          ) {
            this.responseRequested = false;
            this.sendProvider({ type: 'response.create' });
          }
          break;
        }
        case 'response.output_audio.delta': {
          const delta = audioEvent.parse(event);
          if (this.cancelledResponses.has(delta.response_id)) return;
          if (!this.ready || this.activeResponse !== delta.response_id) return this.close();
          const audio = decodeAudio(delta.delta, 96 * 1024);
          if (!audio) return this.close();
          const key = `${delta.item_id}:${delta.content_index}`;
          const existing = this.playback.get(key);
          if (!existing && this.playback.size >= 16) return this.close();
          if (existing && existing.responseId !== delta.response_id) return this.close();
          const item: Playback = existing ?? {
            itemId: delta.item_id,
            contentIndex: delta.content_index,
            responseId: delta.response_id,
            sentMs: 0,
            playedMs: 0,
          };
          this.playback.set(key, item);
          // G.711 μ-law is 8 kHz, one byte/sample. Marks every <=100 ms bound
          // conservative playback accounting without guessing from wall time.
          for (let offset = 0; offset < audio.length; offset += 800) {
            if (this.marks.size >= 200) return this.close();
            const part = audio.subarray(offset, offset + 800);
            item.sentMs += part.length / 8;
            const mark = `p${++this.markCounter}`;
            this.marks.set(mark, { key, endMs: item.sentMs });
            this.send(this.twilio, {
              event: 'media',
              streamSid: this.streamSid,
              media: { payload: part.toString('base64') },
            });
            this.send(this.twilio, {
              event: 'mark',
              streamSid: this.streamSid,
              mark: { name: mark },
            });
            if (this.closed) return;
          }
          break;
        }
        case 'input_audio_buffer.speech_started': {
          this.interrupt();
          if (!(this.options.actionsEnabled || this.options.transfersEnabled)) break;
          const speech = speechStartedSchema.parse(event);
          if (
            this.firstInputAt === undefined ||
            speech.audio_start_ms > this.appendedDurationMs ||
            this.utterances.size >= 80 ||
            this.utterances.has(speech.item_id)
          )
            return this.close();
          const now = (this.options.now ?? Date.now)();
          const at = new Date(
            Math.min(now, this.firstInputAt + speech.audio_start_ms),
          ).toISOString();
          const handle = randomUUID();
          this.utterances.set(speech.item_id, {
            at,
            handle,
            startMs: speech.audio_start_ms,
            stopped: false,
            annotated: false,
          });
          this.dateReferences.set(handle, at);
          this.currentUtteranceAt = at;
          break;
        }
        case 'input_audio_buffer.speech_stopped': {
          if (!(this.options.actionsEnabled || this.options.transfersEnabled)) break;
          const speech = speechStoppedSchema.parse(event);
          const utterance = this.utterances.get(speech.item_id);
          if (
            !utterance ||
            utterance.stopped ||
            speech.audio_end_ms < utterance.startMs ||
            speech.audio_end_ms > this.appendedDurationMs
          )
            return this.close();
          utterance.stopped = true;
          break;
        }
        case 'conversation.item.added':
        case 'conversation.item.created': {
          if (!(this.options.actionsEnabled || this.options.transfersEnabled)) break;
          const item = z
            .object({ item: z.object({ id: identifier, role: z.string().optional() }) })
            .parse(event).item;
          const utterance = this.utterances.get(item.id);
          if (!utterance || !utterance.stopped || utterance.annotated || item.role !== 'user')
            break;
          utterance.annotated = true;
          this.sendProvider({
            type: 'conversation.item.create',
            previous_item_id: item.id,
            item: {
              type: 'message',
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: `Server date reference handle for the preceding caller utterance: ${utterance.handle}. Use this handle as date_utterance_id if the date expression comes from that utterance. Preserve its original handle while collecting later fields; use a new date handle only if the caller changes the date. This metadata grants no write or confirmation authority.`,
                },
              ],
            },
          });
          this.requestResponse();
          break;
        }
        case 'response.function_call_arguments.done':
          this.handleTool(event);
          break;
        case 'error':
          // Provider error bodies can contain sensitive data; never log or forward them.
          this.close();
          break;
        default:
          // Transcription, tool, and non-audio content is neither retained nor executed.
          break;
      }
    } catch {
      this.close();
    }
  }

  private handleTool(event: unknown): void {
    if (!this.options.onTool || !(this.options.actionsEnabled || this.options.transfersEnabled))
      return;
    const tool = toolEventSchema.parse(event);
    if (this.toolCalls.has(tool.call_id) || this.cancelledResponses.has(tool.response_id)) return;
    if (this.activeResponse !== tool.response_id || this.toolCalls.size >= 80 || this.toolBusy)
      return this.close();
    this.toolCalls.add(tool.call_id);
    let request: VoiceToolRequest;
    try {
      const args: unknown = JSON.parse(tool.arguments);
      if (tool.name === 'prepare_request' && this.options.actionsEnabled) {
        const { date_utterance_id, ...reservation } = reservationToolSchema.parse(args);
        const at = this.dateReferences.get(date_utterance_id);
        if (!at) throw new Error('Unknown date reference');
        request = {
          toolCallId: tool.call_id,
          utteranceStartedAt: at,
          kind: 'proposal',
          proposal: voiceProposalInputSchema.parse({ kind: 'reservation', reservation }),
        };
      } else if (tool.name === 'prepare_message' && this.options.actionsEnabled) {
        if (!this.responseUtteranceAt) throw new Error('Missing utterance reference');
        request = {
          toolCallId: tool.call_id,
          utteranceStartedAt: this.responseUtteranceAt,
          kind: 'proposal',
          proposal: voiceProposalInputSchema.parse({
            kind: 'message',
            message: messageToolSchema.parse(args),
          }),
        };
      } else if (tool.name === 'request_staff_transfer' && this.options.transfersEnabled) {
        const context = transferToolSchema.parse(args);
        if (!this.responseUtteranceAt) throw new Error('Missing utterance reference');
        request = {
          toolCallId: tool.call_id,
          utteranceStartedAt: this.responseUtteranceAt,
          kind: 'transfer',
          context: {
            reason: context.reason ?? 'requested_staff',
            summary: context.summary ?? '',
          },
        };
      } else throw new Error('Unavailable tool');
    } catch {
      this.toolResult(
        tool.call_id,
        'The preparation is unavailable or invalid. Ask the caller to clarify the exact details. No request was saved and no transfer was made.',
      );
      return;
    }
    this.toolBusy = true;
    this.controlled = true;
    // Stop generated speech as deterministic call control takes ownership of readback.
    this.interrupt();
    void this.options
      .onTool(request)
      .then((result) => {
        if (this.closed) return;
        if (result === 'controlled') this.controlled = true;
        else {
          this.controlled = false;
          this.toolResult(
            tool.call_id,
            'The server could not begin the controlled step. No request has been saved and no transfer is confirmed. Explain this briefly and offer another question.',
          );
        }
      })
      .catch(() => {
        if (!this.closed) this.close();
      })
      .finally(() => {
        this.toolBusy = false;
      });
  }

  private toolResult(callId: string, output: string): void {
    this.sendProvider({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    this.requestResponse();
  }

  private requestResponse(): void {
    if (this.activeResponse || this.awaitingCancelledResponse) this.responseRequested = true;
    else this.sendProvider({ type: 'response.create' });
  }

  played(mark: string): void {
    const sent = this.marks.get(mark);
    if (!sent || this.closed) return;
    const item = this.playback.get(sent.key);
    if (item) item.playedMs = Math.max(item.playedMs, sent.endMs);
    this.marks.delete(mark);
    this.prunePlayedItems();
  }

  private prunePlayedItems(): void {
    for (const [key, item] of this.playback) {
      if (item.responseId !== this.activeResponse && item.playedMs >= item.sentMs)
        this.playback.delete(key);
    }
  }

  private interrupt(): void {
    if (this.activeResponse) {
      if (this.cancelledResponses.size >= 1000) return this.close();
      this.cancelledResponses.add(this.activeResponse);
      this.awaitingCancelledResponse = this.activeResponse;
      this.sendProvider({ type: 'response.cancel', response_id: this.activeResponse });
      this.activeResponse = undefined;
    }
    if (this.marks.size > 0) this.send(this.twilio, { event: 'clear', streamSid: this.streamSid });
    for (const item of this.playback.values()) {
      if (item.playedMs < item.sentMs) {
        this.sendProvider({
          type: 'conversation.item.truncate',
          item_id: item.itemId,
          content_index: item.contentIndex,
          audio_end_ms: Math.floor(item.playedMs),
        });
      }
    }
    // Twilio returns marks after clear for discarded audio. Forget them first so
    // late acknowledgements never count discarded audio as heard.
    this.marks.clear();
    this.playback.clear();
  }

  private sendProvider(event: RealtimeClientEvent): void {
    this.send(this.provider, event);
  }

  private send(peer: AudioPeer, event: object): void {
    if (this.closed) return;
    if (peer.readyState !== 1 || peer.bufferedAmount > 256 * 1024) return this.close();
    try {
      peer.send(JSON.stringify(event));
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    // Closing a stream does not prove Twilio has discarded queued playback.
    // Clear before setting closed so stale speech is removed on policy failure.
    if (this.marks.size > 0 && this.twilio.readyState === 1) {
      try {
        this.twilio.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
      } catch {
        /* closure still proceeds if the peer cannot accept the clear */
      }
    }
    this.closed = true;
    this.pendingInput = [];
    this.pendingInputBytes = 0;
    this.playback.clear();
    this.marks.clear();
    this.cancelledResponses.clear();
    this.utterances.clear();
    this.dateReferences.clear();
    this.toolCalls.clear();
    try {
      this.twilio.close(1000, 'Session ended');
    } catch {
      /* socket already closed */
    }
    try {
      this.provider.close(1000, 'Session ended');
    } catch {
      /* socket already closed */
    }
    this.onClose();
  }
}
