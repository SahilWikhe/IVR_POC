import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const membershipSchema = z
  .object({
    subject: z.string().min(1),
    tenantId: z.uuid(),
    name: z.string().min(1).max(100),
    role: z.enum(['owner', 'staff', 'viewer']),
  })
  .strict();
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_MODE: z.enum(['demo', 'oidc']).default('demo'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  DASHBOARD_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  SESSION_SECRET: z.string().min(32).optional(),
  HOSTLINE_DATA_DIR: z.string().default('.data/hostline'),
  DATABASE_URL: z.string().optional(),
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.url().optional(),
  OIDC_MEMBERSHIPS: z.string().optional(),
  VOICE_SERVICE_TOKEN: z.string().min(32).optional(),
  VOICE_TENANT_ID: z.uuid().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(env);
  const origin = new URL(value.DASHBOARD_ORIGIN);
  if (origin.origin !== value.DASHBOARD_ORIGIN)
    throw new Error('DASHBOARD_ORIGIN must be an exact origin without a trailing slash.');
  if (value.NODE_ENV === 'production')
    throw new Error(
      'Production startup is blocked until the documented pilot readiness gates are met.',
    );
  if (value.AUTH_MODE === 'demo') {
    if (
      !['127.0.0.1', '::1', 'localhost'].includes(value.API_HOST) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)
    ) {
      throw new Error('Demo mode requires loopback API and dashboard addresses.');
    }
    if (value.DATABASE_URL)
      throw new Error('Demo mode uses only its dedicated embedded synthetic database.');
  }
  let oidc;
  if (value.AUTH_MODE === 'oidc') {
    if (
      !value.SESSION_SECRET ||
      !value.DATABASE_URL ||
      !value.OIDC_ISSUER ||
      !value.OIDC_CLIENT_ID ||
      !value.OIDC_CLIENT_SECRET ||
      !value.OIDC_REDIRECT_URI ||
      !value.OIDC_MEMBERSHIPS
    )
      throw new Error(
        'OIDC mode requires the documented session, database, and OIDC configuration.',
      );
    if (
      origin.protocol !== 'https:' ||
      !value.OIDC_ISSUER.startsWith('https:') ||
      !value.OIDC_REDIRECT_URI.startsWith(`${origin.origin}/`)
    )
      throw new Error('OIDC requires HTTPS and a same-origin redirect URI.');
    const memberships = z
      .array(membershipSchema)
      .min(1)
      .max(100)
      .parse(JSON.parse(value.OIDC_MEMBERSHIPS));
    if (new Set(memberships.map((m) => m.subject)).size !== memberships.length)
      throw new Error('OIDC subjects must have exactly one explicit membership in this prototype.');
    oidc = {
      issuer: value.OIDC_ISSUER,
      clientId: value.OIDC_CLIENT_ID,
      clientSecret: value.OIDC_CLIENT_SECRET,
      redirectUri: value.OIDC_REDIRECT_URI,
      memberships,
    };
  }
  return {
    host: value.API_HOST,
    port: value.API_PORT,
    dataDir: value.HOSTLINE_DATA_DIR,
    databaseUrl: value.DATABASE_URL,
    voiceServiceToken: value.VOICE_SERVICE_TOKEN,
    voiceTenantId: value.VOICE_TENANT_ID,
    twilioPhoneNumber: value.TWILIO_PHONE_NUMBER,
    auth: {
      mode: value.AUTH_MODE,
      dashboardOrigin: value.DASHBOARD_ORIGIN,
      sessionSecret: value.SESSION_SECRET ?? randomBytes(48).toString('base64url'),
      secureCookies: origin.protocol === 'https:',
      ...(oidc ? { oidc } : {}),
    },
  };
}
export type AppConfig = ReturnType<typeof loadConfig>;
