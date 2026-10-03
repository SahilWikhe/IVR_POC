export type MediaRateLimitCode =
  | 'media_message_rate_limit'
  | 'media_frame_rate_limit'
  | 'media_mark_rate_limit'
  | 'media_audio_rate_limit';

class TokenBucket {
  private credit: number;
  private updatedAt: number | undefined;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
  ) {
    // Milli-tokens keep ordinary integer-millisecond frame accounting exact.
    this.credit = capacity * 1000;
  }

  take(amount: number, nowMs: number): boolean {
    if (this.updatedAt !== undefined) {
      const elapsed = Math.max(0, nowMs - this.updatedAt);
      const refill = Math.min(elapsed, (this.capacity * 1000) / this.perSecond);
      this.credit = Math.min(this.capacity * 1000, this.credit + refill * this.perSecond);
    }
    this.updatedAt = nowMs;
    const cost = amount * 1000;
    if (cost > this.credit) return false;
    this.credit -= cost;
    return true;
  }
}

/** Per-socket arrival budgets; protocol, playback and buffer validation remain separate. */
export class MediaRateLimiter {
  private readonly messages = new TokenBucket(450, 350);
  private readonly frames = new TokenBucket(250, 250);
  // A clear can return all outstanding marks together. Unknown/stale marks get
  // the same bounded budget, but this never grants them playback credit.
  private readonly marks = new TokenBucket(200, 100);
  // 8 kHz mono PCMU is 8,000 bytes/sec. Allow at most three seconds of catch-up
  // credit without granting the old fixed window's sustained threefold rate.
  private readonly audio = new TokenBucket(24_000, 8_000);
  private latestTime: number | undefined;

  /** Charge every bounded incoming WebSocket message before JSON parsing. */
  message(nowMs: number): MediaRateLimitCode | undefined {
    const tick = this.monotonicTime(nowMs);
    if (tick === undefined || !this.messages.take(1, tick)) return 'media_message_rate_limit';
    return undefined;
  }

  /** Call once after schema/binding validation; decodedBytes applies only to media. */
  event(
    kind: 'media' | 'mark' | 'control',
    nowMs: number,
    decodedBytes = 0,
  ): MediaRateLimitCode | undefined {
    const tick = this.monotonicTime(nowMs);
    if (kind === 'mark') {
      if (tick === undefined || !this.marks.take(1, tick)) return 'media_mark_rate_limit';
      return undefined;
    }
    if (tick === undefined || !this.frames.take(1, tick)) return 'media_frame_rate_limit';
    if (
      kind === 'media' &&
      (!Number.isSafeInteger(decodedBytes) ||
        decodedBytes <= 0 ||
        decodedBytes > 3200 ||
        !this.audio.take(decodedBytes, tick))
    )
      return 'media_audio_rate_limit';
    return undefined;
  }

  private monotonicTime(nowMs: number): number | undefined {
    if (!Number.isFinite(nowMs)) return undefined;
    // A wall-clock rollback cannot mint credit, including between categories.
    this.latestTime = Math.max(this.latestTime ?? nowMs, nowMs);
    return this.latestTime;
  }
}
