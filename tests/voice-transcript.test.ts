import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVoiceTranscriptRecorder,
  type VoiceTranscriptEvent,
} from '../packages/observability/src/index.js';

const DAY = 24 * 60 * 60 * 1000;
const callId = '11111111-1111-4111-8111-111111111111';
const otherCallId = '22222222-2222-4222-8222-222222222222';
const generation = '33333333-3333-4333-8333-333333333333';
const speech: VoiceTranscriptEvent = {
  kind: 'speech',
  source: 'caller',
  text: 'Synthetic request',
  startMs: 100,
  endMs: 200,
};
const roots: string[] = [];
const recorders: Array<Awaited<ReturnType<typeof createVoiceTranscriptRecorder>>> = [];

async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'hostline-transcript-test-')));
  roots.push(path);
  return path;
}
async function recorder(
  directory: string,
  options: Partial<Parameters<typeof createVoiceTranscriptRecorder>[0]> = {},
) {
  const value = await createVoiceTranscriptRecorder({ directory, source: 'gateway', ...options });
  recorders.push(value);
  return value;
}
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(path);
  }
  return result.sort();
}
async function rows(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
async function ownedFixture(directory: string, created: number, slot = 'slot-00') {
  const component = join(directory, 'gateway');
  await mkdir(join(component, slot), { recursive: true, mode: 0o700 });
  const path = join(component, slot, `voice-${created}-${callId}-0123456789abcdef.jsonl`);
  await writeFile(path, 'synthetic old data\n', { mode: 0o600 });
  return path;
}

afterEach(async () => {
  for (const value of recorders.splice(0)) await value.close();
  vi.useRealTimers();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('opt-in local voice transcript storage', () => {
  it('writes private JSONL with explicit event fields and joins API/gateway generations by call', async () => {
    const directory = join(await root(), 'debug');
    const now = Date.now();
    const gateway = await recorder(directory, { now: () => now });
    const api = await recorder(directory, { source: 'api', now: () => now });
    gateway.record(callId, speech, generation);
    gateway.record(otherCallId, {
      kind: 'backend_reply',
      text: 'Which day?',
      awaitingCaller: true,
    });
    api.record(
      callId,
      { kind: 'server_readback', text: 'Synthetic canonical readback.' },
      generation,
    );
    await Promise.all([gateway.flush(), api.flush()]);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    const paths = await files(directory);
    expect(paths).toHaveLength(3);
    const all = [];
    for (const path of paths) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(path, '..'))).mode & 0o777).toBe(0o700);
      const records = await rows(path);
      expect(records).toHaveLength(1);
      all.push(...records);
    }
    expect(all).toContainEqual({
      formatVersion: 1,
      callId,
      component: 'gateway',
      generation,
      time: new Date(now).toISOString(),
      event: speech,
    });
    expect(
      all
        .filter((row) => row.callId === callId)
        .map((row) => row.component)
        .sort(),
    ).toEqual(['api', 'gateway']);
    expect(all.find((row) => row.callId === otherCallId)).not.toHaveProperty('generation');
  });

  it('keeps each process writer in a distinct file even for the same call', async () => {
    const directory = await root();
    const first = await recorder(directory);
    const second = await recorder(directory);
    first.record(callId, { kind: 'confirmation', text: 'No, that is incorrect.' }, generation);
    second.record(callId, { kind: 'server_outcome', text: 'No request was saved.' }, generation);
    await Promise.all([first.flush(), second.flush()]);
    const paths = await files(directory);
    expect(paths).toHaveLength(2);
    expect(new Set(paths.map((path) => path.split('-').at(-1))).size).toBe(2);
    expect(
      (await Promise.all(paths.map(rows)))
        .flat()
        .map((row) => row.event.kind)
        .sort(),
    ).toEqual(['confirmation', 'server_outcome']);
  });

  it('serializes ordered snapshots without retaining later event mutations', async () => {
    const directory = await root();
    const value = await recorder(directory);
    const event: VoiceTranscriptEvent = { ...speech };
    value.record(callId, event);
    event.text = 'Changed after record';
    value.record(callId, {
      kind: 'tool_proposal',
      tool: 'prepare_request',
      text: '{"kind":"synthetic"}',
    });
    await value.flush();
    expect((await rows((await files(directory))[0]!)).map((row) => row.event.text)).toEqual([
      'Synthetic request',
      '{"kind":"synthetic"}',
    ]);
  });

  it('records uppercase control failures and verified empty confirmation without fabricating speech', async () => {
    const directory = await root();
    const diagnostic = vi.fn();
    const value = await recorder(directory, { onDiagnostic: diagnostic });
    value.record(callId, { kind: 'stage', code: 'CALL_BUDGET_EXCEEDED' }, generation);
    value.record(callId, { kind: 'confirmation', text: '' }, generation);
    value.record(callId, { ...speech, text: '' }, generation);
    await value.flush();
    expect((await rows((await files(directory))[0]!)).map((row) => row.event)).toEqual([
      { kind: 'stage', code: 'CALL_BUDGET_EXCEEDED' },
      { kind: 'confirmation', text: '' },
    ]);
    expect(diagnostic.mock.calls).toEqual([['voice_transcript_invalid_event']]);
  });

  it('preserves optional confirmation confidence and single-key digits without changing speech', async () => {
    const directory = await root();
    const diagnostic = vi.fn();
    const value = await recorder(directory, { onDiagnostic: diagnostic });
    const events: VoiceTranscriptEvent[] = [
      { kind: 'confirmation', text: 'Yes.' },
      { kind: 'confirmation', text: '', confidence: 0 },
      { kind: 'confirmation', text: 'Yes please', confidence: 1 },
      { kind: 'confirmation', text: ' No, correct that. ', confidence: 0.72, digits: '' },
      { kind: 'confirmation', text: '', digits: '0' },
      { kind: 'confirmation', text: '', digits: '9' },
      { kind: 'confirmation', text: '', digits: '*' },
      { kind: 'confirmation', text: '', confidence: 0.8, digits: '#' },
    ];
    for (const event of events) value.record(callId, event, generation);
    await value.flush();
    expect((await rows((await files(directory))[0]!)).map((row) => row.event)).toEqual(events);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('drops invalid confirmation metadata without putting caller content in diagnostics', async () => {
    const directory = await root();
    const diagnostic = vi.fn();
    const value = await recorder(directory, { onDiagnostic: diagnostic });
    const privateText = 'Synthetic caller +12125550111 requests a correction.';
    const metadata = [
      ...[-0.001, 1.001, Number.NaN, Infinity, -Infinity, '0.9', null, undefined].map(
        (confidence) => ({ confidence }),
      ),
      ...['12', '+', 'a', ' ', 1, null, undefined].map((digits) => ({ digits })),
      { confidence: 0.9, digits: '#', providerCallSid: 'synthetic-provider-id' },
      { confidence: 0.9, authorization: 'synthetic-secret' },
    ];
    for (const fields of metadata) {
      // Deliberately exercise optional-field validation at the runtime boundary.
      value.record(callId, {
        kind: 'confirmation',
        text: privateText,
        ...fields,
      } as VoiceTranscriptEvent);
    }
    await value.flush();
    expect(await files(directory)).toEqual([]);
    expect(diagnostic.mock.calls).toEqual(metadata.map(() => ['voice_transcript_invalid_event']));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /Synthetic caller|12125550111|synthetic-provider-id|synthetic-secret/,
    );
  });

  it('requires confirmation text and keeps metadata and empty text out of other event kinds', async () => {
    const directory = await root();
    const diagnostic = vi.fn();
    const value = await recorder(directory, { onDiagnostic: diagnostic });
    const invalid = [
      { kind: 'confirmation', confidence: 0.9 },
      { kind: 'confirmation', text: 42 },
      { kind: 'server_readback', text: 'Readback', confidence: 0.9 },
      { kind: 'server_outcome', text: 'Outcome', digits: '1' },
      { ...speech, confidence: 0.9 },
      { kind: 'server_readback', text: '' },
      { kind: 'server_outcome', text: '' },
      { kind: 'backend_reply', text: '', awaitingCaller: true },
      { kind: 'tool_proposal', tool: 'prepare_request', text: '' },
    ];
    for (const event of invalid) value.record(callId, event as VoiceTranscriptEvent);
    await value.flush();
    expect(await files(directory)).toEqual([]);
    expect(diagnostic.mock.calls).toEqual(invalid.map(() => ['voice_transcript_invalid_event']));
  });

  it('contains a rejected asynchronous diagnostic callback', async () => {
    const directory = await root();
    const diagnostic = vi.fn(async () => {
      throw new Error('Synthetic diagnostic error');
    });
    const value = await recorder(directory, { onDiagnostic: diagnostic });
    value.record('not-a-call', speech);
    await value.flush();
    await Promise.resolve();
    expect(diagnostic).toHaveBeenCalledWith('voice_transcript_invalid_event');
    expect(await files(directory)).toEqual([]);
  });

  it.each(['../../outside', `CA${'a'.repeat(32)}`, 'not-a-uuid'])(
    'rejects non-call identifiers and paths: %s',
    async (id) => {
      const directory = await root();
      const diagnostic = vi.fn();
      const value = await recorder(directory, { onDiagnostic: diagnostic });
      value.record(id, speech);
      value.record(callId, speech, id);
      await value.flush();
      expect(await files(directory)).toEqual([]);
      expect(diagnostic.mock.calls).toEqual([
        ['voice_transcript_invalid_event'],
        ['voice_transcript_invalid_event'],
      ]);
    },
  );

  it('rejects extra provider/audio/credential fields, oversized text, invalid tools and stage data', async () => {
    const directory = await root();
    const diagnostic = vi.fn();
    const value = await recorder(directory, { onDiagnostic: diagnostic });
    const invalid = [
      { ...speech, providerCallSid: 'synthetic-provider-id' },
      { ...speech, audio: 'synthetic-audio' },
      { ...speech, authorization: 'synthetic-secret' },
      { ...speech, text: 'x'.repeat(16 * 1024 + 1) },
      { ...speech, startMs: -1 },
      { ...speech, endMs: 99 },
      { ...speech, source: 'provider' },
      { kind: 'tool_proposal', tool: 'save_request', text: 'not allowed' },
      { kind: 'stage', code: 'private data\n123' },
      { kind: 'backend_reply', text: 'Question?', awaitingCaller: 'true' },
    ];
    for (const event of invalid) {
      // Deliberately exercise a runtime trust boundary with malformed input.
      value.record(callId, event as VoiceTranscriptEvent);
    }
    await value.flush();
    expect(await files(directory)).toEqual([]);
    expect(diagnostic).toHaveBeenCalledTimes(invalid.length);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /synthetic-secret|synthetic-provider-id|private data/,
    );
  });

  it('removes only expired owned files at startup despite a refreshed modification time', async () => {
    const directory = await root();
    const now = Date.now();
    const expired = await ownedFixture(directory, now - DAY);
    await utimes(expired, new Date(now), new Date(now));
    const current = await ownedFixture(directory, now - DAY + 1, 'slot-01');
    const unrelated = join(directory, 'gateway', 'slot-02');
    await mkdir(unrelated, { mode: 0o700 });
    await writeFile(join(unrelated, 'notes.jsonl'), 'leave unrelated content');
    await recorder(directory, { now: () => now });
    await expect(lstat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(current, 'utf8')).toBe('synthetic old data\n');
    expect(await readFile(join(unrelated, 'notes.jsonl'), 'utf8')).toBe('leave unrelated content');
  });

  it('expires active files on the minute cleanup without extending retention on later writes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const directory = await root();
    let now = Date.now();
    const value = await recorder(directory, { now: () => now });
    value.record(callId, speech);
    await value.flush();
    const original = (await files(directory))[0]!;
    now += DAY - 1;
    value.record(callId, { kind: 'stage', code: 'later_event' });
    await value.flush();
    expect(await rows(original)).toHaveLength(2);
    now += 1;
    await vi.advanceTimersByTimeAsync(60_000);
    await value.flush();
    expect(await files(directory)).toEqual([]);
  });

  it('allows concurrent startup cleanup without disabling either writer', async () => {
    const directory = await root();
    const now = Date.now();
    await ownedFixture(directory, now - DAY);
    const diagnostic = vi.fn();
    const [first, second] = await Promise.all([
      recorder(directory, { now: () => now, onDiagnostic: diagnostic }),
      recorder(directory, { now: () => now, onDiagnostic: diagnostic }),
    ]);
    first.record(callId, speech);
    second.record(otherCallId, speech);
    await Promise.all([first.flush(), second.flush()]);
    expect(await files(directory)).toHaveLength(2);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('caps each call file at 256KiB without starting a replacement file', async () => {
    const directory = await root();
    const diagnostic = vi.fn();
    const value = await recorder(directory, { onDiagnostic: diagnostic });
    for (let index = 0; index < 40; index += 1) {
      value.record(callId, { kind: 'server_readback', text: 'x'.repeat(12_000) });
      await value.flush();
    }
    const paths = await files(directory);
    expect(paths).toHaveLength(1);
    expect((await lstat(paths[0]!)).size).toBeLessThanOrEqual(256 * 1024);
    expect((await rows(paths[0]!)).length).toBeGreaterThan(10);
    expect(diagnostic).toHaveBeenCalledWith('voice_transcript_file_limit');
  });

  it.each(['events', 'bytes'] as const)(
    'bounds queued %s before filesystem work starts',
    async (bound) => {
      const directory = await root();
      const diagnostic = vi.fn();
      const value = await recorder(directory, { onDiagnostic: diagnostic });
      for (let index = 0; index < (bound === 'events' ? 600 : 60); index += 1) {
        value.record(
          callId,
          bound === 'events'
            ? { kind: 'stage', code: 'synthetic_event' }
            : { kind: 'server_outcome', text: 'x'.repeat(12_000) },
        );
      }
      await value.flush();
      const records = await rows((await files(directory))[0]!);
      expect(records.length).toBeLessThanOrEqual(bound === 'events' ? 512 : 43);
      expect(diagnostic).toHaveBeenCalledWith('voice_transcript_queue_limit');
    },
  );

  it('atomically caps a component at 100 files across competing writers', async () => {
    const directory = await root();
    const diagnostic = vi.fn();
    const first = await recorder(directory, { onDiagnostic: diagnostic });
    const second = await recorder(directory, { onDiagnostic: diagnostic });
    for (let index = 0; index < 60; index += 1) {
      first.record(randomUUID(), speech);
      second.record(randomUUID(), speech);
    }
    await Promise.all([first.flush(), second.flush()]);
    expect(await files(join(directory, 'gateway'))).toHaveLength(100);
    expect(diagnostic).toHaveBeenCalledWith('voice_transcript_file_limit');
  });

  it.each(['base', 'ancestor', 'component'] as const)(
    'does not follow a %s directory symlink',
    async (kind) => {
      const home = await root();
      const outside = join(home, 'outside');
      await mkdir(outside);
      const directory = join(home, 'debug');
      if (kind === 'component') {
        await mkdir(directory);
        await symlink(outside, join(directory, 'gateway'));
      } else await symlink(outside, directory);
      const diagnostic = vi.fn();
      const value = await recorder(kind === 'ancestor' ? join(directory, 'nested') : directory, {
        onDiagnostic: diagnostic,
      });
      expect(() => value.record(callId, speech)).not.toThrow();
      await value.flush();
      expect(await readdir(outside)).toEqual([]);
      expect(diagnostic).toHaveBeenCalledWith('voice_transcript_unavailable');
    },
  );

  it('leaves symlinks, hardlinks, special files and unknown files untouched during cleanup', async () => {
    const directory = await root();
    const now = Date.now();
    const outside = join(directory, 'outside.txt');
    await writeFile(outside, 'unrelated data');
    const filename = `voice-${now - DAY}-${callId}-0123456789abcdef.jsonl`;
    for (const index of ['00', '01', '02'])
      await mkdir(join(directory, 'gateway', `slot-${index}`), { recursive: true, mode: 0o700 });
    const symbolic = join(directory, 'gateway', 'slot-00', filename);
    const hard = join(directory, 'gateway', 'slot-01', filename);
    const fifo = join(directory, 'gateway', 'slot-02', filename);
    await symlink(outside, symbolic);
    await link(outside, hard);
    execFileSync('mkfifo', [fifo]);
    await recorder(directory, { now: () => now });
    expect((await lstat(symbolic)).isSymbolicLink()).toBe(true);
    expect((await lstat(hard)).nlink).toBe(2);
    expect((await lstat(fifo)).isFIFO()).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe('unrelated data');
  });

  it('fails safely when a component directory is replaced with a symlink after initialization', async () => {
    const directory = await root();
    const diagnostic = vi.fn(() => {
      throw new Error('Diagnostic sink failure');
    });
    const value = await recorder(directory, { onDiagnostic: diagnostic });
    await rename(join(directory, 'gateway'), join(directory, 'previous-gateway'));
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await symlink(outside, join(directory, 'gateway'));
    expect(() => value.record(callId, speech)).not.toThrow();
    await expect(value.flush()).resolves.toBeUndefined();
    expect(await readdir(outside)).toEqual([]);
    expect(diagnostic).toHaveBeenCalledWith('voice_transcript_write_failed');
  });

  it('does not append to a file made publicly readable', async () => {
    const directory = await root();
    const diagnostic = vi.fn();
    const value = await recorder(directory, { onDiagnostic: diagnostic });
    value.record(callId, speech);
    await value.flush();
    const path = (await files(directory))[0]!;
    await chmod(path, 0o644);
    value.record(callId, { kind: 'confirmation', text: 'Should not be written' });
    await value.flush();
    expect(await rows(path)).toHaveLength(1);
    expect(diagnostic).toHaveBeenCalledWith('voice_transcript_write_failed');
  });

  it('does not follow a symlink that replaces an open transcript file', async () => {
    const directory = await root();
    const diagnostic = vi.fn();
    const value = await recorder(directory, { onDiagnostic: diagnostic });
    value.record(callId, speech);
    await value.flush();
    const path = (await files(directory))[0]!;
    const outside = join(directory, 'unrelated.txt');
    await writeFile(outside, 'unrelated data');
    await rename(path, `${path}.old`);
    await symlink(outside, path);
    value.record(callId, { kind: 'confirmation', text: 'Must not reach the target' });
    await value.flush();
    expect(await readFile(outside, 'utf8')).toBe('unrelated data');
    expect(await rows(`${path}.old`)).toHaveLength(1);
    expect(diagnostic).toHaveBeenCalledWith('voice_transcript_write_failed');
  });

  it('flushes accepted events on close and ignores later records', async () => {
    const directory = await root();
    const value = await recorder(directory);
    value.record(callId, speech);
    await value.close();
    value.record(callId, { kind: 'stage', code: 'after_close' });
    await value.flush();
    expect(await rows((await files(directory))[0]!)).toHaveLength(1);
  });
});
