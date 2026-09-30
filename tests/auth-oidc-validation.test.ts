import { generateKeyPairSync, randomUUID, sign, createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type * as oidcModule from 'openid-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANTS, sessionSchema } from '@hostline/contracts';
import type { AuthPersistence, AuthSession, CreateLoginAttempt } from '@hostline/database';
import { registerAuth, type AuthConfig } from '../apps/api/src/auth.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
// Only the transport is replaced. Maintained openid-client discovery, grant validation,
// JOSE verification, issuer/audience/nonce/expiry checks, and MFA processing run normally.
vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof oidcModule>();
  return {
    ...actual,
    discovery: (...args: Parameters<typeof actual.discovery>) => {
      const [issuer, clientId, metadata, authentication, options] = args;
      return actual.discovery(issuer, clientId, metadata, authentication, {
        ...options,
        [actual.customFetch]: transport.fetch,
      });
    },
  };
});

const issuer = 'https://signed-identity.example/';
const origin = 'https://dashboard.example';
const config: AuthConfig = {
  mode: 'oidc',
  dashboardOrigin: origin,
  sessionSecret: 'synthetic-signing-secret-for-signed-provider-tests',
  sessionEncryptionSecret: 'independent-encryption-secret-for-signed-provider-tests',
  secureCookies: true,
  oidc: {
    issuer,
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-client-secret',
    redirectUri: `${origin}/api/auth/callback`,
    requireMfa: true,
  },
};
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'synthetic-key',
  use: 'sig',
  alg: 'RS256',
};
const apps: FastifyInstance[] = [];
let currentNonce = '';
let mode = 'valid';
const contacted: string[] = [];

function signedIdToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: mode === 'wrong_algorithm' ? 'HS256' : 'RS256', kid: 'synthetic-key' };
  const claims = {
    iss: mode === 'wrong_issuer' ? 'https://other-issuer.example/' : issuer,
    aud: mode === 'wrong_audience' ? 'different-client' : config.oidc?.clientId,
    sub: 'auth0|synthetic-staff',
    iat: now,
    exp: mode === 'expired' ? now - 3600 : now + 300,
    nonce: mode === 'wrong_nonce' ? 'unbound-nonce' : currentNonce,
    auth_time: mode === 'stale_authentication' ? now - 600 : now,
    amr: mode === 'missing_mfa' ? ['pwd'] : ['pwd', 'mfa'],
  };
  const input = [header, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.');
  const signature =
    mode === 'wrong_algorithm'
      ? createHmac('sha256', 'synthetic-wrong-key').update(input).digest()
      : sign('RSA-SHA256', Buffer.from(input), keys.privateKey);
  if (mode === 'bad_signature') signature[0] = (signature[0] ?? 0) ^ 0xff;
  return `${input}.${signature.toString('base64url')}`;
}

beforeEach(() => {
  currentNonce = '';
  mode = 'valid';
  contacted.length = 0;
  transport.fetch.mockReset().mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    contacted.push(url.pathname);
    if (url.origin !== new URL(issuer).origin) throw new Error('Unexpected test provider host.');
    if (url.pathname === '/.well-known/openid-configuration')
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}oauth/token`,
        jwks_uri: `${issuer}.well-known/jwks.json`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
    if (url.pathname === '/oauth/token')
      return Response.json({
        access_token: 'synthetic-access-token-never-returned-to-browser',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: signedIdToken(),
      });
    throw new Error('Unexpected test provider path.');
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// This narrow in-memory store isolates the signed-provider boundary. Durable sessions,
// cancellation, role versions and database restart are tested with real PGlite elsewhere.
function validationStore() {
  const attempts = new Map<string, CreateLoginAttempt>();
  const sessions = new Map<string, AuthSession>();
  const issueSession = vi.fn<AuthPersistence['issueSession']>(async (input) => {
    const resolved: AuthSession = {
      sessionId: randomUUID(),
      identityId: randomUUID(),
      tenantId: DEMO_TENANTS.harbor,
      role: 'staff',
      displayName: 'Synthetic Staff',
      workspaceName: 'Harbor Table',
      expiresAt: input.expiresAt,
      idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      mfaVerifiedAt: input.mfaVerifiedAt ?? null,
      identityVersion: 1,
      membershipVersion: 1,
      tenantVersion: 1,
    };
    sessions.set(input.tokenHash, resolved);
    return resolved;
  });
  const store: AuthPersistence = {
    async createLoginAttempt(input) {
      attempts.set(input.tokenHash, input);
    },
    async consumeLoginAttempt(input) {
      const attempt = attempts.get(input.tokenHash);
      attempts.delete(input.tokenHash);
      return attempt
        ? { encryptedPayload: attempt.encryptedPayload, expiresAt: attempt.expiresAt }
        : null;
    },
    async cancelLoginAttempt(input) {
      attempts.delete(input.tokenHash);
    },
    issueSession,
    async getSession(input) {
      return sessions.get(input.tokenHash) ?? null;
    },
    async revokeSession(input) {
      sessions.delete(input.tokenHash);
    },
  };
  return { store, issueSession };
}

async function setup() {
  const { store, issueSession } = validationStore();
  const app = Fastify();
  apps.push(app);
  await app.register(cookie, { secret: config.sessionSecret });
  await registerAuth(app, config, store);
  await app.ready();
  return { app, issueSession };
}

async function complete(app: FastifyInstance) {
  const start = await app.inject('/api/auth/login');
  expect(start.statusCode).toBe(302);
  const authorization = new URL(start.headers.location ?? '');
  currentNonce = authorization.searchParams.get('nonce') ?? '';
  const state = authorization.searchParams.get('state') ?? '';
  const raw = start.headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [raw ?? ''];
  const loginCookie = values
    .find((value) => value.startsWith('__Host-hostline_login='))
    ?.split(';')[0];
  if (!loginCookie) throw new Error('Missing synthetic login cookie.');
  return app.inject({
    url: `/api/auth/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
    headers: { cookie: loginCookie },
  });
}

describe('actual openid-client signed ID-token validation without an external provider', () => {
  it('validates the RS256 signature via discovered JWKS before minting an MFA-proven staff session', async () => {
    const { app, issueSession } = await setup();
    const callback = await complete(app);
    expect(callback.statusCode).toBe(302);
    expect(contacted).toContain('/.well-known/jwks.json');
    expect(issueSession).toHaveBeenCalledTimes(1);
    expect(issueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'auth0|synthetic-staff',
        mfaVerifiedAt: expect.any(String),
      }),
    );
    const raw = callback.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : [raw ?? ''];
    const cookie = cookies
      .find((value) => value.startsWith('__Host-hostline_session='))
      ?.split(';')[0];
    expect(cookie).toBeDefined();
    const session = sessionSchema.parse(
      (await app.inject({ url: '/api/session', headers: { cookie: cookie ?? '' } })).json(),
    );
    expect(session.user?.role).toBe('staff');
    expect(JSON.stringify(callback.headers)).not.toContain('synthetic-access-token');
    expect(callback.body).not.toContain('synthetic-access-token');
    expect(callback.body).not.toContain(signedIdToken());
  });

  it.each([
    'bad_signature',
    'wrong_algorithm',
    'wrong_audience',
    'wrong_nonce',
    'wrong_issuer',
    'expired',
    'stale_authentication',
  ])('rejects %s before the database session is issued', async (failure) => {
    mode = failure;
    const { app, issueSession } = await setup();
    const callback = await complete(app);
    expect(callback.statusCode).toBe(401);
    expect(issueSession).not.toHaveBeenCalled();
    expect(callback.cookies.some((entry) => entry.name === '__Host-hostline_session')).toBe(false);
    expect(callback.body).not.toContain('synthetic-client-secret');
  });

  it('rejects a correctly signed password-only token when MFA is required', async () => {
    mode = 'missing_mfa';
    const { app, issueSession } = await setup();
    const callback = await complete(app);
    expect(callback.statusCode).toBe(403);
    expect(contacted).toContain('/.well-known/jwks.json');
    expect(issueSession).not.toHaveBeenCalled();
  });
});
