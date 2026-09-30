import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import {
  DEMO_TENANTS,
  idSchema,
  roleSchema,
  type Actor,
  type Role,
  type SessionInfo,
} from '@hostline/contracts';

export interface AuthConfig {
  mode: 'demo' | 'oidc';
  dashboardOrigin: string;
  sessionSecret: string;
  secureCookies: boolean;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    memberships: Array<{ subject: string; tenantId: string; name: string; role: Role }>;
  };
}

export interface AuthService {
  actor(request: FastifyRequest): Actor;
  session(request: FastifyRequest): SessionInfo;
  requireRole(request: FastifyRequest, roles: Role[]): Actor;
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
  subject: string;
  name: string;
  workspaceName: string;
  csrfToken: string;
  expiresAt: number;
}

interface LoginAttempt {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

const SESSION_TTL = 8 * 60 * 60 * 1000;
const LOGIN_TTL = 5 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_PENDING_LOGINS = 1000;
const MAX_RATE_KEYS = 1000;
const AUTH_RATE_WINDOW = 60_000;
const AUTH_RATE_LIMIT = 20;
const demoLoginSchema = z.object({ workspace: z.enum(['harbor', 'juniper']) }).strict();
const membershipSchema = z
  .object({
    subject: z.string().min(1).max(255),
    tenantId: idSchema,
    name: z.string().min(1).max(100),
    role: roleSchema,
  })
  .strict();

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function constantTimeMatch(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || supplied.length > 128) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

/** Single-process development sessions. Durable sessions/revocation are a production launch gate. */
export async function registerAuth(app: FastifyInstance, config: AuthConfig): Promise<AuthService> {
  if (config.sessionSecret.length < 32)
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  const dashboardOrigin = new URL(config.dashboardOrigin).origin;
  if (!['http:', 'https:'].includes(new URL(config.dashboardOrigin).protocol))
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
  const sessions = new Map<string, StoredSession>();
  const loginAttempts = new Map<string, LoginAttempt>();
  const authRates = new Map<string, { count: number; expiresAt: number }>();
  const memberships = new Map<string, z.infer<typeof membershipSchema>>();
  let oidcClient: oidc.Configuration | undefined;
  let redirectUri: string | undefined;

  if (config.mode === 'oidc') {
    if (!config.oidc) throw new Error('OIDC configuration is required in OIDC mode.');
    const issuer = new URL(config.oidc.issuer);
    if (issuer.protocol !== 'https:') throw new Error('OIDC_ISSUER must use HTTPS.');
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
    for (const rawMembership of config.oidc.memberships) {
      const member = membershipSchema.parse(rawMembership);
      if (memberships.has(member.subject))
        throw new Error('Each OIDC subject must have exactly one configured workspace membership.');
      memberships.set(member.subject, member);
    }
    redirectUri = callback.href;
    oidcClient = await oidc.discovery(
      issuer,
      config.oidc.clientId,
      config.oidc.clientSecret,
      undefined,
      { timeout: 10 },
    );
  }

  function pruneExpired(): void {
    const now = Date.now();
    for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
    for (const [key, value] of loginAttempts) if (value.expiresAt <= now) loginAttempts.delete(key);
    for (const [key, value] of authRates) if (value.expiresAt <= now) authRates.delete(key);
  }

  function readCookie(request: FastifyRequest, name: string): string | undefined {
    const raw = request.cookies[name];
    if (!raw || raw.length > 256) return undefined;
    const unsigned = request.unsignCookie(raw);
    return unsigned.valid && unsigned.value ? unsigned.value : undefined;
  }

  function getSession(request: FastifyRequest): StoredSession | undefined {
    pruneExpired();
    const token = readCookie(request, cookieName);
    if (!token) return undefined;
    const stored = sessions.get(token);
    if (!stored) return undefined;
    if (config.mode === 'oidc') {
      const currentMembership = memberships.get(stored.subject);
      if (
        !currentMembership ||
        currentMembership.tenantId !== stored.actor.tenantId ||
        currentMembership.role !== stored.actor.role
      ) {
        sessions.delete(token);
        return undefined;
      }
    }
    return stored;
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

  function revokeSession(request: FastifyRequest): void {
    const token = readCookie(request, cookieName);
    if (token) sessions.delete(token);
  }

  function createSession(
    request: FastifyRequest,
    reply: FastifyReply,
    identity: Omit<StoredSession, 'csrfToken' | 'expiresAt'>,
  ): SessionInfo {
    pruneExpired();
    const previousToken = readCookie(request, cookieName);
    if (sessions.size >= MAX_SESSIONS && (!previousToken || !sessions.has(previousToken)))
      throw new AuthError(
        'AUTH_CAPACITY',
        503,
        'Sign-in is temporarily unavailable. Try again shortly.',
      );
    revokeSession(request);
    const token = randomToken();
    const stored = { ...identity, csrfToken: randomToken(), expiresAt: Date.now() + SESSION_TTL };
    sessions.set(token, stored);
    reply.setCookie(cookieName, token, { ...cookieOptions, maxAge: SESSION_TTL / 1000 });
    return sessionInfo(stored);
  }

  const service: AuthService = {
    actor(request) {
      const stored = getSession(request);
      if (!stored) throw new AuthError('UNAUTHENTICATED', 401, 'Sign in to continue.');
      return { ...stored.actor };
    },
    session(request) {
      return sessionInfo(getSession(request));
    },
    requireRole(request, roles) {
      const actor = service.actor(request);
      if (!roles.includes(actor.role))
        throw new AuthError('FORBIDDEN', 403, 'Your role cannot perform this action.');
      return actor;
    },
    close() {
      sessions.clear();
      loginAttempts.clear();
      authRates.clear();
    },
  };

  app.addHook('preHandler', async (request, reply) => {
    const pathname = request.url.split('?')[0] ?? '';
    if (!pathname.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (request.headers.origin !== dashboardOrigin)
      throw new AuthError('ORIGIN_REJECTED', 403, 'Request origin is not allowed.');
    if (pathname === '/api/auth/demo') return;
    const stored = getSession(request);
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
    return createSession(request, reply, {
      actor: {
        userId: `demo-owner-${workspace}`,
        tenantId: DEMO_TENANTS[workspace],
        role: 'owner',
      },
      subject: `demo-owner-${workspace}`,
      name: 'Demo owner',
      workspaceName: workspace === 'harbor' ? 'Harbor Table' : 'Juniper Kitchen',
    });
  });

  app.get('/api/auth/login', async (request, reply) => {
    consumeAuthRate(request);
    if (!oidcClient || !redirectUri)
      throw new AuthError('OIDC_DISABLED', 404, 'External sign-in is not configured.');
    const previousToken = readCookie(request, loginCookieName);
    if (previousToken) loginAttempts.delete(previousToken);
    if (loginAttempts.size >= MAX_PENDING_LOGINS)
      throw new AuthError(
        'AUTH_CAPACITY',
        503,
        'Sign-in is temporarily unavailable. Try again shortly.',
      );
    const verifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(verifier);
    const token = randomToken();
    const attempt = {
      verifier,
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      expiresAt: Date.now() + LOGIN_TTL,
    };
    const url = oidc.buildAuthorizationUrl(oidcClient, {
      redirect_uri: redirectUri,
      scope: 'openid profile',
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    loginAttempts.set(token, attempt);
    reply.setCookie(loginCookieName, token, { ...cookieOptions, maxAge: LOGIN_TTL / 1000 });
    return reply.redirect(url.href);
  });

  app.get('/api/auth/callback', async (request, reply) => {
    consumeAuthRate(request);
    if (!oidcClient || !redirectUri)
      throw new AuthError('OIDC_DISABLED', 404, 'External sign-in is not configured.');
    const token = readCookie(request, loginCookieName);
    const attempt = token ? loginAttempts.get(token) : undefined;
    // Consume before awaiting the provider: parallel/replayed callbacks cannot reuse a grant.
    if (token) loginAttempts.delete(token);
    reply.clearCookie(loginCookieName, cookieOptions);
    if (!attempt || attempt.expiresAt <= Date.now())
      throw new AuthError('LOGIN_EXPIRED', 400, 'Sign-in expired. Start again.');
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = new URL(request.url, dashboardOrigin).search;
    const suppliedStates = callbackUrl.searchParams.getAll('state');
    if (suppliedStates.length !== 1 || !constantTimeMatch(attempt.state, suppliedStates[0]))
      throw new AuthError('LOGIN_FAILED', 401, 'Sign-in could not be verified. Start again.');
    let subject: string | undefined;
    try {
      const tokens = await oidc.authorizationCodeGrant(oidcClient, callbackUrl, {
        pkceCodeVerifier: attempt.verifier,
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
      });
      subject = tokens.claims()?.sub;
    } catch {
      throw new AuthError('LOGIN_FAILED', 401, 'Sign-in could not be verified. Start again.');
    }
    const member = subject ? memberships.get(subject) : undefined;
    if (!member)
      throw new AuthError(
        'MEMBERSHIP_REQUIRED',
        403,
        'This account is not assigned to a restaurant workspace.',
      );
    createSession(request, reply, {
      actor: { userId: member.subject, tenantId: member.tenantId, role: member.role },
      subject: member.subject,
      name: member.name,
      workspaceName: 'Restaurant workspace',
    });
    return reply.redirect(dashboardOrigin);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    revokeSession(request);
    const pendingToken = readCookie(request, loginCookieName);
    if (pendingToken) loginAttempts.delete(pendingToken);
    reply.clearCookie(cookieName, cookieOptions);
    reply.clearCookie(loginCookieName, cookieOptions);
    return sessionInfo();
  });
  app.addHook('onClose', async () => service.close());
  return service;
}
