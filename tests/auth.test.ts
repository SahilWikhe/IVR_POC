import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANTS, sessionSchema } from '@hostline/contracts';
import { registerAuth, type AuthConfig } from '../apps/api/src/auth.js';

const provider = vi.hoisted(() => ({ discovery: vi.fn(), grant: vi.fn(), authorization: vi.fn() }));
vi.mock('openid-client', () => ({
  discovery: provider.discovery,
  authorizationCodeGrant: provider.grant,
  randomPKCECodeVerifier: () => 'test-pkce-verifier',
  calculatePKCECodeChallenge: async () => 'test-pkce-challenge',
  randomState: () => 'test-state',
  randomNonce: () => 'test-nonce',
  buildAuthorizationUrl: provider.authorization,
}));

const origin = 'http://localhost:5173';
const apps: FastifyInstance[] = [];
const defaultConfig: AuthConfig = {
  mode: 'demo',
  dashboardOrigin: origin,
  sessionSecret: 'synthetic-test-secret-at-least-32-characters',
  secureCookies: false,
};

async function makeApp(overrides: Partial<AuthConfig> = {}) {
  const app = Fastify();
  apps.push(app);
  const config = { ...defaultConfig, ...overrides };
  await app.register(cookie, { secret: config.sessionSecret });
  const auth = await registerAuth(app, config);
  app.get('/api/private', async (request) => auth.actor(request));
  app.post('/api/change', async (request) => auth.requireRole(request, ['owner', 'staff']));
  app.get('/api/owner', async (request) => auth.requireRole(request, ['owner']));
  app.get('/internal/health', async () => ({ ok: true }));
  await app.ready();
  return { app, auth };
}

function responseCookie(raw: string | string[] | undefined, name: string): string {
  const values = Array.isArray(raw) ? raw : [raw ?? ''];
  const value = values.find((entry) => entry.startsWith(`${name}=`))?.split(';')[0];
  if (!value) throw new Error(`Expected ${name} cookie.`);
  return value;
}

async function login(
  app: FastifyInstance,
  workspace: 'harbor' | 'juniper' = 'harbor',
  existingCookie?: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/demo',
    headers: { origin, ...(existingCookie ? { cookie: existingCookie } : {}) },
    payload: { workspace },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: responseCookie(response.headers['set-cookie'], 'hostline_session'),
    session: sessionSchema.parse(response.json()),
  };
}

beforeEach(() => {
  provider.discovery.mockReset().mockResolvedValue({});
  provider.grant.mockReset().mockResolvedValue({ claims: () => ({ sub: 'staff-subject' }) });
  provider.authorization
    .mockReset()
    .mockImplementation((_client, params: Record<string, string>) => {
      const url = new URL('https://identity.example/authorize');
      url.search = new URLSearchParams(params).toString();
      return url;
    });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('staff cookie sessions', () => {
  it('requires a server session and does not accept caller-selected tenant or identity headers', async () => {
    const { app } = await makeApp();
    const session = await app.inject('/api/session');
    expect(session.statusCode).toBe(200);
    expect(sessionSchema.parse(session.json()).authenticated).toBe(false);
    expect(session.headers['cache-control']).toBe('no-store');
    const denied = await app.inject({
      url: '/api/private',
      headers: { 'x-tenant-id': DEMO_TENANTS.harbor, 'x-user-id': 'owner' },
    });
    expect(denied.statusCode).toBe(401);
    expect((await app.inject('/internal/health')).statusCode).toBe(200);
  });

  it('rejects cross-origin/missing-origin logins and tenant/role fields in login bodies', async () => {
    const { app } = await makeApp();
    for (const headers of [{}, { origin: 'https://attacker.example' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/demo',
        headers,
        payload: { workspace: 'harbor' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { origin },
      payload: { workspace: 'harbor', tenantId: DEMO_TENANTS.juniper, role: 'owner' },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('sets HttpOnly SameSite cookies and returns a server-derived actor', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { origin },
      payload: { workspace: 'harbor' },
    });
    const header = response.headers['set-cookie'];
    expect(header).toEqual(expect.stringContaining('HttpOnly'));
    expect(header).toEqual(expect.stringContaining('SameSite=Lax'));
    expect(header).toEqual(expect.stringContaining('Path=/'));
    const cookie = responseCookie(header, 'hostline_session');
    const result = await app.inject({
      url: `/api/private?tenantId=${DEMO_TENANTS.juniper}`,
      headers: { cookie, 'x-tenant-id': DEMO_TENANTS.juniper },
    });
    expect(result.json()).toEqual({
      userId: 'demo-owner-harbor',
      tenantId: DEMO_TENANTS.harbor,
      role: 'owner',
    });
    const invalidCookie = `${cookie}tampered`;
    expect(
      (await app.inject({ url: '/api/private', headers: { cookie: invalidCookie } })).statusCode,
    ).toBe(401);
  });

  it('requires both an exact origin and the session CSRF token on every mutation', async () => {
    const { app } = await makeApp();
    const signedIn = await login(app);
    for (const headers of [
      { cookie: signedIn.cookie, origin },
      { cookie: signedIn.cookie, origin, 'x-csrf-token': 'wrong' },
      {
        cookie: signedIn.cookie,
        origin: `${origin}.attacker.example`,
        'x-csrf-token': signedIn.session.csrfToken ?? '',
      },
      { cookie: signedIn.cookie, 'x-csrf-token': signedIn.session.csrfToken ?? '' },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: '/api/change', headers, payload: {} })).statusCode,
      ).toBe(403);
    }
    const success = await app.inject({
      method: 'POST',
      url: '/api/change',
      headers: {
        cookie: signedIn.cookie,
        origin,
        'x-csrf-token': signedIn.session.csrfToken ?? '',
      },
      payload: {},
    });
    expect(success.statusCode).toBe(200);
  });

  it('rotates login cookies and revokes the previous workspace session', async () => {
    const { app } = await makeApp();
    const harbor = await login(app);
    const juniper = await login(app, 'juniper', harbor.cookie);
    expect(juniper.cookie).not.toBe(harbor.cookie);
    expect(juniper.session.csrfToken).not.toBe(harbor.session.csrfToken);
    expect(juniper.session.workspace?.id).toBe(DEMO_TENANTS.juniper);
    expect(
      (await app.inject({ url: '/api/private', headers: { cookie: harbor.cookie } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: '/api/private', headers: { cookie: juniper.cookie } })).json()
        .tenantId,
    ).toBe(DEMO_TENANTS.juniper);
    const mixedToken = await app.inject({
      method: 'POST',
      url: '/api/change',
      headers: { cookie: juniper.cookie, origin, 'x-csrf-token': harbor.session.csrfToken ?? '' },
      payload: {},
    });
    expect(mixedToken.statusCode).toBe(403);
  });

  it('revokes logout and expires sessions after eight hours', async () => {
    const { app } = await makeApp();
    const signedIn = await login(app);
    const loggedOut = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: signedIn.cookie,
        origin,
        'x-csrf-token': signedIn.session.csrfToken ?? '',
      },
    });
    expect(loggedOut.statusCode).toBe(200);
    expect(sessionSchema.parse(loggedOut.json()).authenticated).toBe(false);
    expect(
      (await app.inject({ url: '/api/private', headers: { cookie: signedIn.cookie } })).statusCode,
    ).toBe(401);
    const second = await login(app);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
    expect(
      (await app.inject({ url: '/api/private', headers: { cookie: second.cookie } })).statusCode,
    ).toBe(401);
  });

  it('limits sign-in attempts without reflecting credentials or submitted fields', async () => {
    const { app } = await makeApp();
    for (let index = 0; index < 20; index += 1) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/demo',
            headers: { origin },
            payload: { workspace: 'invalid' },
          })
        ).statusCode,
      ).toBe(400);
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { origin },
      payload: { workspace: 'harbor' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.body).not.toContain(defaultConfig.sessionSecret);
  });
});

const oidcConfig: AuthConfig['oidc'] = {
  issuer: 'https://identity.example',
  clientId: 'test-client',
  clientSecret: 'synthetic-client-secret',
  redirectUri: `${origin}/api/auth/callback`,
  memberships: [
    {
      subject: 'staff-subject',
      tenantId: DEMO_TENANTS.harbor,
      name: 'Synthetic Staff',
      role: 'staff',
    },
  ],
};

describe('OIDC flow composition with a mocked provider', () => {
  it('binds login to PKCE, state, nonce and a one-use browser cookie; enforces mapped roles', async () => {
    const { app } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/demo',
          headers: { origin },
          payload: { workspace: 'harbor' },
        })
      ).statusCode,
    ).toBe(404);
    const start = await app.inject('/api/auth/login');
    expect(start.statusCode).toBe(302);
    const destination = new URL(start.headers.location ?? '');
    expect(destination.searchParams.get('code_challenge_method')).toBe('S256');
    expect(destination.searchParams.get('state')).toBe('test-state');
    expect(destination.searchParams.get('nonce')).toBe('test-nonce');
    const loginCookie = responseCookie(start.headers['set-cookie'], 'hostline_login');
    const callback = await app.inject({
      url: '/api/auth/callback?code=synthetic-code&state=test-state',
      headers: { cookie: loginCookie, host: 'attacker.example' },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(origin);
    expect(provider.grant).toHaveBeenCalledWith(
      expect.anything(),
      new URL(`${origin}/api/auth/callback?code=synthetic-code&state=test-state`),
      {
        pkceCodeVerifier: 'test-pkce-verifier',
        expectedState: 'test-state',
        expectedNonce: 'test-nonce',
        idTokenExpected: true,
      },
    );
    const cookie = responseCookie(callback.headers['set-cookie'], 'hostline_session');
    const session = sessionSchema.parse(
      (await app.inject({ url: '/api/session', headers: { cookie } })).json(),
    );
    expect(session.user?.role).toBe('staff');
    expect(session.workspace?.id).toBe(DEMO_TENANTS.harbor);
    expect((await app.inject({ url: '/api/owner', headers: { cookie } })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/change',
          headers: { cookie, origin, 'x-csrf-token': session.csrfToken ?? '' },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: '/api/auth/callback?code=synthetic-code&state=test-state',
          headers: { cookie: loginCookie },
        })
      ).statusCode,
    ).toBe(400);
    expect(provider.grant).toHaveBeenCalledTimes(1);
  });

  it('fails closed for an unassigned identity and hides provider errors', async () => {
    const { app } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    provider.grant.mockResolvedValueOnce({
      claims: () => ({ sub: 'unassigned', tenantId: DEMO_TENANTS.harbor, role: 'owner' }),
    });
    const first = await app.inject('/api/auth/login');
    const missingMember = await app.inject({
      url: '/api/auth/callback?code=synthetic-code&state=test-state',
      headers: { cookie: responseCookie(first.headers['set-cookie'], 'hostline_login') },
    });
    expect(missingMember.statusCode).toBe(403);
    expect(missingMember.cookies.some((entry) => entry.name === 'hostline_session')).toBe(false);
    provider.grant.mockRejectedValueOnce(new Error('provider-secret-in-internal-error'));
    const second = await app.inject('/api/auth/login');
    const failed = await app.inject({
      url: '/api/auth/callback?code=synthetic-code&state=test-state',
      headers: { cookie: responseCookie(second.headers['set-cookie'], 'hostline_login') },
    });
    expect(failed.statusCode).toBe(401);
    expect(failed.body).not.toContain('provider-secret-in-internal-error');
  });

  it('rejects absent and expired browser grants before contacting the token endpoint', async () => {
    const { app } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    expect(
      (await app.inject('/api/auth/callback?code=synthetic-code&state=test-state')).statusCode,
    ).toBe(400);
    const start = await app.inject('/api/auth/login');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    expect(
      (
        await app.inject({
          url: '/api/auth/callback?code=synthetic-code&state=test-state',
          headers: { cookie: responseCookie(start.headers['set-cookie'], 'hostline_login') },
        })
      ).statusCode,
    ).toBe(400);
    expect(provider.grant).not.toHaveBeenCalled();
  });

  it('rejects mismatched or repeated state values before exchanging a code', async () => {
    const { app } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    for (const stateQuery of ['state=wrong-state', 'state=test-state&state=test-state']) {
      const start = await app.inject('/api/auth/login');
      const response = await app.inject({
        url: `/api/auth/callback?code=synthetic-code&${stateQuery}`,
        headers: { cookie: responseCookie(start.headers['set-cookie'], 'hostline_login') },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(provider.grant).not.toHaveBeenCalled();
  });

  it('uses host-only secure cookie names for HTTPS sessions', async () => {
    const { app } = await makeApp({
      mode: 'oidc',
      dashboardOrigin: 'https://dashboard.example',
      secureCookies: true,
      oidc: { ...oidcConfig, redirectUri: 'https://dashboard.example/api/auth/callback' },
    });
    const start = await app.inject('/api/auth/login');
    const raw = start.headers['set-cookie'];
    expect(raw).toEqual(expect.stringContaining('__Host-hostline_login='));
    expect(raw).toEqual(expect.stringContaining('Secure'));
    expect(raw).not.toEqual(expect.stringContaining('Domain='));
  });
});
