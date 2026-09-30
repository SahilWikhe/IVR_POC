import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const execute = promisify(execFile);
const image = process.argv[2] ?? 'hostline:ci';
if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,200}$/.test(image)) throw new Error('Invalid image name.');
const prefix = `hostline-ci-${randomUUID().slice(0, 8)}`;
const api = `${prefix}-api`;
const voice = `${prefix}-voice`;
const restrictions = [
  '--read-only',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
];
async function docker(args, timeout = 30_000) {
  return execute('docker', args, { timeout, maxBuffer: 2 * 1024 * 1024 });
}
async function expectedFailure(args, message) {
  try {
    await docker(args);
  } catch (error) {
    if (`${error.stdout ?? ''}${error.stderr ?? ''}`.includes(message)) return;
    throw new Error('Container failed before reaching its expected configuration gate.', {
      cause: error,
    });
  }
  throw new Error('Container unexpectedly bypassed a configuration gate.');
}
async function awaitHealth(container, port, path) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await docker(
        [
          'exec',
          container,
          'node',
          '--input-type=module',
          '-e',
          `const response = await fetch('http://127.0.0.1:${port}${path}'); if (!response.ok) process.exit(1);`,
        ],
        5_000,
      );
      return;
    } catch {
      const state = (
        await docker(['inspect', '--format', '{{.State.Running}}', container])
      ).stdout.trim();
      if (state !== 'true')
        throw new Error('Synthetic container stopped before health verification.');
      await pause(250);
    }
  }
  throw new Error('Synthetic container did not become healthy.');
}

try {
  await expectedFailure(['run', '--rm', ...restrictions, image], 'Production startup is blocked');
  await expectedFailure(
    ['run', '--rm', ...restrictions, image, 'node', 'apps/migrate/dist/index.js'],
    'DATABASE_MIGRATION_URL is required',
  );
  await expectedFailure(
    ['run', '--rm', ...restrictions, image, 'node', 'apps/worker/dist/index.js'],
    'DATABASE_URL is required',
  );
  await docker([
    'run',
    '--detach',
    '--name',
    api,
    ...restrictions,
    '--env',
    'NODE_ENV=development',
    '--env',
    'AUTH_MODE=demo',
    '--env',
    'API_HOST=127.0.0.1',
    '--env',
    'API_PORT=3001',
    '--env',
    'DASHBOARD_ORIGIN=http://127.0.0.1:3001',
    '--env',
    'HOSTLINE_DATA_DIR=/tmp/hostline-synthetic',
    '--env',
    'RUN_INTERNAL_JOBS=false',
    image,
  ]);
  await awaitHealth(api, 3001, '/api/ready');
  await docker([
    'exec',
    api,
    'node',
    '--input-type=module',
    '-e',
    `
    if (process.getuid() === 0) throw new Error('Runtime must be non-root.');
    const base = 'http://127.0.0.1:3001';
    const root = await fetch(base);
    if (!root.ok) throw new Error('Dashboard root unavailable.');
    const html = await root.text();
    const entry = html.split('src="').slice(1).map((part) => part.split('"')[0]).find((path) => path.startsWith('/assets/') && path.endsWith('.js'));
    if (!entry) throw new Error('Built dashboard entry missing.');
    const asset = await fetch(base + entry, { method: 'HEAD' });
    if (!asset.ok || await asset.text() !== '' || !asset.headers.get('cache-control')?.includes('immutable')) throw new Error('Asset headers incorrect.');
    const unauthorized = await fetch(base + '/api/bootstrap');
    if (unauthorized.status !== 401) throw new Error('Private API authorization changed.');
    const missing = await fetch(base + '/api/missing', { headers: { accept: 'text/html' } });
    if (missing.status !== 404 || (await missing.text()).includes('<!doctype html>')) throw new Error('API miss became HTML.');
  `,
  ]);
  await docker([
    'run',
    '--detach',
    '--name',
    voice,
    ...restrictions,
    '--env',
    'LIVE_VOICE_ENABLED=false',
    '--env',
    'VOICE_HOST=127.0.0.1',
    '--env',
    'VOICE_PORT=3002',
    image,
    'node',
    'apps/voice-gateway/dist/index.js',
  ]);
  await awaitHealth(voice, 3002, '/health');
  await docker([
    'exec',
    voice,
    'node',
    '--input-type=module',
    '-e',
    `
    if (process.getuid() === 0) throw new Error('Runtime must be non-root.');
    const response = await fetch('http://127.0.0.1:3002/twilio/voice', { method: 'POST' });
    if (response.status !== 503) throw new Error('Disabled voice route must reject incoming calls.');
  `,
  ]);
  console.log(
    'Container smoke passed: production gate, non-root/read-only synthetic API, dashboard, migration readiness, private routes, and disabled voice.',
  );
} finally {
  await Promise.all(
    [api, voice].map(async (name) => {
      try {
        await docker(['rm', '--force', name]);
      } catch {
        /* Container may not have started. */
      }
    }),
  );
}
