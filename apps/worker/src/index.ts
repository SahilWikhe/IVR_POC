import { existsSync } from 'node:fs';
import { createDatabase, createRuntimeRecoveryGuard } from '@hostline/database';

if (existsSync('.env')) process.loadEnvFile('.env');

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is required for the standalone worker. Embedded demo jobs run inside the API process.',
  );
  process.exitCode = 1;
} else {
  const db = await createDatabase({
    url: databaseUrl,
    ...(process.env['DATABASE_CA_FILE'] ? { caFile: process.env['DATABASE_CA_FILE'] } : {}),
  });
  const controller = new AbortController();
  const recoveryGuard = createRuntimeRecoveryGuard(db);
  let quarantined = false;
  const stop = () => {
    controller.abort();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!controller.signal.aborted) {
      try {
        const ready = await recoveryGuard();
        if (!ready && !quarantined)
          console.error(JSON.stringify({ component: 'worker', event: 'recovery_quarantine' }));
        if (ready && quarantined)
          console.log(JSON.stringify({ component: 'worker', event: 'recovery_ready' }));
        quarantined = !ready;
        const completed = ready ? await db.processJobs(25) : 0;
        if (completed > 0)
          console.log(
            JSON.stringify({
              component: 'worker',
              event: 'internal_work_completed',
              count: completed,
            }),
          );
      } catch {
        console.error(JSON.stringify({ component: 'worker', event: 'internal_work_failed' }));
      }
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) {
          resolve();
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener('abort', onAbort);
          resolve();
        }, 5000);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  } finally {
    await db.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
