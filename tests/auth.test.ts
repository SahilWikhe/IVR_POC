import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANTS, sessionSchema, type ProvisionIdentityAccess } from '@hostline/contracts';
import {
  createDatabase,
  inspectIdentityAccess,
  provisionIdentityAccess,
  type AuthPersistence,
  type Database,
} from '@hostline/database';
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
  enableNonRepudiationChecks: vi.fn(),
}));

const origin = 'http://localhost:5173';
const apps: FastifyInstance[] = [];
const defaultConfig: AuthConfig = {
  mode: 'demo',
  dashboardOrigin: origin,
  sessionSecret: 'synthetic-test-secret-at-least-32-characters',
  sessionEncryptionSecret: 'separate-synthetic-encryption-secret-at-least-32',
  secureCookies: false,
};

let oidcDatabase: Database | undefined;
let oidcDataDir: string | undefined;
async function identityDatabase(): Promise<Database> {
  if (oidcDatabase) return oidcDatabase;
  oidcDataDir ??= await mkdtemp(join(tmpdir(), 'hostline-auth-composition-'));
  if (!oidcDatabase) {
    const bootstrap = await createDatabase({ dataDir: oidcDataDir });
    await bootstrap.seedDemo();
    await bootstrap.close();
    const reference = {
      issuer: 'https://identity.example',
      subject: 'staff-subject',
      tenantId: DEMO_TENANTS.harbor,
    };
    const prior = await inspectIdentityAccess({ dataDir: oidcDataDir }, reference);
    await provisionIdentityAccess(
      { dataDir: oidcDataDir },
      {
        ...reference,
        displayName: 'Synthetic Staff',
        workspaceName: 'Harbor Table',
        role: 'staff',
        identityEnabled: true,
        membershipEnabled: true,
        tenantEnabled: true,
        expectedIdentityVersion: prior.identity?.version ?? null,
        expectedMembershipVersion: prior.membership?.version ?? null,
        expectedTenantVersion: prior.tenant?.version ?? null,
      },
    );
    oidcDatabase = await createDatabase({ dataDir: oidcDataDir });
  }
  return oidcDatabase;
}

async function makeApp(overrides: Partial<AuthConfig> = {}, store?: AuthPersistence) {
  const app = Fastify();
  apps.push(app);
  const config = { ...defaultConfig, ...overrides };
  await app.register(cookie, { secret: config.sessionSecret });
  const auth = await registerAuth(
    app,
    config,
    config.mode === 'oidc' ? (store ?? (await identityDatabase()).auth) : undefined,
  );
  app.get('/api/private', async (request) => auth.actor(request));
  app.post('/api/change', async (request) => auth.requireRole(request, ['owner', 'staff']));
  app.get('/api/owner', async (request) => auth.requireRole(request, ['owner']));
  app.get('/internal/health', async () => ({ ok: true }));
  await app.ready();
  return { app, auth };
}

async function editFixtureAccess(
  change: Partial<
    Pick<
      ProvisionIdentityAccess,
      'role' | 'identityEnabled' | 'membershipEnabled' | 'tenantEnabled'
    >
  >,
) {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await oidcDatabase?.close();
  oidcDatabase = undefined;
  if (!oidcDataDir) throw new Error('Missing synthetic identity database.');
  const reference = {
    issuer: 'https://identity.example',
    subject: 'staff-subject',
    tenantId: DEMO_TENANTS.harbor,
  };
  const prior = await inspectIdentityAccess({ dataDir: oidcDataDir }, reference);
  await provisionIdentityAccess(
    { dataDir: oidcDataDir },
    {
      ...reference,
      displayName: 'Synthetic Staff',
      workspaceName: 'Harbor Table',
      role: prior.membership?.role ?? 'staff',
      identityEnabled: prior.identity?.enabled ?? true,
      membershipEnabled: prior.membership?.enabled ?? true,
      tenantEnabled: prior.tenant?.enabled ?? true,
      expectedIdentityVersion: prior.identity?.version ?? null,
      expectedMembershipVersion: prior.membership?.version ?? null,
      expectedTenantVersion: prior.tenant?.version ?? null,
      ...change,
    },
  );
  oidcDatabase = await createDatabase({ dataDir: oidcDataDir });
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
  provider.grant.mockReset().mockResolvedValue({
    claims: () => ({ iss: 'https://identity.example', sub: 'staff-subject' }),
  });
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

afterAll(async () => {
  await oidcDatabase?.close();
  if (oidcDataDir) await rm(oidcDataDir, { recursive: true, force: true });
});

describe('staff cookie sessions', () => {
  it('enforces Origin and CSRF on canonical routes reached through encoded static segments', async () => {
    const { app } = await makeApp();
    const encodedLogin = await app.inject({
      method: 'POST',
      url: '/%61pi/auth/demo',
      headers: { origin: 'https://attacker.example' },
      payload: { workspace: 'harbor' },
    });
    expect(encodedLogin.statusCode).toBe(403);
    expect(encodedLogin.cookies.some((entry) => entry.name === 'hostline_session')).toBe(false);
    const signedIn = await login(app);
    for (const url of ['/%61pi/auth/logout', '/api/%61uth/logout']) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { cookie: signedIn.cookie },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { cookie: signedIn.cookie, origin, 'x-csrf-token': 'wrong' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (await app.inject({ url: '/api/private', headers: { cookie: signedIn.cookie } })).statusCode,
    ).toBe(200);
  });
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
  requireMfa: false,
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
      claims: () => ({
        iss: 'https://identity.example',
        sub: 'unassigned',
        tenantId: DEMO_TENANTS.harbor,
        role: 'owner',
      }),
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function oidcSignIn(app: FastifyInstance, existingCookie?: string) {
  const started = await app.inject({
    url: '/api/auth/login',
    ...(existingCookie ? { headers: { cookie: existingCookie } } : {}),
  });
  expect(started.statusCode).toBe(302);
  const pendingCookie = responseCookie(started.headers['set-cookie'], 'hostline_login');
  const completed = await app.inject({
    url: '/api/auth/callback?code=synthetic-code&state=test-state',
    headers: { cookie: [existingCookie, pendingCookie].filter(Boolean).join('; ') },
  });
  expect(completed.statusCode).toBe(302);
  const cookie = responseCookie(completed.headers['set-cookie'], 'hostline_session');
  const session = sessionSchema.parse(
    (await app.inject({ url: '/api/session', headers: { cookie } })).json(),
  );
  return { cookie, pendingCookie, session };
}

describe('durable Auth0 BFF lifecycle with real PostgreSQL-engine persistence and a mocked provider', () => {
  it('preserves membership revocation through database restart and never revives old sessions after reenablement', async () => {
    const { app } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const previous = await oidcSignIn(app);
    try {
      await editFixtureAccess({ membershipEnabled: false });
      const { app: revoked } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
      expect(
        (await revoked.inject({ url: '/api/private', headers: { cookie: previous.cookie } }))
          .statusCode,
      ).toBe(401);
      const started = await revoked.inject('/api/auth/login');
      const rejected = await revoked.inject({
        url: '/api/auth/callback?code=synthetic-code&state=test-state',
        headers: {
          cookie: responseCookie(started.headers['set-cookie'], 'hostline_login'),
        },
      });
      expect(rejected.statusCode).toBe(403);
      await editFixtureAccess({ membershipEnabled: true });
      const { app: reenabled } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
      expect(
        (await reenabled.inject({ url: '/api/private', headers: { cookie: previous.cookie } }))
          .statusCode,
      ).toBe(401);
      expect((await oidcSignIn(reenabled)).session.user?.role).toBe('staff');
    } finally {
      await editFixtureAccess({ membershipEnabled: true });
    }
  });

  it('invalidates old role permissions and enforces suspended tenants using persisted versions', async () => {
    const { app } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const previous = await oidcSignIn(app);
    try {
      await editFixtureAccess({ role: 'viewer' });
      const { app: demoted } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
      expect(
        (await demoted.inject({ url: '/api/private', headers: { cookie: previous.cookie } }))
          .statusCode,
      ).toBe(401);
      const current = await oidcSignIn(demoted);
      expect(current.session.user?.role).toBe('viewer');
      expect(
        (
          await demoted.inject({
            method: 'POST',
            url: '/api/change',
            headers: {
              cookie: current.cookie,
              origin,
              'x-csrf-token': current.session.csrfToken ?? '',
            },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      await editFixtureAccess({ tenantEnabled: false });
      const { app: suspended } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
      expect(
        (await suspended.inject({ url: '/api/private', headers: { cookie: current.cookie } }))
          .statusCode,
      ).toBe(401);
    } finally {
      await editFixtureAccess({ role: 'staff', tenantEnabled: true });
    }
  });
  it('shares sessions across replicas and API restarts, with durable logout and stable CSRF binding', async () => {
    const { app: first } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const { app: second } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const signedIn = await oidcSignIn(first);
    const secondSession = sessionSchema.parse(
      (await second.inject({ url: '/api/session', headers: { cookie: signedIn.cookie } })).json(),
    );
    expect(secondSession).toEqual(signedIn.session);
    await first.close();
    const { app: restarted } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    expect(
      (await restarted.inject({ url: '/api/private', headers: { cookie: signedIn.cookie } }))
        .statusCode,
    ).toBe(200);
    const loggedOut = await second.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: signedIn.cookie,
        origin,
        'x-csrf-token': signedIn.session.csrfToken ?? '',
      },
    });
    expect(loggedOut.statusCode).toBe(200);
    expect(
      (await restarted.inject({ url: '/api/private', headers: { cookie: signedIn.cookie } }))
        .statusCode,
    ).toBe(401);
  });

  it('permits exactly one concurrent callback exchange across replicas', async () => {
    const { app: first } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const { app: second } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const started = await first.inject('/api/auth/login');
    const cookie = responseCookie(started.headers['set-cookie'], 'hostline_login');
    const entered = deferred<void>();
    const release = deferred<void>();
    provider.grant.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { claims: () => ({ iss: oidcConfig.issuer, sub: 'staff-subject' }) };
    });
    const pending = first
      .inject({
        url: '/api/auth/callback?code=synthetic-code&state=test-state',
        headers: { cookie },
      })
      .then((response) => response);
    await entered.promise;
    const replay = await second.inject({
      url: '/api/auth/callback?code=synthetic-code&state=test-state',
      headers: { cookie },
    });
    expect(replay.statusCode).toBe(400);
    release.resolve();
    expect((await pending).statusCode).toBe(302);
    expect(provider.grant).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight callback during logout without creating a replacement session', async () => {
    const { app: first } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const { app: second } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const signedIn = await oidcSignIn(first);
    const started = await first.inject({
      url: '/api/auth/login',
      headers: { cookie: signedIn.cookie },
    });
    const pendingCookie = responseCookie(started.headers['set-cookie'], 'hostline_login');
    const browserCookies = `${signedIn.cookie}; ${pendingCookie}`;
    const entered = deferred<void>();
    const release = deferred<void>();
    provider.grant.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { claims: () => ({ iss: oidcConfig.issuer, sub: 'staff-subject' }) };
    });
    const pending = first
      .inject({
        url: '/api/auth/callback?code=synthetic-code&state=test-state',
        headers: { cookie: browserCookies },
      })
      .then((response) => response);
    await entered.promise;
    const logout = await second.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: browserCookies,
        origin,
        'x-csrf-token': signedIn.session.csrfToken ?? '',
      },
    });
    expect(logout.statusCode).toBe(200);
    release.resolve();
    const callback = await pending;
    expect(callback.statusCode).toBe(403);
    expect(callback.cookies.some((entry) => entry.name === 'hostline_session')).toBe(false);
    expect(
      (await first.inject({ url: '/api/private', headers: { cookie: signedIn.cookie } }))
        .statusCode,
    ).toBe(401);
  });

  it('revokes a callback session whose response arrives after logout used the previous browser cookie', async () => {
    const { app: first } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const { app: second } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const previous = await oidcSignIn(first);
    const current = await oidcSignIn(first, previous.cookie);
    // Simulate browser requests already sent before the callback's Set-Cookie response was applied.
    const logout = await second.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: `${previous.cookie}; ${current.pendingCookie}`,
        origin,
        'x-csrf-token': previous.session.csrfToken ?? '',
      },
    });
    expect(logout.statusCode).toBe(200);
    expect(
      (await first.inject({ url: '/api/private', headers: { cookie: current.cookie } })).statusCode,
    ).toBe(401);
    expect(
      (await first.inject({ url: '/api/private', headers: { cookie: previous.cookie } }))
        .statusCode,
    ).toBe(401);
  });

  it('a newer login cancels an earlier callback already exchanging its code', async () => {
    const { app: first } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const { app: second } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const started = await first.inject('/api/auth/login');
    const cookie = responseCookie(started.headers['set-cookie'], 'hostline_login');
    const entered = deferred<void>();
    const release = deferred<void>();
    provider.grant.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { claims: () => ({ iss: oidcConfig.issuer, sub: 'staff-subject' }) };
    });
    const pending = first
      .inject({
        url: '/api/auth/callback?code=synthetic-code&state=test-state',
        headers: { cookie },
      })
      .then((response) => response);
    await entered.promise;
    const replacement = await second.inject({ url: '/api/auth/login', headers: { cookie } });
    expect(replacement.statusCode).toBe(302);
    release.resolve();
    expect((await pending).statusCode).toBe(403);
    const complete = await second.inject({
      url: '/api/auth/callback?code=synthetic-code&state=test-state',
      headers: {
        cookie: responseCookie(replacement.headers['set-cookie'], 'hostline_login'),
      },
    });
    expect(complete.statusCode).toBe(302);
  });

  it('binds attempts and sessions to their configured issuer and client without consuming another app grant', async () => {
    const { app: first } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const { app: other } = await makeApp({
      mode: 'oidc',
      oidc: { ...oidcConfig, clientId: 'different-client' },
    });
    const started = await first.inject('/api/auth/login');
    const cookie = responseCookie(started.headers['set-cookie'], 'hostline_login');
    expect(
      (
        await other.inject({
          url: '/api/auth/callback?code=synthetic-code&state=test-state',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(400);
    expect(provider.grant).not.toHaveBeenCalled();
    const completed = await first.inject({
      url: '/api/auth/callback?code=synthetic-code&state=test-state',
      headers: { cookie },
    });
    expect(completed.statusCode).toBe(302);
    const sessionCookie = responseCookie(completed.headers['set-cookie'], 'hostline_session');
    expect(
      (await other.inject({ url: '/api/private', headers: { cookie: sessionCookie } })).statusCode,
    ).toBe(401);
  });

  it('encrypts the verifier at rest and rejects authenticated-ciphertext tampering before code exchange', async () => {
    const db = await identityDatabase();
    const createLoginAttempt = vi.fn(db.auth.createLoginAttempt);
    const wrapped: AuthPersistence = {
      ...db.auth,
      createLoginAttempt,
      async consumeLoginAttempt(binding) {
        const consumed = await db.auth.consumeLoginAttempt(binding);
        if (!consumed) return null;
        const encrypted = JSON.parse(consumed.encryptedPayload) as Record<string, unknown>;
        encrypted['tag'] = 'AAAAAAAAAAAAAAAAAAAAAA';
        return { ...consumed, encryptedPayload: JSON.stringify(encrypted) };
      },
    };
    const { app } = await makeApp({ mode: 'oidc', oidc: oidcConfig }, wrapped);
    const started = await app.inject('/api/auth/login');
    const persisted = createLoginAttempt.mock.calls[0]?.[0];
    expect(persisted?.encryptedPayload).not.toContain('test-pkce-verifier');
    expect(persisted?.encryptedPayload).not.toContain('test-state');
    expect(persisted?.encryptedPayload).not.toContain('test-nonce');
    expect(persisted?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const failed = await app.inject({
      url: '/api/auth/callback?code=synthetic-code&state=test-state',
      headers: {
        cookie: responseCookie(started.headers['set-cookie'], 'hostline_login'),
      },
    });
    expect(failed.statusCode).toBe(401);
    expect(provider.grant).not.toHaveBeenCalled();
    expect(failed.body).not.toContain('test-pkce-verifier');
  });

  it('requires independent encryption credentials and enables maintained ID-token signature validation', async () => {
    const db = await identityDatabase();
    const { app } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    expect(provider.discovery).toHaveBeenCalledWith(
      new URL(oidcConfig.issuer),
      oidcConfig.clientId,
      { client_secret: oidcConfig.clientSecret, id_token_signed_response_alg: 'RS256' },
      undefined,
      { timeout: 10, execute: [expect.any(Function)] },
    );
    expect((await app.inject('/api/auth/login')).statusCode).toBe(302);
    await expect(
      makeApp(
        { mode: 'oidc', oidc: oidcConfig, sessionEncryptionSecret: defaultConfig.sessionSecret },
        db.auth,
      ),
    ).rejects.toThrow('must differ');
  });

  it('rejects missing MFA proof and password-only proof despite successful provider authentication', async () => {
    const { app } = await makeApp({ mode: 'oidc', oidc: { ...oidcConfig, requireMfa: true } });
    for (const amr of [undefined, ['pwd']]) {
      provider.grant.mockResolvedValueOnce({
        claims: () => ({ iss: oidcConfig.issuer, sub: 'staff-subject', ...(amr ? { amr } : {}) }),
      });
      const started = await app.inject('/api/auth/login');
      const destination = new URL(started.headers.location ?? '');
      expect(destination.searchParams.get('max_age')).toBe('0');
      expect(destination.searchParams.get('acr_values')).toBe(
        'http://schemas.openid.net/pape/policies/2007/06/multi-factor',
      );
      const failed = await app.inject({
        url: '/api/auth/callback?code=synthetic-code&state=test-state',
        headers: {
          cookie: responseCookie(started.headers['set-cookie'], 'hostline_login'),
        },
      });
      expect(failed.statusCode).toBe(403);
      expect(failed.cookies.some((entry) => entry.name === 'hostline_session')).toBe(false);
    }
  });

  it('accepts provider-verified MFA and rejects an earlier non-MFA session when enforcement is enabled', async () => {
    const { app: development } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    const earlier = await oidcSignIn(development);
    const { app: enforced } = await makeApp({
      mode: 'oidc',
      oidc: { ...oidcConfig, requireMfa: true },
    });
    expect(
      (await enforced.inject({ url: '/api/private', headers: { cookie: earlier.cookie } }))
        .statusCode,
    ).toBe(401);
    provider.grant.mockResolvedValueOnce({
      claims: () => ({ iss: oidcConfig.issuer, sub: 'staff-subject', amr: ['pwd', 'mfa'] }),
    });
    const verified = await oidcSignIn(enforced);
    expect(verified.session.authenticated).toBe(true);
    expect(provider.grant).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(URL),
      expect.objectContaining({ maxAge: 0 }),
    );
    expect(verified.session.user?.role).toBe('staff');
  });

  it('rejects a verified claim set bound to a different issuer without consulting role claims', async () => {
    const { app } = await makeApp({ mode: 'oidc', oidc: oidcConfig });
    provider.grant.mockResolvedValueOnce({
      claims: () => ({ iss: 'https://wrong-issuer.example', sub: 'staff-subject', role: 'owner' }),
    });
    const started = await app.inject('/api/auth/login');
    const rejected = await app.inject({
      url: '/api/auth/callback?code=synthetic-code&state=test-state',
      headers: {
        cookie: responseCookie(started.headers['set-cookie'], 'hostline_login'),
      },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.cookies.some((entry) => entry.name === 'hostline_session')).toBe(false);
  });
});
