import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65535);
const enabledSchema = z.enum(['true', 'false']);
const hostSchema = z.enum(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::']);
const httpsOrigin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  }, 'VOICE_PUBLIC_URL must be an HTTPS origin without credentials, path, or query');
const apiOrigin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  }, 'API_INTERNAL_URL must be an HTTPS origin or an HTTP loopback origin');

const activeSchema = z.object({
  mode: z.literal('sandbox'),
  accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
  authToken: z.string().min(16).max(256),
  phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/),
  openaiKey: z.string().min(16).max(512),
  publicUrl: httpsOrigin,
  apiUrl: apiOrigin,
  serviceToken: z.string().min(32).max(512),
  tenantId: z.uuid(),
  model: z.enum(['gpt-live-1', 'gpt-realtime', 'gpt-realtime-mini']),
  backendModel: z.literal('gpt-6-luna'),
  actionsEnabled: z.boolean(),
  transfersEnabled: z.boolean(),
  debugTranscripts: z.boolean(),
  maxConcurrentCalls: z.coerce.number().int().min(1).max(10),
  maxCallSeconds: z.coerce.number().int().min(15).max(600),
});

export type EnabledVoiceConfig = z.infer<typeof activeSchema> & {
  enabled: true;
  port: number;
  host?: string;
};
export type VoiceConfig = EnabledVoiceConfig | { enabled: false; port: number; host?: string };

/** No network calls happen during configuration. Invalid values are never included in errors. */
export function loadVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const enabled = enabledSchema.safeParse(env.LIVE_VOICE_ENABLED ?? 'false');
  const actions = enabledSchema.safeParse(env.VOICE_ACTIONS_ENABLED ?? 'false');
  const transfers = enabledSchema.safeParse(env.VOICE_TRANSFERS_ENABLED ?? 'false');
  const transcripts = enabledSchema.safeParse(env.VOICE_DEBUG_TRANSCRIPTS ?? 'false');
  const port = portSchema.safeParse(env.VOICE_PORT ?? env.PORT ?? '3002');
  const host = hostSchema.safeParse(env.VOICE_HOST ?? '127.0.0.1');
  if (
    !enabled.success ||
    !port.success ||
    !host.success ||
    !actions.success ||
    !transfers.success ||
    !transcripts.success
  )
    throw new Error('Invalid voice activation flags, VOICE_HOST, or VOICE_PORT');
  if (
    transcripts.data === 'true' &&
    (enabled.data !== 'true' ||
      (env.AUTH_MODE ?? 'demo') !== 'demo' ||
      !['127.0.0.1', 'localhost', '::1'].includes(host.data) ||
      (env.OPENAI_REALTIME_MODEL ?? 'gpt-live-1') !== 'gpt-live-1')
  )
    throw new Error('Voice debug transcripts require the loopback GPT-Live demo sandbox.');
  if (enabled.data === 'false') return { enabled: false, port: port.data, host: host.data };
  if (env.NODE_ENV === 'production')
    throw new Error('Production voice activation is unavailable: sandbox verification is required');
  const parsed = activeSchema.safeParse({
    mode: env.VOICE_MODE,
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    phoneNumber: env.TWILIO_PHONE_NUMBER,
    openaiKey: env.OPENAI_API_KEY,
    publicUrl: env.VOICE_PUBLIC_URL,
    apiUrl: env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001',
    serviceToken: env.VOICE_SERVICE_TOKEN,
    tenantId: env.VOICE_TENANT_ID,
    actionsEnabled: actions.data === 'true',
    transfersEnabled: transfers.data === 'true',
    debugTranscripts: transcripts.data === 'true',
    model: env.OPENAI_REALTIME_MODEL ?? 'gpt-live-1',
    backendModel: env.OPENAI_VOICE_BACKEND_MODEL ?? 'gpt-6-luna',
    maxConcurrentCalls: env.VOICE_MAX_CONCURRENT_CALLS ?? '2',
    maxCallSeconds: env.VOICE_MAX_CALL_SECONDS ?? '300',
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid voice configuration fields: ${[...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].join(', ')}`,
    );
  }
  return {
    ...parsed.data,
    publicUrl: new URL(parsed.data.publicUrl).origin,
    apiUrl: new URL(parsed.data.apiUrl).origin,
    enabled: true,
    port: port.data,
    host: host.data,
  };
}
