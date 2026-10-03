import { existsSync } from 'node:fs';
import { loadConfig } from '@hostline/config';
import { createDatabase, createRuntimeRecoveryGuard } from '@hostline/database';
import { createVoiceTranscriptRecorder, logEvent } from '@hostline/observability';
import { createApp } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const voiceTranscripts = config.voice.debugTranscripts
  ? await createVoiceTranscriptRecorder({
      directory: '.data/voice-transcripts',
      source: 'api',
      onDiagnostic: (code) => logEvent({ event: 'voice.transcript', code }),
    })
  : undefined;
const db = await createDatabase(
  config.databaseUrl
    ? {
        url: config.databaseUrl,
        ...(config.databaseCaFile ? { caFile: config.databaseCaFile } : {}),
      }
    : { dataDir: config.dataDir },
);
if (config.auth.mode === 'demo') await db.seedDemo();
const recoveryGuard =
  config.auth.mode === 'oidc' ? createRuntimeRecoveryGuard(db) : async () => true;
const app = await createApp(config, db, {
  recoveryGuard,
  ...(voiceTranscripts ? { voiceTranscripts } : {}),
});
let running = false;
const jobs = config.runInternalJobs
  ? setInterval(() => {
      if (running) return;
      running = true;
      void db
        .readiness()
        .then(async () => ((await recoveryGuard()) ? db.processJobs(20) : 0))
        .catch(() => logEvent({ event: 'worker.failed', code: 'JOB_PROCESSING_FAILED' }))
        .finally(() => {
          running = false;
        });
    }, 10000)
  : undefined;
jobs?.unref();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (jobs) clearInterval(jobs);
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  await app.close();
  await voiceTranscripts?.close();
  await db.close();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
await app.listen({ host: config.host, port: config.port });
logEvent({ event: 'api.ready' });
