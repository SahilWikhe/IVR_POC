import { spawn } from 'node:child_process';
import { nativeTestUrl } from '../tests/native/url.ts';

// This command intentionally fails rather than reporting a skipped native run.
// DATABASE_URL is never used as a fallback, and the suite refuses a nonempty DB.
try {
  nativeTestUrl(process.env.TEST_DATABASE_URL ?? '');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const child = spawn('pnpm', ['exec', 'vitest', 'run', 'tests/native/'], {
  stdio: 'inherit',
  env: { ...process.env, HOSTLINE_NATIVE_TEST_REQUIRED: 'true' },
});
child.on('error', () => {
  console.error('Could not start native PostgreSQL conformance tests.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
