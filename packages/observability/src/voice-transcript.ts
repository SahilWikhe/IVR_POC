import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

export type VoiceTranscriptEvent =
  | { kind: 'speech'; source: 'caller' | 'assistant'; text: string; startMs: number; endMs: number }
  | { kind: 'backend_reply'; text: string; awaitingCaller: boolean }
  | {
      kind: 'tool_proposal';
      tool: 'prepare_request' | 'prepare_message' | 'request_staff_transfer';
      text: string;
    }
  | { kind: 'server_readback' | 'server_outcome'; text: string }
  | { kind: 'confirmation'; text: string; confidence?: number; digits?: string }
  | { kind: 'stage'; code: string };

export interface VoiceTranscriptSink {
  record(callId: string, event: VoiceTranscriptEvent, generation?: string): void;
}

const RETENTION_MS = 24 * 60 * 60 * 1000;
const FILE_BYTES = 256 * 1024;
const QUEUE_BYTES = 512 * 1024;
const QUEUE_EVENTS = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNED_FILE = /^voice-(\d{1,16})-([0-9a-f-]{36})-([0-9a-f]{16})\.jsonl$/;
const SLOT = /^slot-\d{2}$/;

function safeEvent(event: VoiceTranscriptEvent): VoiceTranscriptEvent {
  const keys = Object.keys(event);
  const exact = (required: string[], optional: string[] = []) => {
    if (
      required.some((key) => !keys.includes(key)) ||
      keys.some((key) => !required.includes(key) && !optional.includes(key))
    )
      throw new Error('Invalid transcript event');
  };
  const text = (allowEmpty = false) => {
    if (
      typeof event !== 'object' ||
      !('text' in event) ||
      typeof event.text !== 'string' ||
      (!allowEmpty && !event.text.length) ||
      Buffer.byteLength(event.text) > 16 * 1024
    )
      throw new Error('Invalid transcript text');
    return event.text;
  };
  switch (event.kind) {
    case 'speech':
      exact(['kind', 'source', 'text', 'startMs', 'endMs']);
      if (
        !['caller', 'assistant'].includes(event.source) ||
        !Number.isSafeInteger(event.startMs) ||
        !Number.isSafeInteger(event.endMs) ||
        event.startMs < 0 ||
        event.endMs < event.startMs ||
        event.endMs > 600_000
      )
        throw new Error('Invalid transcript interval');
      return {
        kind: 'speech',
        source: event.source,
        text: text(),
        startMs: event.startMs,
        endMs: event.endMs,
      };
    case 'backend_reply':
      exact(['kind', 'text', 'awaitingCaller']);
      if (typeof event.awaitingCaller !== 'boolean') throw new Error('Invalid transcript reply');
      return { kind: 'backend_reply', text: text(), awaitingCaller: event.awaitingCaller };
    case 'tool_proposal':
      exact(['kind', 'tool', 'text']);
      if (!['prepare_request', 'prepare_message', 'request_staff_transfer'].includes(event.tool))
        throw new Error('Invalid transcript tool');
      return { kind: 'tool_proposal', tool: event.tool, text: text() };
    case 'server_readback':
    case 'server_outcome':
      exact(['kind', 'text']);
      return { kind: event.kind, text: text() };
    case 'confirmation': {
      exact(['kind', 'text'], ['confidence', 'digits']);
      const { confidence, digits } = event;
      if (
        keys.includes('confidence') &&
        (typeof confidence !== 'number' ||
          !Number.isFinite(confidence) ||
          confidence < 0 ||
          confidence > 1)
      )
        throw new Error('Invalid confirmation confidence');
      if (keys.includes('digits') && (typeof digits !== 'string' || !/^[0-9*#]?$/.test(digits)))
        throw new Error('Invalid confirmation digits');
      return {
        kind: 'confirmation',
        text: text(true),
        ...(confidence === undefined ? {} : { confidence }),
        ...(digits === undefined ? {} : { digits }),
      };
    }
    case 'stage':
      exact(['kind', 'code']);
      if (typeof event.code !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(event.code))
        throw new Error('Invalid transcript stage');
      return { kind: 'stage', code: event.code };
    default:
      throw new Error('Invalid transcript event');
  }
}

async function directoryTree(path: string, create: boolean): Promise<void> {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe transcript directory');
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function owned(stat: { uid: number }): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

interface CallFile {
  path: string;
  slot: string;
  handle: FileHandle;
  inode: number;
  device: number;
  created: number;
  bytes: number;
  full: boolean;
}

/** Opt-in local debug data only; never forward these records to ordinary logs. */
export async function createVoiceTranscriptRecorder(options: {
  directory: string;
  source: 'api' | 'gateway';
  now?: () => number;
  onDiagnostic?: (code: string) => void;
}): Promise<VoiceTranscriptSink & { flush(): Promise<void>; close(): Promise<void> }> {
  const diagnose = (code: string) => {
    try {
      void Promise.resolve(options.onDiagnostic?.(code)).catch(() => undefined);
    } catch {
      /* Debugging cannot break a call. */
    }
  };
  const now = options.now ?? Date.now;
  const base = resolve(options.directory);
  const component = join(base, options.source);
  const nonce = randomBytes(8).toString('hex');
  const calls = new Map<string, CallFile>();
  let closed = false;
  let disabled = false;
  let queuedBytes = 0;
  let queuedEvents = 0;
  let tail = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let cleanupQueued = false;
  let baseIdentity: { ino: number; dev: number };
  let componentIdentity: { ino: number; dev: number };

  const safeDirectories = async () => {
    await directoryTree(component, false);
    const [root, directory] = await Promise.all([lstat(base), lstat(component)]);
    if (
      root.ino !== baseIdentity.ino ||
      root.dev !== baseIdentity.dev ||
      directory.ino !== componentIdentity.ino ||
      directory.dev !== componentIdentity.dev ||
      !owned(root) ||
      !owned(directory) ||
      (root.mode & 0o777) !== 0o700 ||
      (directory.mode & 0o777) !== 0o700
    )
      throw new Error('Transcript directory changed');
  };
  const cleanup = async () => {
    await safeDirectories();
    const cutoff = now() - RETENTION_MS;
    for (const [callId, active] of calls) {
      if (active.created > cutoff) continue;
      await active.handle.close();
      calls.delete(callId);
    }
    for (const slotName of await readdir(component)) {
      if (!SLOT.test(slotName)) continue;
      const slot = join(component, slotName);
      try {
        const stat = await lstat(slot);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) continue;
        let removedOwnedFile = false;
        for (const name of await readdir(slot)) {
          const match = OWNED_FILE.exec(name);
          if (!match || !match[1] || !match[2] || !UUID.test(match[2]) || Number(match[1]) > cutoff)
            continue;
          const path = join(slot, name);
          const file = await lstat(path);
          if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || !owned(file)) continue;
          await unlink(path);
          removedOwnedFile = true;
        }
        // An interrupted creation may leave an empty slot. It expires independently.
        if (!(await readdir(slot)).length && (removedOwnedFile || stat.birthtimeMs <= cutoff))
          await rmdir(slot);
      } catch (error) {
        // Another recorder can complete the same expiry sweep concurrently.
        if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY')) throw error;
      }
    }
  };
  const allocate = async (callId: string, created: number): Promise<CallFile | undefined> => {
    await safeDirectories();
    for (let index = 0; index < 100; index += 1) {
      const slot = join(component, `slot-${String(index).padStart(2, '0')}`);
      try {
        await mkdir(slot, { mode: 0o700 });
      } catch (error) {
        if (hasCode(error, 'EEXIST')) continue;
        throw error;
      }
      let handle: FileHandle | undefined;
      try {
        await directoryTree(slot, false);
        const slotStat = await lstat(slot);
        if (!owned(slotStat) || (slotStat.mode & 0o777) !== 0o700)
          throw new Error('Unsafe transcript slot');
        const path = join(slot, `voice-${created}-${callId.toLowerCase()}-${nonce}.jsonl`);
        handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await handle.chmod(0o600);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || !owned(stat))
          throw new Error('Unsafe transcript file');
        const file = {
          path,
          slot,
          handle,
          inode: stat.ino,
          device: stat.dev,
          created,
          bytes: 0,
          full: false,
        };
        calls.set(callId, file);
        return file;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rmdir(slot).catch(() => undefined);
        throw error;
      }
    }
    diagnose('voice_transcript_file_limit');
    return undefined;
  };
  const append = async (callId: string, line: string, bytes: number, timestamp: number) => {
    if (disabled) return;
    if (timestamp <= now() - RETENTION_MS) return;
    await safeDirectories();
    let file = calls.get(callId);
    if (file && file.created <= now() - RETENTION_MS) {
      await cleanup();
      file = undefined;
    }
    file ??= await allocate(callId, timestamp);
    if (!file || file.full) return;
    if (file.bytes + bytes > FILE_BYTES) {
      file.full = true;
      diagnose('voice_transcript_file_limit');
      return;
    }
    await directoryTree(file.slot, false);
    const slotStat = await lstat(file.slot);
    if (!owned(slotStat) || (slotStat.mode & 0o777) !== 0o700)
      throw new Error('Transcript slot changed');
    const stat = await lstat(file.path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      !owned(stat) ||
      stat.ino !== file.inode ||
      stat.dev !== file.device ||
      stat.size !== file.bytes ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error('Transcript file changed');
    await file.handle.writeFile(line, 'utf8');
    file.bytes += bytes;
  };

  try {
    if (!['api', 'gateway'].includes(options.source) || base === parse(base).root)
      throw new Error('Unsafe transcript configuration');
    await directoryTree(component, true);
    const [root, directory] = await Promise.all([lstat(base), lstat(component)]);
    if (!owned(root) || !owned(directory)) throw new Error('Unsafe transcript ownership');
    for (const path of [base, component]) {
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await handle.chmod(0o700);
      } finally {
        await handle.close();
      }
    }
    baseIdentity = root;
    componentIdentity = directory;
    await cleanup();
    timer = setInterval(() => {
      if (closed || cleanupQueued) return;
      cleanupQueued = true;
      tail = tail
        .then(cleanup)
        .catch(() => diagnose('voice_transcript_cleanup_failed'))
        .finally(() => {
          cleanupQueued = false;
        });
    }, 60_000);
    timer.unref();
  } catch {
    disabled = true;
    diagnose('voice_transcript_unavailable');
  }

  return {
    record(callId, event, generation) {
      if (closed || disabled) return;
      try {
        if (!UUID.test(callId) || (generation !== undefined && !UUID.test(generation)))
          throw new Error('Invalid transcript identity');
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 0)
          throw new Error('Invalid transcript time');
        const line = `${JSON.stringify({
          formatVersion: 1,
          callId: callId.toLowerCase(),
          component: options.source,
          ...(generation === undefined ? {} : { generation: generation.toLowerCase() }),
          time: new Date(timestamp).toISOString(),
          event: safeEvent(event),
        })}\n`;
        const bytes = Buffer.byteLength(line);
        if (bytes > 32 * 1024) throw new Error('Invalid transcript record');
        if (queuedEvents >= QUEUE_EVENTS || queuedBytes + bytes > QUEUE_BYTES) {
          diagnose('voice_transcript_queue_limit');
          return;
        }
        queuedEvents += 1;
        queuedBytes += bytes;
        tail = tail
          .then(() => append(callId.toLowerCase(), line, bytes, timestamp))
          .catch(() => {
            disabled = true;
            diagnose('voice_transcript_write_failed');
          })
          .finally(() => {
            queuedEvents -= 1;
            queuedBytes -= bytes;
          });
      } catch {
        diagnose('voice_transcript_invalid_event');
      }
    },
    async flush() {
      await tail;
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await tail;
      for (const file of calls.values()) {
        await file.handle.close().catch(() => diagnose('voice_transcript_close_failed'));
      }
      calls.clear();
    },
  };
}
