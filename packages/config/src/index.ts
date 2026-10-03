import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_MODE: z.enum(['demo', 'oidc']).default('demo'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  API_TRUSTED_PROXY_CIDRS: z.string().optional(),
  DASHBOARD_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_ENCRYPTION_SECRET: z.string().min(32).max(512).optional(),
  HOSTLINE_DATA_DIR: z.string().default('.data/hostline'),
  DATABASE_URL: z.string().optional(),
  DATABASE_CA_FILE: z.string().min(1).optional(),
  DASHBOARD_STATIC_DIR: z.string().min(1).optional(),
  RUN_INTERNAL_JOBS: z.enum(['true', 'false']).optional(),
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.url().optional(),
  OIDC_MEMBERSHIPS: z.string().optional(),
  OIDC_REQUIRE_MFA: z.enum(['true', 'false']).default('true'),
  VOICE_SERVICE_TOKEN: z.string().min(32).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(16).max(256).optional(),
  VOICE_TENANT_ID: z.uuid().optional(),
  TWILIO_PHONE_NUMBER: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .optional(),
  TWILIO_ACCOUNT_SID: z
    .string()
    .regex(/^AC[a-fA-F0-9]{32}$/)
    .optional(),
  LIVE_VOICE_ENABLED: z.enum(['true', 'false']).default('false'),
  VOICE_MODE: z.literal('sandbox').optional(),
  VOICE_PUBLIC_URL: z.url().optional(),
  VOICE_ACTIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  VOICE_TRANSFERS_ENABLED: z.enum(['true', 'false']).default('false'),
  VOICE_DEBUG_TRANSCRIPTS: z.enum(['true', 'false']).default('false'),
  VOICE_MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).max(10).default(2),
  VOICE_MAX_CALL_SECONDS: z.coerce.number().int().min(15).max(600).default(300),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(env);
  const origin = new URL(value.DASHBOARD_ORIGIN);
  const trustedProxyCidrs = value.API_TRUSTED_PROXY_CIDRS?.split(',') ?? [];
  if (
    trustedProxyCidrs.length > 8 ||
    trustedProxyCidrs.some((cidr) => {
      const [address, prefix, extra] = cidr.split('/');
      if (
        !address ||
        extra !== undefined ||
        isIP(address) !== 4 ||
        !prefix ||
        !/^\d+$/.test(prefix) ||
        Number(prefix) < 24 ||
        Number(prefix) > 32
      )
        return true;
      const octets = address.split('.').map(Number);
      return !(
        octets[0] === 10 ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168)
      );
    })
  )
    throw new Error(
      'Trusted proxy CIDRs must be explicit private IPv4 ALB subnet ranges with /24 or narrower prefixes.',
    );
  if (origin.origin !== value.DASHBOARD_ORIGIN)
    throw new Error('DASHBOARD_ORIGIN must be an exact origin without a trailing slash.');
  if (value.NODE_ENV === 'production')
    throw new Error(
      'Production startup is blocked until the documented pilot readiness gates are met.',
    );
  if (value.AUTH_MODE === 'demo') {
    if (trustedProxyCidrs.length)
      throw new Error('Demo mode cannot trust forwarded client addresses.');
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
      !value.SESSION_ENCRYPTION_SECRET ||
      !value.DATABASE_URL ||
      !value.OIDC_ISSUER ||
      !value.OIDC_CLIENT_ID ||
      !value.OIDC_CLIENT_SECRET ||
      !value.OIDC_REDIRECT_URI
    )
      throw new Error(
        'OIDC mode requires the documented session, database, and OIDC configuration.',
      );
    if (value.SESSION_SECRET === value.SESSION_ENCRYPTION_SECRET)
      throw new Error('Session signing and login encryption require distinct secrets.');
    if (
      origin.protocol !== 'https:' ||
      !value.OIDC_ISSUER.startsWith('https:') ||
      !value.OIDC_REDIRECT_URI.startsWith(`${origin.origin}/`)
    )
      throw new Error('OIDC requires HTTPS and a same-origin redirect URI.');
    if (value.OIDC_MEMBERSHIPS)
      throw new Error(
        'OIDC_MEMBERSHIPS is no longer supported. Provision durable membership explicitly with the identity access operator tool.',
      );
    oidc = {
      issuer: value.OIDC_ISSUER,
      clientId: value.OIDC_CLIENT_ID,
      clientSecret: value.OIDC_CLIENT_SECRET,
      redirectUri: value.OIDC_REDIRECT_URI,
      requireMfa: value.OIDC_REQUIRE_MFA === 'true',
    };
  }
  const liveVoice = value.LIVE_VOICE_ENABLED === 'true';
  const actionsEnabled = value.VOICE_ACTIONS_ENABLED === 'true';
  const transfersEnabled = value.VOICE_TRANSFERS_ENABLED === 'true';
  const debugTranscripts = value.VOICE_DEBUG_TRANSCRIPTS === 'true';
  if (debugTranscripts && (!liveVoice || value.AUTH_MODE !== 'demo'))
    throw new Error('Voice debug transcripts require the local demo voice sandbox.');
  if (liveVoice || actionsEnabled || transfersEnabled) {
    if (
      !liveVoice ||
      value.VOICE_MODE !== 'sandbox' ||
      !value.TWILIO_ACCOUNT_SID ||
      !value.TWILIO_PHONE_NUMBER ||
      !value.VOICE_PUBLIC_URL ||
      !value.VOICE_SERVICE_TOKEN ||
      !value.VOICE_TENANT_ID
    ) {
      throw new Error('Voice actions require the complete isolated sandbox routing configuration.');
    }
    const voiceOrigin = new URL(value.VOICE_PUBLIC_URL);
    if (
      voiceOrigin.protocol !== 'https:' ||
      voiceOrigin.pathname !== '/' ||
      voiceOrigin.search ||
      voiceOrigin.hash ||
      voiceOrigin.username ||
      voiceOrigin.password
    ) {
      throw new Error(
        'VOICE_PUBLIC_URL must be an HTTPS origin without credentials, path, or query.',
      );
    }
  }
  return {
    host: value.API_HOST,
    port: value.API_PORT,
    trustedProxyCidrs,
    dataDir: value.HOSTLINE_DATA_DIR,
    databaseUrl: value.DATABASE_URL,
    databaseCaFile: value.DATABASE_CA_FILE,
    dashboardStaticDir: value.DASHBOARD_STATIC_DIR,
    runInternalJobs:
      value.RUN_INTERNAL_JOBS === undefined
        ? value.AUTH_MODE === 'demo'
        : value.RUN_INTERNAL_JOBS === 'true',
    voiceServiceToken: value.VOICE_SERVICE_TOKEN,
    voiceTenantId: value.VOICE_TENANT_ID,
    twilioPhoneNumber: value.TWILIO_PHONE_NUMBER,
    voice: {
      enabled: liveVoice,
      actionsEnabled,
      transfersEnabled,
      debugTranscripts,
      publicUrl: value.VOICE_PUBLIC_URL ? new URL(value.VOICE_PUBLIC_URL).origin : undefined,
      accountSid: value.TWILIO_ACCOUNT_SID,
      authToken: value.TWILIO_AUTH_TOKEN,
      phoneNumber: value.TWILIO_PHONE_NUMBER,
      maxConcurrentCalls: value.VOICE_MAX_CONCURRENT_CALLS,
      maxCallSeconds: value.VOICE_MAX_CALL_SECONDS,
    },
    auth: {
      mode: value.AUTH_MODE,
      dashboardOrigin: value.DASHBOARD_ORIGIN,
      sessionSecret: value.SESSION_SECRET ?? randomBytes(48).toString('base64url'),
      ...(value.SESSION_ENCRYPTION_SECRET
        ? { sessionEncryptionSecret: value.SESSION_ENCRYPTION_SECRET }
        : {}),
      secureCookies: origin.protocol === 'https:',
      ...(oidc ? { oidc } : {}),
    },
  };
}
export type AppConfig = ReturnType<typeof loadConfig>;
