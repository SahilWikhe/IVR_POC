import { existsSync } from 'node:fs';
import { loadConfig } from '@hostline/config';
import { createDatabase } from '@hostline/database';
import { logEvent } from '@hostline/observability';
import { createApp } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const db = await createDatabase(
  config.databaseUrl ? { url: config.databaseUrl } : { dataDir: config.dataDir },
);
if (config.auth.mode === 'demo') await db.seedDemo();
const app = await createApp(config, db);
let running = false;
const jobs = setInterval(() => {
  if (running) return;
  running = true;
  void db
    .processJobs(20)
    .catch(() => logEvent({ event: 'worker.failed', code: 'JOB_PROCESSING_FAILED' }))
    .finally(() => {
      running = false;
    });
}, 10000);
jobs.unref();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(jobs);
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  await app.close();
  await db.close();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
await app.listen({ host: config.host, port: config.port });
logEvent({ event: 'api.ready' });
