import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type * as oidcModule from 'openid-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANTS, sessionSchema, type Role } from '@hostline/contracts';
import { loadConfig } from '@hostline/config';
import {
  createDatabase,
  inspectIdentityAccess,
  provisionIdentityAccess,
  type Database,
} from '@hostline/database';
import { createApp } from '../apps/api/src/app.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
// Replace only the provider transport. Real OIDC signature/claim checks,
// durable sessions, cookie verification and route authorization still execute.
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

const issuer = 'https://staff-access-identity.example/';
const origin = 'https://staff-access-dashboard.example';
const clientId = 'synthetic-staff-access-client';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'staff-access-key',
  alg: 'RS256',
  use: 'sig',
};
const sensitiveOutcome =
  'Synthetic caller Casey Stone (+12025550189) left a private follow-up note.';
let subject = '';
let nonce = '';

function idToken() {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer,
    aud: clientId,
    sub: subject,
    nonce,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd', 'mfa'],
  };
  const value = [{ alg: 'RS256', kid: jwk.kid }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return `${value}.${sign('RSA-SHA256', Buffer.from(value), keys.privateKey).toString('base64url')}`;
}

interface BrowserSession {
  cookie: string;
  csrfToken: string;
}

describe('staff privacy and owner authority with signed OIDC and durable sessions', () => {
  let app: FastifyInstance;
  let database: Database;
  let directory: string;
  let inboxId: string;
  let callId: string;
  let recoveryState: 'allow' | 'deny' | 'error' = 'allow';
  const sessions: Partial<Record<Role | 'foreignStaff', BrowserSession>> = {};

  beforeAll(async () => {
    transport.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin !== new URL(issuer).origin)
        throw new Error('Unexpected synthetic identity host.');
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
          access_token: 'synthetic-unused-provider-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken(),
        });
      throw new Error('Unexpected synthetic identity path.');
    });
    directory = await mkdtemp(join(tmpdir(), 'hostline-staff-access-'));
    const bootstrap = await createDatabase({ dataDir: directory });
    await bootstrap.seedDemo();
    await bootstrap.close();
    for (const role of ['owner', 'staff', 'viewer', 'foreignStaff'] as const) {
      const ref = {
        issuer,
        subject: `auth0|staff-access-${role}`,
        tenantId: role === 'foreignStaff' ? DEMO_TENANTS.juniper : DEMO_TENANTS.harbor,
      };
      const previous = await inspectIdentityAccess({ dataDir: directory }, ref);
      await provisionIdentityAccess(
        { dataDir: directory },
        {
          ...ref,
          displayName: `Synthetic ${role}`,
          workspaceName: 'Synthetic workspace',
          role: role === 'foreignStaff' ? 'staff' : role,
          identityEnabled: true,
          membershipEnabled: true,
          tenantEnabled: true,
          expectedIdentityVersion: previous.identity?.version ?? null,
          expectedMembershipVersion: previous.membership?.version ?? null,
          expectedTenantVersion: previous.tenant?.version ?? null,
        },
      );
    }
    database = await createDatabase({ dataDir: directory });
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      const inbox = (await tx.listInbox())[0];
      if (!inbox) throw new Error('Missing synthetic inbox fixture.');
      inboxId = inbox.id;
      callId = inbox.callId;
      const call = await tx.getCall(callId);
      if (!call) throw new Error('Missing synthetic call fixture.');
      await tx.saveCall(
        { ...call, version: call.version + 1, outcome: sensitiveOutcome },
        call.version,
      );
    });
    app = await createApp(
      loadConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'oidc',
        DASHBOARD_ORIGIN: origin,
        SESSION_SECRET: 'synthetic-staff-access-signing-secret-at-least-32',
        SESSION_ENCRYPTION_SECRET: 'independent-staff-access-encryption-secret-at-least-32',
        DATABASE_URL: 'postgresql://synthetic:unused@127.0.0.1/hostline_native_test',
        OIDC_ISSUER: issuer,
        OIDC_CLIENT_ID: clientId,
        OIDC_CLIENT_SECRET: 'synthetic-staff-access-client-secret',
        OIDC_REDIRECT_URI: `${origin}/api/auth/callback`,
      }),
      database,
      {
        recoveryGuard: async () => {
          if (recoveryState === 'error') throw new Error('Synthetic independent recovery failure');
          return recoveryState === 'allow';
        },
      },
    );
    await app.ready();
    for (const role of ['owner', 'staff', 'viewer', 'foreignStaff'] as const) {
      subject = `auth0|staff-access-${role}`;
      const login = await app.inject('/api/auth/login');
      expect(login.statusCode).toBe(302);
      const target = new URL(String(login.headers.location));
      nonce = target.searchParams.get('nonce') ?? '';
      const state = target.searchParams.get('state');
      const values = Array.isArray(login.headers['set-cookie'])
        ? login.headers['set-cookie']
        : [login.headers['set-cookie'] ?? ''];
      const loginCookie = values
        .find((value) => value.startsWith('__Host-hostline_login='))
        ?.split(';')[0];
      if (!loginCookie || !state || !nonce) throw new Error('Missing bound synthetic login.');
      const callback = await app.inject({
        url: `/api/auth/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: loginCookie },
      });
      expect(callback.statusCode).toBe(302);
      const callbacks = Array.isArray(callback.headers['set-cookie'])
        ? callback.headers['set-cookie']
        : [callback.headers['set-cookie'] ?? ''];
      const cookie = callbacks
        .find((value) => value.startsWith('__Host-hostline_session='))
        ?.split(';')[0];
      if (!cookie) throw new Error('Missing signed synthetic session cookie.');
      const response = await app.inject({ url: '/api/session', headers: { cookie } });
      const verified = sessionSchema.parse(response.json());
      expect(verified.authenticated).toBe(true);
      expect(verified.user?.role).toBe(role === 'foreignStaff' ? 'staff' : role);
      if (!verified.csrfToken) throw new Error('Missing verified CSRF token.');
      sessions[role] = { cookie, csrfToken: verified.csrfToken };
    }
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function headers(role: Role | 'foreignStaff', write = false) {
    const session = sessions[role];
    if (!session) throw new Error('Missing synthetic browser session.');
    return {
      cookie: session.cookie,
      ...(write ? { origin, 'x-csrf-token': session.csrfToken } : {}),
    };
  }

  it('gives viewers business configuration and minimal call summaries without caller details', async () => {
    const response = await app.inject({ url: '/api/bootstrap', headers: headers('viewer') });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.restaurant.id).toBe(DEMO_TENANTS.harbor);
    expect(body.inbox).toEqual([]);
    expect(body.calls.length).toBeGreaterThan(0);
    for (const call of body.calls) expect(call.outcome).toBeNull();
    expect(response.body).not.toContain('Casey Stone');
    expect(response.body).not.toContain('+12025550189');
    expect(response.body).not.toContain('private follow-up');
  });

  it('denies viewer direct inbox and conversation reads even when an ID is known', async () => {
    for (const url of ['/api/inbox', `/api/inbox/${inboxId}`, `/api/simulator/calls/${callId}`]) {
      const response = await app.inject({ url, headers: headers('viewer') });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(sensitiveOutcome);
    }
  });

  it('lets staff read their inbox and caller context while another tenant sees no matching records', async () => {
    const bootstrap = await app.inject({ url: '/api/bootstrap', headers: headers('staff') });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().inbox.length).toBeGreaterThan(0);
    expect(bootstrap.json().calls.find((call: { id: string }) => call.id === callId)?.outcome).toBe(
      sensitiveOutcome,
    );
    for (const url of ['/api/inbox', `/api/inbox/${inboxId}`, `/api/simulator/calls/${callId}`])
      expect((await app.inject({ url, headers: headers('staff') })).statusCode).toBe(200);
    for (const url of [`/api/inbox/${inboxId}`, `/api/simulator/calls/${callId}`])
      expect((await app.inject({ url, headers: headers('foreignStaff') })).statusCode).toBe(404);
    const foreign = await app.inject({ url: '/api/inbox', headers: headers('foreignStaff') });
    expect(foreign.json()).toEqual([]);
  });

  it('restricts phone policy changes to owners and persists their authenticated, CSRF-bound update', async () => {
    const original = await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy());
    const payload = {
      expectedVersion: original.version,
      policy: { voiceEnabled: false, requestsEnabled: false, transfersEnabled: false },
    };
    for (const role of ['staff', 'viewer'] as const)
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/phone/policy',
            headers: headers(role, true),
            payload,
          })
        ).statusCode,
      ).toBe(403);
    expect(await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy())).toEqual(
      original,
    );
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/phone/policy',
          headers: headers('owner'),
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/phone/policy',
      headers: headers('owner', true),
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy()),
    ).toMatchObject({
      version: original.version + 1,
      voiceEnabled: false,
      requestsEnabled: false,
      transfersEnabled: false,
    });
    expect(
      (await database.withTenant(DEMO_TENANTS.juniper, (tx) => tx.getPhonePolicy())).voiceEnabled,
    ).toBe(true);
  });

  it('quarantines business routes and readiness on missing recovery authority while preserving health and logout', async () => {
    try {
      for (const state of ['deny', 'error'] as const) {
        recoveryState = state;
        for (const url of [
          '/api/bootstrap',
          '/%61pi/bootstrap',
          '/api/inbox',
          '/api/session',
          '/api/auth/login',
        ]) {
          const response = await app.inject({ url, headers: headers('owner') });
          expect(response.statusCode).toBe(503);
          expect(response.body).not.toContain(sensitiveOutcome);
        }
        const internal = await app.inject({
          method: 'POST',
          url: '/%69nternal/voice/admit',
          payload: {},
        });
        expect(internal.statusCode).toBe(503);
        const ready = await app.inject('/api/ready');
        expect(ready.statusCode).toBe(503);
        expect(ready.json()).toEqual({ status: 'unavailable' });
        expect((await app.inject('/api/health')).statusCode).toBe(200);
      }
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: headers('owner', true),
        payload: {},
      });
      expect(logout.statusCode).toBe(200);
      expect(sessionSchema.parse(logout.json()).authenticated).toBe(false);
      recoveryState = 'allow';
      expect((await app.inject('/api/ready')).statusCode).toBe(200);
      expect(
        (await app.inject({ url: '/api/bootstrap', headers: headers('owner') })).statusCode,
      ).toBe(401);
    } finally {
      recoveryState = 'allow';
    }
  });
});
