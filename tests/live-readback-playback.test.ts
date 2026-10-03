import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveReadback,
  LiveSpeechBoundary,
  audiblePcmu,
} from '../apps/voice-gateway/src/live-readback.js';

afterEach(() => vi.useRealTimers());

function rawFixture(text = 'Please review this message. Say yes to save.') {
  vi.useFakeTimers();
  const instructions = vi.fn<(id: string, text: string) => void>();
  const playBuffered = vi.fn<(audio: Uint8Array) => void>();
  let drained = false;
  const gate = new LiveReadback(text, {
    instructions,
    playBuffered,
    drained: () => drained,
    now: Date.now,
  });
  const settled = vi.fn();
  const done = gate.run().then(settled);
  const acknowledge = () => gate.acknowledge(instructions.mock.lastCall![0]);
  const speech = () => gate.output(Buffer.alloc(800, 0x90));
  const quiet = (milliseconds = 600) => gate.output(Buffer.alloc(milliseconds * 8, 0xff));
  return {
    gate,
    instructions,
    playBuffered,
    settled,
    done,
    acknowledge,
    speech,
    quiet,
    drain: (value = true) => {
      drained = value;
    },
  };
}

async function fixture(text?: string) {
  const f = rawFixture(text);
  if (f.instructions.mock.calls.length) {
    f.drain();
    f.acknowledge();
    f.quiet(1000);
    f.instructions.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    f.drain(false);
  }
  return f;
}

describe('Live canonical readback playback gate', () => {
  it('buffers speech that precedes the current ACK and releases it exactly once', async () => {
    const f = await fixture('Say yes to save.');
    f.gate.text('Say yes');
    f.speech();
    expect(f.playBuffered).not.toHaveBeenCalled();
    f.gate.acknowledge('old-ack');
    expect(f.playBuffered).not.toHaveBeenCalled();
    f.acknowledge();
    f.acknowledge();
    expect(f.playBuffered).toHaveBeenCalledOnce();
    f.gate.text(' to save.');
    f.quiet();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.settled).not.toHaveBeenCalled();
    f.drain();
    await vi.advanceTimersByTimeAsync(25);
    await f.done;
    expect(f.settled).toHaveBeenCalledWith('Say yes to save.');
  });

  it.each(['cancel', 'missing_ack', 'overflow'] as const)(
    'never releases pending speech after %s',
    async (scenario) => {
      const f = await fixture('Say yes to save.');
      f.gate.text('Say yes to save.');
      f.speech();
      if (scenario === 'cancel') f.gate.cancel();
      else if (scenario === 'overflow') for (let i = 0; i < 21; i++) f.speech();
      else await vi.advanceTimersByTimeAsync(75_000);
      f.acknowledge();
      await f.done;
      expect(f.playBuffered).not.toHaveBeenCalled();
      expect(f.settled).toHaveBeenCalledWith(null);
    },
  );

  it('does not let a previous chunk ACK release the next chunk', async () => {
    const f = await fixture();
    const firstAck = f.instructions.mock.lastCall![0];
    f.acknowledge();
    f.gate.text('Please review this message.');
    f.speech();
    f.quiet();
    f.drain();
    await vi.advanceTimersByTimeAsync(300);
    f.gate.text('Say yes to save.');
    f.speech();
    f.quiet();
    f.gate.acknowledge(firstAck);
    expect(f.playBuffered).not.toHaveBeenCalled();
    f.acknowledge();
    await vi.advanceTimersByTimeAsync(300);
    await f.done;
    expect(f.playBuffered).toHaveBeenCalledOnce();
    expect(f.settled).toHaveBeenCalledWith('Please review this message. Say yes to save.');
  });

  it('requires each checked chunk, audible output, trailing quiet and current playback drain', async () => {
    const f = await fixture();
    f.gate.acknowledge('unrelated');
    expect(f.speech()).toBe(false);
    f.acknowledge();
    f.gate.text('Please review this message.');
    f.speech();
    f.quiet();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.instructions).toHaveBeenCalledTimes(1);
    f.drain();
    await vi.advanceTimersByTimeAsync(25);
    expect(f.instructions).toHaveBeenCalledTimes(2);
    expect(f.settled).not.toHaveBeenCalled();
    f.acknowledge();
    f.gate.text('Say yes to save.');
    f.speech();
    f.quiet();
    await vi.advanceTimersByTimeAsync(300);
    await f.done;
    expect(f.settled).toHaveBeenCalledWith('Please review this message. Say yes to save.');
  });

  it.each([
    'Say no to save.',
    'Say yes.',
    'Say yes to save. Already saved.',
    'Old unfinished speech. Say yes to save.',
  ])('rejects mismatched, truncated or extra speech: %s', async (actual) => {
    const f = await fixture('Say yes to save.');
    f.acknowledge();
    f.gate.text(actual);
    f.speech();
    f.quiet(3100);
    f.drain();
    await vi.advanceTimersByTimeAsync(1600);
    await f.done;
    expect(f.settled).toHaveBeenCalledWith(null);
  });

  it('does not treat transcript plus silence as audible readback', async () => {
    const f = await fixture('Say yes to save.');
    f.acknowledge();
    f.gate.text('Say yes to save.');
    f.quiet();
    f.drain();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.settled).not.toHaveBeenCalled();
    f.gate.cancel();
    await f.done;
    expect(f.settled).toHaveBeenCalledWith(null);
  });

  it('holds completion during possible caller speech and cancels on interruption', async () => {
    const f = await fixture('Say yes to save.');
    f.acknowledge();
    f.gate.text('Say yes to save.');
    f.speech();
    f.quiet();
    f.drain();
    f.gate.callerAudio(Buffer.alloc(800, 0x90));
    await vi.advanceTimersByTimeAsync(300);
    expect(f.settled).not.toHaveBeenCalled();
    f.gate.cancel();
    f.gate.text('yes');
    f.speech();
    await vi.advanceTimersByTimeAsync(1000);
    await f.done;
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('expires missing acknowledgement/transcript and rejects overlong instructions', async () => {
    const f = await fixture();
    await vi.advanceTimersByTimeAsync(75_000);
    await f.done;
    expect(f.settled).toHaveBeenCalledWith(null);
    const long = await fixture('x'.repeat(1000));
    await long.done;
    expect(long.settled).toHaveBeenCalledWith(null);
    expect(long.instructions).not.toHaveBeenCalled();
  });

  it('distinguishes PCMU silence and audible samples', () => {
    expect(audiblePcmu(Buffer.alloc(800, 0xff))).toBe(false);
    expect(audiblePcmu(Buffer.alloc(800, 0x7f))).toBe(false);
    expect(audiblePcmu(Buffer.alloc(800, 0x90))).toBe(true);
  });
});

describe('Live speech boundary', () => {
  it('suppresses the old attempt tail before reading the new canonical text', async () => {
    const f = rawFixture('Please review this message.');
    f.drain();
    expect(f.instructions.mock.lastCall?.[1]).toContain('Stop speaking now');
    f.gate.text('Leftover words from a previous attempt.');
    expect(f.speech()).toBe(false);
    f.acknowledge();
    f.quiet(1000);
    await vi.advanceTimersByTimeAsync(900);
    f.gate.text('A delayed old fragment.');
    expect(f.speech()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.instructions).toHaveBeenCalledTimes(1);
    f.quiet(1000);
    await vi.advanceTimersByTimeAsync(25);
    expect(f.instructions).toHaveBeenCalledTimes(2);
    expect(f.playBuffered).not.toHaveBeenCalled();
    f.gate.text('Please review this message.');
    f.speech();
    f.acknowledge();
    f.quiet();
    f.drain();
    await vi.advanceTimersByTimeAsync(300);
    await f.done;
    expect(f.settled).toHaveBeenCalledWith('Please review this message.');
    expect(f.playBuffered).toHaveBeenCalledOnce();
  });

  it.each(['missing_ack', 'missing_audio', 'still_speaking', 'cancel'] as const)(
    'never starts the new readback when the boundary is %s',
    async (scenario) => {
      const f = rawFixture('Say yes to save.');
      f.quiet(1000); // Silence preceding the stop ACK cannot establish quiet.
      if (scenario !== 'missing_ack') f.acknowledge();
      if (scenario === 'still_speaking') f.speech();
      if (scenario === 'cancel') f.gate.cancel();
      await vi.advanceTimersByTimeAsync(8000);
      await f.done;
      expect(f.settled).toHaveBeenCalledWith(null);
      expect(f.instructions).toHaveBeenCalledTimes(1);
      expect(f.playBuffered).not.toHaveBeenCalled();
    },
  );

  it('waits for deferred old text to drain before starting the new readback', async () => {
    const f = rawFixture('Say yes to save.');
    f.acknowledge();
    f.quiet(1000);
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.instructions).toHaveBeenCalledTimes(1);
    f.gate.text('An old assistant fragment waiting for its input audio timestamp.');
    f.drain();
    await vi.advanceTimersByTimeAsync(900);
    expect(f.instructions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.instructions).toHaveBeenCalledTimes(2);
    f.gate.cancel();
    await f.done;
  });

  it('does not treat a stale or duplicate ACK as new quiet evidence', async () => {
    vi.useFakeTimers();
    const instructions = vi.fn();
    const boundary = new LiveSpeechBoundary({ instructions, now: Date.now });
    const settled = vi.fn();
    const done = boundary.run().then(settled);
    boundary.acknowledge('stale');
    boundary.output(Buffer.alloc(8000, 0xff));
    await vi.advanceTimersByTimeAsync(1100);
    expect(settled).not.toHaveBeenCalled();
    boundary.acknowledge(instructions.mock.lastCall![0]);
    boundary.output(Buffer.alloc(8000, 0xff));
    await vi.advanceTimersByTimeAsync(500);
    boundary.acknowledge(instructions.mock.lastCall![0]);
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(settled).toHaveBeenCalledExactlyOnceWith(true);
  });
});
