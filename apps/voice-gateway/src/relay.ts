import { z } from 'zod';
import type { RealtimeClientEvent } from 'openai/resources/realtime/realtime';

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
  private readonly cancelledResponses = new Set<string>();
  private readonly playback = new Map<string, Playback>();
  private readonly marks = new Map<string, { key: string; endMs: number }>();
  private markCounter = 0;

  constructor(
    private readonly twilio: AudioPeer,
    private readonly provider: AudioPeer,
    private readonly streamSid: string,
    private readonly onClose: () => void,
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
              create_response: true,
              interrupt_response: false,
              silence_duration_ms: 600,
            },
          },
          output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
        },
        tools: [],
        tool_choice: 'none',
        max_output_tokens: 384,
        tracing: null,
      },
    });
  }

  input(payload: string): void {
    if (this.closed) return;
    const audio = decodeAudio(payload, 3200);
    if (!audio) return this.close();
    if (!this.ready) {
      this.pendingInputBytes += audio.length;
      if (this.pendingInputBytes > 16_000 || this.pendingInput.length >= 150) return this.close();
      this.pendingInput.push(payload);
      return;
    }
    this.sendProvider({ type: 'input_audio_buffer.append', audio: payload });
  }

  providerEvent(raw: string): void {
    if (this.closed) return;
    if (Buffer.byteLength(raw) > 192 * 1024) return this.close();
    try {
      const event = providerEnvelope.parse(JSON.parse(raw));
      switch (event.type) {
        case 'session.updated':
          if (this.ready) return;
          this.ready = true;
          for (const payload of this.pendingInput)
            this.sendProvider({ type: 'input_audio_buffer.append', audio: payload });
          this.pendingInput = [];
          this.pendingInputBytes = 0;
          this.sendProvider({
            type: 'response.create',
            response: {
              instructions:
                'Briefly greet the caller as the restaurant AI test receptionist and ask what restaurant information they need. This test cannot book or transfer calls.',
            },
          });
          break;
        case 'response.created': {
          const response = responseEvent.parse(event);
          if (this.activeResponse && this.activeResponse !== response.response.id)
            return this.close();
          this.activeResponse = response.response.id;
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
          this.prunePlayedItems();
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
        case 'input_audio_buffer.speech_started':
          this.interrupt();
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
    this.closed = true;
    this.pendingInput = [];
    this.pendingInputBytes = 0;
    this.playback.clear();
    this.marks.clear();
    this.cancelledResponses.clear();
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
