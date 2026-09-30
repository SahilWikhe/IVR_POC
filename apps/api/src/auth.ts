import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { DEMO_TENANTS, type Actor, type Role, type SessionInfo } from '@hostline/contracts';
import type { AuthSessionBinding, Database } from '@hostline/database';

export interface AuthConfig {
  mode: 'demo' | 'oidc';
  dashboardOrigin: string;
  sessionSecret: string;
  sessionEncryptionSecret?: string;
  secureCookies: boolean;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    requireMfa: boolean;
  };
}

export interface AuthService {
  actor(request: FastifyRequest): Actor;
  session(request: FastifyRequest): SessionInfo;
  requireRole(request: FastifyRequest, roles: Role[]): Actor;
  databaseBinding(request: FastifyRequest): AuthSessionBinding | null;
  close(): void;
}

export class AuthError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = status;
  }
}

interface StoredSession {
  actor: Actor;
  name: string;
  workspaceName: string;
  csrfToken: string;
  expiresAt: number;
}

const SESSION_TTL = 8 * 60 * 60 * 1000;
const LOGIN_TTL = 5 * 60 * 1000;
const MAX_DEMO_SESSIONS = 1000;
const MAX_RATE_KEYS = 1000;
const AUTH_RATE_WINDOW = 60_000;
const AUTH_RATE_LIMIT = 20;
const demoLoginSchema = z.object({ workspace: z.enum(['harbor', 'juniper']) }).strict();
const loginAttemptSchema = z
  .object({
    state: z.string().min(1).max(128),
    nonce: z.string().min(1).max(128),
    verifier: z.string().min(1).max(128),
  })
  .strict();
const verifiedClaimsSchema = z.object({
  iss: z.string().min(1).max(2048),
  sub: z.string().min(1).max(255),
  amr: z.array(z.string().min(1).max(64)).max(16).optional(),
});
const encryptedAttemptSchema = z
  .object({
    version: z.literal(1),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{1,4096}$/),
    tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function constantTimeMatch(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || supplied.length > 128) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

/** The BFF retains no provider tokens. Durable OIDC access is checked again inside business transactions. */
export async function registerAuth(
  app: FastifyInstance,
  config: AuthConfig,
  store?: Database['auth'],
): Promise<AuthService> {
  if (config.sessionSecret.length < 32)
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  const dashboardUrl = new URL(config.dashboardOrigin);
  const dashboardOrigin = dashboardUrl.origin;
  const requireMfa = config.oidc?.requireMfa !== false;
  if (!['http:', 'https:'].includes(dashboardUrl.protocol))
    throw new Error('DASHBOARD_ORIGIN must use HTTP or HTTPS.');
  const cookieName = config.secureCookies ? '__Host-hostline_session' : 'hostline_session';
  const loginCookieName = config.secureCookies ? '__Host-hostline_login' : 'hostline_login';
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.secureCookies,
    signed: true,
  };
  // The synthetic loopback demo intentionally stays isolated from real identity tables.
  const demoSessions = new Map<string, StoredSession>();
  const authRates = new Map<string, { count: number; expiresAt: number }>();
  const requestSessions = new WeakMap<FastifyRequest, StoredSession>();
  const requestBindings = new WeakMap<FastifyRequest, AuthSessionBinding>();
  let oidcClient: oidc.Configuration | undefined;
  let redirectUri: string | undefined;
  let encryptionKey: Buffer | undefined;

  if (config.mode === 'oidc') {
    if (!config.oidc || !store)
      throw new Error('OIDC configuration and durable storage are required.');
    if (!config.sessionEncryptionSecret || config.sessionEncryptionSecret.length < 32)
      throw new Error(
        'SESSION_ENCRYPTION_SECRET must contain at least 32 characters in OIDC mode.',
      );
    if (config.sessionEncryptionSecret === config.sessionSecret)
      throw new Error('SESSION_ENCRYPTION_SECRET must differ from SESSION_SECRET.');
    const issuer = new URL(config.oidc.issuer);
    if (
      issuer.protocol !== 'https:' ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      issuer.pathname.includes('/.well-known/')
    )
      throw new Error(
        'OIDC_ISSUER must be an HTTPS issuer identifier without credentials or query.',
      );
    const callback = new URL(config.oidc.redirectUri);
    if (
      callback.origin !== dashboardOrigin ||
      callback.pathname !== '/api/auth/callback' ||
      callback.search ||
      callback.hash ||
      callback.username ||
      callback.password
    ) {
      throw new Error(
        'OIDC_REDIRECT_URI must be the dashboard origin followed by /api/auth/callback.',
      );
    }
    encryptionKey = Buffer.from(
      hkdfSync('sha256', config.sessionEncryptionSecret, '', 'hostline.oidc.login.v1', 32),
    );
    redirectUri = callback.href;
    oidcClient = await oidc.discovery(
      issuer,
      config.oidc.clientId,
      { client_secret: config.oidc.clientSecret, id_token_signed_response_alg: 'RS256' },
      undefined,
      { timeout: 10, execute: [oidc.enableNonRepudiationChecks] },
    );
  }

  function pruneExpired(): void {
    const now = Date.now();
    for (const [key, value] of demoSessions) if (value.expiresAt <= now) demoSessions.delete(key);
    for (const [key, value] of authRates) if (value.expiresAt <= now) authRates.delete(key);
  }

  function readCookie(request: FastifyRequest, name: string): string | undefined {
    const raw = request.cookies[name];
    if (!raw || raw.length > 256) return undefined;
    const unsigned = request.unsignCookie(raw);
    return unsigned.valid && unsigned.value && /^[A-Za-z0-9_-]{43}$/.test(unsigned.value)
      ? unsigned.value
      : undefined;
  }

  function databaseBinding(token: string): AuthSessionBinding {
    if (!config.oidc) throw new Error('OIDC is not configured.');
    return {
      tokenHash: tokenHash(token),
      issuer: config.oidc.issuer,
      clientId: config.oidc.clientId,
    };
  }

  function csrfToken(token: string): string {
    return createHmac('sha256', config.sessionSecret)
      .update(`hostline.session.csrf.v1\0${dashboardOrigin}\0${token}`)
      .digest('base64url');
  }

  function attemptAad(binding: AuthSessionBinding): Buffer {
    return Buffer.from(JSON.stringify({ ...binding, redirectUri }));
  }

  function encryptAttempt(token: string, attempt: z.infer<typeof loginAttemptSchema>): string {
    if (!encryptionKey) throw new Error('OIDC login encryption is not configured.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(attemptAad(databaseBinding(token)));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(attempt), 'utf8'),
      cipher.final(),
    ]);
    return JSON.stringify({
      version: 1,
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    });
  }

  function decryptAttempt(token: string, payload: string): z.infer<typeof loginAttemptSchema> {
    if (!encryptionKey) throw new Error('OIDC login encryption is not configured.');
    const encrypted = encryptedAttemptSchema.parse(JSON.parse(payload));
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      Buffer.from(encrypted.iv, 'base64url'),
    );
    decipher.setAAD(attemptAad(databaseBinding(token)));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return loginAttemptSchema.parse(JSON.parse(plaintext));
  }

  async function loadSession(request: FastifyRequest): Promise<void> {
    pruneExpired();
    const token = readCookie(request, cookieName);
    if (!token) return;
    if (config.mode === 'demo') {
      const stored = demoSessions.get(token);
      if (stored) requestSessions.set(request, stored);
      return;
    }
    if (!store || !config.oidc) return;
    const binding = databaseBinding(token);
    const resolved = await store.getSession(binding);
    if (!resolved || (requireMfa && !resolved.mfaVerifiedAt)) return;
    requestSessions.set(request, {
      actor: { userId: resolved.identityId, tenantId: resolved.tenantId, role: resolved.role },
      name: resolved.displayName,
      workspaceName: resolved.workspaceName,
      csrfToken: csrfToken(token),
      expiresAt: Date.parse(resolved.expiresAt),
    });
    requestBindings.set(request, binding);
  }

  function sessionInfo(stored?: StoredSession): SessionInfo {
    if (!stored)
      return {
        authenticated: false,
        mode: config.mode,
        csrfToken: null,
        user: null,
        workspace: null,
      };
    return {
      authenticated: true,
      mode: config.mode,
      csrfToken: stored.csrfToken,
      user: { id: stored.actor.userId, name: stored.name, role: stored.actor.role },
      workspace: { id: stored.actor.tenantId, name: stored.workspaceName },
    };
  }

  function consumeAuthRate(request: FastifyRequest): void {
    pruneExpired();
    const current = authRates.get(request.ip);
    if (!current) {
      if (authRates.size >= MAX_RATE_KEYS)
        throw new AuthError(
          'AUTH_CAPACITY',
          503,
          'Sign-in is temporarily unavailable. Try again shortly.',
        );
      authRates.set(request.ip, { count: 1, expiresAt: Date.now() + AUTH_RATE_WINDOW });
      return;
    }
    current.count += 1;
    if (current.count > AUTH_RATE_LIMIT)
      throw new AuthError(
        'AUTH_RATE_LIMIT',
        429,
        'Too many sign-in attempts. Try again in a minute.',
      );
  }

  async function revokeSession(request: FastifyRequest): Promise<void> {
    const token = readCookie(request, cookieName);
    if (!token) return;
    if (config.mode === 'demo') demoSessions.delete(token);
    else if (store) await store.revokeSession(databaseBinding(token));
    requestSessions.delete(request);
    requestBindings.delete(request);
  }

  const service: AuthService = {
    actor(request) {
      const stored = requestSessions.get(request);
      if (!stored) throw new AuthError('UNAUTHENTICATED', 401, 'Sign in to continue.');
      return { ...stored.actor };
    },
    session(request) {
      return sessionInfo(requestSessions.get(request));
    },
    requireRole(request, roles) {
      const actor = service.actor(request);
      if (!roles.includes(actor.role))
        throw new AuthError('FORBIDDEN', 403, 'Your role cannot perform this action.');
      return actor;
    },
    databaseBinding(request) {
      const binding = requestBindings.get(request);
      return binding ? { ...binding } : null;
    },
    close() {
      // A process shutdown must not revoke another replica's durable sessions or login attempts.
      demoSessions.clear();
      authRates.clear();
      encryptionKey?.fill(0);
    },
  };

  app.addHook('preHandler', async (request, reply) => {
    // Fastify may match an encoded static segment to its canonical route.
    // Authorize the matched route, so encoded /api/ prefixes cannot skip this hook.
    const pathname = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
    if (!pathname.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    await loadSession(request);
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (request.headers.origin !== dashboardOrigin)
      throw new AuthError('ORIGIN_REJECTED', 403, 'Request origin is not allowed.');
    if (pathname === '/api/auth/demo') return;
    if (pathname === '/api/auth/logout') {
      // A callback can rotate the old session before its response reaches the browser.
      // Permit cancellation using that browser's signed cookie and bound CSRF proof,
      // even when the associated session has already been revoked or expired.
      const token = readCookie(request, cookieName);
      if (!token) throw new AuthError('UNAUTHENTICATED', 401, 'Sign in to continue.');
      if (!constantTimeMatch(csrfToken(token), request.headers['x-csrf-token']))
        throw new AuthError('CSRF_REJECTED', 403, 'Refresh the page and try again.');
      return;
    }
    const stored = requestSessions.get(request);
    if (!stored) throw new AuthError('UNAUTHENTICATED', 401, 'Sign in to continue.');
    if (!constantTimeMatch(stored.csrfToken, request.headers['x-csrf-token']))
      throw new AuthError('CSRF_REJECTED', 403, 'Refresh the page and try again.');
  });

  app.get('/api/session', async (request) => service.session(request));

  app.post('/api/auth/demo', async (request, reply) => {
    consumeAuthRate(request);
    if (config.mode !== 'demo')
      throw new AuthError('DEMO_DISABLED', 404, 'Demo sign-in is unavailable.');
    const parsed = demoLoginSchema.safeParse(request.body);
    if (!parsed.success) throw new AuthError('INVALID_INPUT', 400, 'Choose a demo workspace.');
    const { workspace } = parsed.data;
    pruneExpired();
    const previousToken = readCookie(request, cookieName);
    if (
      demoSessions.size >= MAX_DEMO_SESSIONS &&
      (!previousToken || !demoSessions.has(previousToken))
    )
      throw new AuthError(
        'AUTH_CAPACITY',
        503,
        'Sign-in is temporarily unavailable. Try again shortly.',
      );
    await revokeSession(request);
    const token = randomToken();
    const stored = {
      actor: {
        userId: `demo-owner-${workspace}`,
        tenantId: DEMO_TENANTS[workspace],
        role: 'owner' as const,
      },
      name: 'Demo owner',
      workspaceName: workspace === 'harbor' ? 'Harbor Table' : 'Juniper Kitchen',
      csrfToken: csrfToken(token),
      expiresAt: Date.now() + SESSION_TTL,
    };
    demoSessions.set(token, stored);
    requestSessions.set(request, stored);
    reply.setCookie(cookieName, token, { ...cookieOptions, maxAge: SESSION_TTL / 1000 });
    return sessionInfo(stored);
  });

  app.get('/api/auth/login', async (request, reply) => {
    consumeAuthRate(request);
    if (!oidcClient || !redirectUri || !store || !config.oidc)
      throw new AuthError('OIDC_DISABLED', 404, 'External sign-in is not configured.');
    const previousToken = readCookie(request, loginCookieName);
    if (previousToken)
      await store.cancelLoginAttempt({ ...databaseBinding(previousToken), redirectUri });
    const verifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(verifier);
    const token = randomToken();
    const attempt = { verifier, state: oidc.randomState(), nonce: oidc.randomNonce() };
    const url = oidc.buildAuthorizationUrl(oidcClient, {
      redirect_uri: redirectUri,
      scope: 'openid profile',
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(requireMfa
        ? {
            acr_values: 'http://schemas.openid.net/pape/policies/2007/06/multi-factor',
            max_age: '0',
          }
        : {}),
    });
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new AuthError('OIDC_UNAVAILABLE', 503, 'External sign-in is temporarily unavailable.');
    await store.createLoginAttempt({
      ...databaseBinding(token),
      redirectUri,
      encryptedPayload: encryptAttempt(token, attempt),
      expiresAt: new Date(Date.now() + LOGIN_TTL).toISOString(),
    });
    reply.setCookie(loginCookieName, token, { ...cookieOptions, maxAge: LOGIN_TTL / 1000 });
    return reply.redirect(url.href);
  });

  app.get('/api/auth/callback', async (request, reply) => {
    consumeAuthRate(request);
    if (!oidcClient || !redirectUri || !store || !config.oidc)
      throw new AuthError('OIDC_DISABLED', 404, 'External sign-in is not configured.');
    const token = readCookie(request, loginCookieName);
    // The shared store consumes before provider I/O, including concurrent callbacks on other replicas.
    const storedAttempt = token
      ? await store.consumeLoginAttempt({ ...databaseBinding(token), redirectUri })
      : null;
    reply.clearCookie(loginCookieName, cookieOptions);
    if (!token || !storedAttempt || Date.parse(storedAttempt.expiresAt) <= Date.now())
      throw new AuthError('LOGIN_EXPIRED', 400, 'Sign-in expired. Start again.');
    let attempt: z.infer<typeof loginAttemptSchema>;
    try {
      attempt = decryptAttempt(token, storedAttempt.encryptedPayload);
    } catch {
      throw new AuthError('LOGIN_FAILED', 401, 'Sign-in could not be verified. Start again.');
    }
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = new URL(request.url, dashboardOrigin).search;
    const suppliedStates = callbackUrl.searchParams.getAll('state');
    if (suppliedStates.length !== 1 || !constantTimeMatch(attempt.state, suppliedStates[0]))
      throw new AuthError('LOGIN_FAILED', 401, 'Sign-in could not be verified. Start again.');
    let claims: z.infer<typeof verifiedClaimsSchema>;
    try {
      const tokens = await oidc.authorizationCodeGrant(oidcClient, callbackUrl, {
        pkceCodeVerifier: attempt.verifier,
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
        ...(requireMfa ? { maxAge: 0 } : {}),
      });
      claims = verifiedClaimsSchema.parse(tokens.claims());
      if (claims.iss !== config.oidc.issuer) throw new Error('Issuer mismatch.');
    } catch {
      throw new AuthError('LOGIN_FAILED', 401, 'Sign-in could not be verified. Start again.');
    }
    const mfaVerified = claims.amr?.includes('mfa') === true;
    if (requireMfa && !mfaVerified)
      throw new AuthError('MFA_REQUIRED', 403, 'Complete multi-factor authentication to sign in.');
    await revokeSession(request);
    const sessionToken = randomToken();
    const binding = databaseBinding(sessionToken);
    const resolved = await store.issueSession({
      ...binding,
      subject: claims.sub,
      loginAttempt: { ...databaseBinding(token), redirectUri },
      expiresAt: new Date(Date.now() + SESSION_TTL).toISOString(),
      mfaVerifiedAt: mfaVerified ? new Date().toISOString() : null,
    });
    if (!resolved)
      throw new AuthError(
        'ACCESS_NOT_VERIFIED',
        403,
        'Your restaurant access could not be verified. Start sign-in again.',
      );
    reply.setCookie(cookieName, sessionToken, { ...cookieOptions, maxAge: SESSION_TTL / 1000 });
    return reply.redirect(dashboardOrigin);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const pendingToken = readCookie(request, loginCookieName);
    if (pendingToken && store && redirectUri)
      await store.cancelLoginAttempt({ ...databaseBinding(pendingToken), redirectUri });
    await revokeSession(request);
    reply.clearCookie(cookieName, cookieOptions);
    reply.clearCookie(loginCookieName, cookieOptions);
    return sessionInfo();
  });
  app.addHook('onClose', async () => service.close());
  return service;
}
