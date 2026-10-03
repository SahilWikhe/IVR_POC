import { randomUUID } from 'node:crypto';
import { liveReadbackMatches, liveReadbackChunks } from '@hostline/contracts';

/** Local energy check, not speech recognition. PCMU includes continuous silence. */
export function audiblePcmu(audio: Uint8Array): boolean {
  let energy = 0;
  for (const sample of audio) {
    const value = ~sample & 255;
    const magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
    energy += (magnitude - 132) ** 2;
  }
  return audio.length > 0 && energy / audio.length > 240 ** 2;
}

export type LiveReadbackDiagnostic =
  | 'readback_boundary_timeout'
  | 'readback_text_mismatch'
  | 'readback_deadline'
  | 'readback_buffer_limit';

interface ReadbackHooks {
  instructions(id: string, text: string): void;
  playBuffered(audio: Uint8Array): void;
  drained(): boolean;
  now(): number;
  diagnostic?(code: LiveReadbackDiagnostic): void;
}

/**
 * Silence previous Live speech before issuing a new speaking instruction.
 * An append ACK only describes context delivery. Suppress all output until
 * acknowledged instructions are followed by observed quiet and stable text.
 */
export class LiveSpeechBoundary {
  private readonly instructionId = randomUUID();
  private acceptedAt: number | undefined;
  private quietMs = 0;
  private lastTextAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private settle: ((ready: boolean) => void) | undefined;
  private ended = false;

  constructor(
    private readonly hooks: Pick<ReadbackHooks, 'instructions' | 'now' | 'diagnostic'> & {
      drained?: () => boolean;
    },
  ) {
    this.lastTextAt = hooks.now();
  }

  run(): Promise<boolean> {
    return new Promise((resolve) => {
      this.settle = resolve;
      this.deadline = setTimeout(() => {
        this.hooks.diagnostic?.('readback_boundary_timeout');
        this.cancel();
      }, 8000);
      this.deadline.unref();
      this.timer = setInterval(() => {
        if (
          this.acceptedAt !== undefined &&
          this.quietMs >= 1000 &&
          (this.hooks.drained?.() ?? true) &&
          this.hooks.now() - this.acceptedAt >= 1000 &&
          this.hooks.now() - this.lastTextAt >= 1000
        )
          this.finish(true);
      }, 25);
      this.timer.unref();
      this.hooks.instructions(
        this.instructionId,
        'Stop speaking now. Discard any unfinished readback or answer. Stay completely silent and do not delegate until the server gives the next instruction.',
      );
    });
  }

  acknowledge(id: string): void {
    if (this.ended || this.acceptedAt !== undefined || id !== this.instructionId) return;
    this.acceptedAt = this.hooks.now();
    this.quietMs = 0;
  }

  output(audio: Uint8Array): void {
    if (this.ended || this.acceptedAt === undefined) return;
    for (let offset = 0; offset < audio.length; offset += 160) {
      const frame = audio.subarray(offset, offset + 160);
      this.quietMs = audiblePcmu(frame) ? 0 : this.quietMs + frame.length / 8;
    }
  }

  text(): void {
    if (!this.ended) this.lastTextAt = this.hooks.now();
  }

  cancel(): void {
    this.finish(false);
  }

  private finish(ready: boolean): void {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) clearInterval(this.timer);
    if (this.deadline) clearTimeout(this.deadline);
    this.settle?.(ready);
  }
}

/**
 * Conservative application gate, not a provider audio-completed event. A match
 * alone is insufficient: require audible output, trailing quiet and all current
 * playback marks. Any interruption invalidates the entire readback.
 */
export class LiveReadback {
  private readonly chunks: string[];
  private index = 0;
  private instructionId = '';
  private accepted = false;
  private transcript = '';
  private completed: string[] = [];
  private quietMs = 0;
  private audibleMs = 0;
  private lastTranscriptAt = 0;
  private lastCallerAudioAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private settle: ((text: string | null) => void) | undefined;
  private ended = false;
  private pendingAudio: Uint8Array[] = [];
  private pendingAudioBytes = 0;
  private boundary: LiveSpeechBoundary | undefined;

  constructor(
    private readonly expected: string,
    private readonly hooks: ReadbackHooks,
  ) {
    // Preserve sentence boundaries, including the complete numeric fields. Each
    // append stays below 500 UTF-8 bytes, a conservative 500-token upper bound.
    try {
      this.chunks = liveReadbackChunks(expected);
    } catch {
      this.chunks = [];
    }
  }

  run(): Promise<string | null> {
    return new Promise((resolve) => {
      this.settle = resolve;
      if (
        this.chunks.length === 0 ||
        this.chunks.length > 12 ||
        this.chunks.some((text) => Buffer.byteLength(this.command(text)) > 480)
      )
        return this.cancel();
      this.deadline = setTimeout(() => this.reject('readback_deadline'), 75_000);
      this.deadline.unref();
      this.timer = setInterval(() => this.check(), 25);
      this.timer.unref();
      const boundary = new LiveSpeechBoundary(this.hooks);
      this.boundary = boundary;
      void boundary.run().then((ready) => {
        if (this.ended) return;
        this.boundary = undefined;
        if (ready) this.next();
        else this.cancel();
      });
    });
  }

  private command(text: string): string {
    return `Read exactly this text, without additions. Then stay silent: ${JSON.stringify(text)}`;
  }

  private next(): void {
    const chunk = this.chunks[this.index];
    if (chunk === undefined) return this.finish(this.completed.join(' '));
    this.instructionId = randomUUID();
    this.accepted = false;
    this.transcript = '';
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.quietMs = 0;
    this.audibleMs = 0;
    this.hooks.instructions(this.instructionId, this.command(chunk));
  }

  acknowledge(id: string): void {
    if (this.boundary) return this.boundary.acknowledge(id);
    if (this.ended || this.accepted || id !== this.instructionId) return;
    this.accepted = true;
    const pending = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    for (const audio of pending) if (this.output(audio)) this.hooks.playBuffered(audio);
  }

  output(audio: Uint8Array): boolean {
    if (this.ended) return false;
    if (this.boundary) {
      this.boundary.output(audio);
      return false;
    }
    if (!this.accepted) {
      // Live can send the requested speech before its append acknowledgment.
      // Preserve those frames and words; dropping them can clip the readback.
      this.pendingAudioBytes += audio.length;
      if (this.pendingAudioBytes > 16_000 || this.pendingAudio.length >= 200)
        this.reject('readback_buffer_limit');
      else this.pendingAudio.push(Uint8Array.from(audio));
      return false;
    }
    if (audiblePcmu(audio)) {
      this.audibleMs += audio.length / 8;
      this.quietMs = 0;
    } else this.quietMs += audio.length / 8;
    // Stop filling Twilio's queue with continuous silence so it can drain.
    return this.quietMs < 600;
  }

  callerAudio(audio: Uint8Array): void {
    if (audiblePcmu(audio)) this.lastCallerAudioAt = this.hooks.now();
  }

  text(delta: string): void {
    if (this.ended) return;
    if (this.boundary) return this.boundary.text();
    this.transcript += delta;
    this.lastTranscriptAt = this.hooks.now();
    if (Buffer.byteLength(this.transcript) > 8000) this.reject('readback_buffer_limit');
  }

  private check(): void {
    if (
      this.ended ||
      this.boundary ||
      !this.accepted ||
      this.audibleMs < 80 ||
      this.quietMs < 600 ||
      this.hooks.now() - this.lastTranscriptAt < 250 ||
      this.hooks.now() - this.lastCallerAudioAt < 600 ||
      !this.hooks.drained()
    )
      return;
    const expected = this.chunks[this.index];
    if (!expected || !liveReadbackMatches(expected, this.transcript)) {
      if (this.quietMs >= 3000 && this.hooks.now() - this.lastTranscriptAt >= 1500)
        this.reject('readback_text_mismatch');
      return;
    }
    this.completed.push(this.transcript.trim());
    this.index += 1;
    if (
      this.index === this.chunks.length &&
      !liveReadbackMatches(this.expected, this.completed.join(' '))
    )
      return this.reject('readback_text_mismatch');
    this.next();
  }

  cancel(): void {
    this.finish(null);
  }

  private reject(code: LiveReadbackDiagnostic): void {
    this.hooks.diagnostic?.(code);
    this.cancel();
  }

  private finish(text: string | null): void {
    if (this.ended) return;
    this.ended = true;
    this.boundary?.cancel();
    this.boundary = undefined;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    if (this.timer) clearInterval(this.timer);
    if (this.deadline) clearTimeout(this.deadline);
    this.settle?.(text);
  }
}
