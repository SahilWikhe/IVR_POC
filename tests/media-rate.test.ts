import { describe, expect, it } from 'vitest';
import { MediaRateLimiter } from '../apps/voice-gateway/src/media-rate.js';

function receive(
  limiter: MediaRateLimiter,
  kind: 'media' | 'mark' | 'control',
  at: number,
  bytes = 0,
) {
  return limiter.message(at) ?? limiter.event(kind, at, bytes);
}

describe('phone media arrival budgets', () => {
  it('keeps an ordinary bidirectional call within budget through its full duration', () => {
    const limiter = new MediaRateLimiter();
    expect(receive(limiter, 'control', 0)).toBeUndefined();
    expect(receive(limiter, 'control', 0)).toBeUndefined();
    for (let at = 0; at < 600_000; at += 20) {
      expect(receive(limiter, 'media', at, 160)).toBeUndefined();
      expect(receive(limiter, 'mark', at)).toBeUndefined();
    }
  });

  it('accepts 200 playback acknowledgments plus 51 caller frames in one arrival burst', () => {
    const limiter = new MediaRateLimiter();
    for (let index = 0; index < 200; index += 1)
      expect(receive(limiter, 'mark', 1000)).toBeUndefined();
    for (let index = 0; index < 51; index += 1)
      expect(receive(limiter, 'media', 1000, 160)).toBeUndefined();
    // The previous shared 250-message window rejected this 251-message burst,
    // even though only 8,160 bytes of caller audio arrived.
  });

  it('accepts bounded catch-up followed by normal audio in the same second', () => {
    const limiter = new MediaRateLimiter();
    for (let index = 0; index < 150; index += 1)
      expect(receive(limiter, 'media', 3000, 160)).toBeUndefined();
    for (let at = 3020; at < 4000; at += 20)
      expect(receive(limiter, 'media', at, 160)).toBeUndefined();
    // The old fixed window rejected the first normal frame after 24,000 bytes.
  });

  it('keeps the same audio burst bound initially and after a long quiet period', () => {
    const limiter = new MediaRateLimiter();
    for (const at of [0, 60_000]) {
      for (let index = 0; index < 150; index += 1)
        expect(receive(limiter, 'media', at, 160)).toBeUndefined();
      expect(receive(limiter, 'media', at, 1)).toBe('media_audio_rate_limit');
    }
  });

  it('does not reset the audio budget at a wall-clock second boundary', () => {
    const limiter = new MediaRateLimiter();
    for (let index = 0; index < 150; index += 1)
      expect(receive(limiter, 'media', 999, 160)).toBeUndefined();
    expect(receive(limiter, 'media', 1000, 160)).toBe('media_audio_rate_limit');
  });

  it('rejects sustained double-speed input despite individually valid frames', () => {
    const limiter = new MediaRateLimiter();
    let limitedAt: number | undefined;
    for (let at = 0; at <= 3000; at += 10) {
      const code = receive(limiter, 'media', at, 160);
      if (code !== undefined) {
        expect(code).toBe('media_audio_rate_limit');
        limitedAt = at;
        break;
      }
    }
    expect(limitedAt).toBe(2990);
  });

  it('bounds a mark flood separately from caller media and control', () => {
    const limiter = new MediaRateLimiter();
    for (let index = 0; index < 200; index += 1)
      expect(receive(limiter, 'mark', 0)).toBeUndefined();
    expect(receive(limiter, 'mark', 0)).toBe('media_mark_rate_limit');
    expect(receive(limiter, 'media', 0, 160)).toBeUndefined();
    expect(receive(limiter, 'control', 0)).toBeUndefined();
    expect(receive(limiter, 'mark', 10)).toBeUndefined();
    expect(receive(limiter, 'mark', 10)).toBe('media_mark_rate_limit');
  });

  it('bounds tiny media and control floods even below the audio-byte ceiling', () => {
    const limiter = new MediaRateLimiter();
    for (let index = 0; index < 250; index += 1)
      expect(receive(limiter, index % 2 === 0 ? 'media' : 'control', 0, 1)).toBeUndefined();
    expect(receive(limiter, 'media', 0, 1)).toBe('media_frame_rate_limit');
    expect(receive(limiter, 'control', 4)).toBeUndefined();
    expect(receive(limiter, 'control', 4)).toBe('media_frame_rate_limit');
  });

  it('bounds all messages before parsing, including mixed or unclassified input', () => {
    const limiter = new MediaRateLimiter();
    for (let index = 0; index < 450; index += 1) expect(limiter.message(0)).toBeUndefined();
    expect(limiter.message(0)).toBe('media_message_rate_limit');
    expect(limiter.message(20)).toBeUndefined();
    for (let index = 0; index < 6; index += 1) expect(limiter.message(20)).toBeUndefined();
    expect(limiter.message(20)).toBe('media_message_rate_limit');
  });

  it('charges caller audio once and never charges marks or control as audio', () => {
    const limiter = new MediaRateLimiter();
    for (let index = 0; index < 100; index += 1) {
      expect(receive(limiter, 'media', 0, 160)).toBeUndefined();
      expect(receive(limiter, 'mark', 0, 3200)).toBeUndefined();
      expect(receive(limiter, 'control', 0, 3200)).toBeUndefined();
    }
    for (let index = 0; index < 50; index += 1)
      expect(receive(limiter, 'media', 0, 160)).toBeUndefined();
  });

  it('does not gain credit on clock rollback or repeated old timestamps', () => {
    const limiter = new MediaRateLimiter();
    for (let index = 0; index < 200; index += 1)
      expect(limiter.event('mark', 1000)).toBeUndefined();
    expect(limiter.event('mark', 900)).toBe('media_mark_rate_limit');
    expect(limiter.event('mark', 1000)).toBe('media_mark_rate_limit');
    expect(limiter.event('mark', 1010)).toBeUndefined();
    expect(limiter.event('mark', 1000)).toBe('media_mark_rate_limit');
    expect(limiter.event('mark', 1010)).toBe('media_mark_rate_limit');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'fails closed on a non-finite clock value (%s)',
    (at) => {
      const limiter = new MediaRateLimiter();
      expect(limiter.message(at)).toBe('media_message_rate_limit');
      expect(limiter.event('media', at, 160)).toBe('media_frame_rate_limit');
      expect(limiter.event('control', at)).toBe('media_frame_rate_limit');
      expect(limiter.event('mark', at)).toBe('media_mark_rate_limit');
    },
  );

  it('caps accumulated credit even after extremely large finite time jumps', () => {
    const limiter = new MediaRateLimiter();
    expect(limiter.event('mark', -Number.MAX_VALUE)).toBeUndefined();
    for (let index = 0; index < 200; index += 1)
      expect(limiter.event('mark', Number.MAX_VALUE)).toBeUndefined();
    expect(limiter.event('mark', Number.MAX_VALUE)).toBe('media_mark_rate_limit');
  });

  it.each([0, -1, 0.5, 3201, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed on an invalid decoded media byte count (%s)',
    (bytes) => {
      expect(new MediaRateLimiter().event('media', 0, bytes)).toBe('media_audio_rate_limit');
    },
  );
});
