import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65535);
const enabledSchema = z.enum(['true', 'false']);
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
  model: z.enum(['gpt-realtime', 'gpt-realtime-mini']),
  maxConcurrentCalls: z.coerce.number().int().min(1).max(10),
  maxCallSeconds: z.coerce.number().int().min(15).max(600),
});

export type EnabledVoiceConfig = z.infer<typeof activeSchema> & { enabled: true; port: number };
export type VoiceConfig = EnabledVoiceConfig | { enabled: false; port: number };

/** No network calls happen during configuration. Invalid values are never included in errors. */
export function loadVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const enabled = enabledSchema.safeParse(env.LIVE_VOICE_ENABLED ?? 'false');
  const port = portSchema.safeParse(env.VOICE_PORT ?? env.PORT ?? '3002');
  if (!enabled.success || !port.success)
    throw new Error('Invalid LIVE_VOICE_ENABLED or VOICE_PORT');
  if (enabled.data === 'false') return { enabled: false, port: port.data };
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
    model: env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime',
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
  };
}
