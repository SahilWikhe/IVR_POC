import { existsSync } from 'node:fs';
import { createVoiceTranscriptRecorder, logEvent } from '@hostline/observability';
import { createVoiceGateway } from './gateway.js';
import { loadVoiceConfig } from './config.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadVoiceConfig();
const voiceTranscripts =
  config.enabled && config.debugTranscripts
    ? await createVoiceTranscriptRecorder({
        directory: '.data/voice-transcripts',
        source: 'gateway',
        onDiagnostic: (code) => logEvent({ event: 'voice.transcript', code }),
      })
    : undefined;
const app = await createVoiceGateway(config, voiceTranscripts ? { voiceTranscripts } : {});
await app.listen({ port: config.port, host: config.host ?? '127.0.0.1' });
process.stdout.write(
  `Voice gateway listening on ${config.host ?? '127.0.0.1'}:${config.port}; mode=${config.enabled ? 'sandbox' : 'disabled'}\n`,
);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(async () => {
      await voiceTranscripts?.close();
      process.exit(0);
    });
  });
}
