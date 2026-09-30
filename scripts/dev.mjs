import { spawn } from 'node:child_process';
const children = [
  ['exec', 'tsx', 'watch', 'apps/api/src/index.ts'],
  ['--filter', '@hostline/dashboard', 'dev'],
].map((args) => spawn('pnpm', args, { stdio: 'inherit', env: process.env }));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
for (const child of children) {
  child.on('exit', (code) => stop(code ?? 1));
  child.on('error', () => stop(1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
