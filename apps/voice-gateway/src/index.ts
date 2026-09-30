import { existsSync } from 'node:fs';
import { createVoiceGateway } from './gateway.js';
import { loadVoiceConfig } from './config.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadVoiceConfig();
const app = await createVoiceGateway(config);
await app.listen({ port: config.port, host: '127.0.0.1' });
process.stdout.write(
  `Voice gateway listening on 127.0.0.1:${config.port}; mode=${config.enabled ? 'sandbox' : 'disabled'}\n`,
);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
