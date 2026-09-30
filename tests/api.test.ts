import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '@hostline/database';
import {
  bootstrapSchema,
  callSessionSchema,
  inboxItemSchema,
  sessionSchema,
  type CallSession,
} from '@hostline/contracts';
import { loadConfig } from '@hostline/config';
import { createApp } from '../apps/api/src/app.js';

const origin = 'http://127.0.0.1:5173';
describe('API integration against tenant-isolated PostgreSQL', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    db = await createDatabase();
    await db.seedDemo();
    app = await createApp(loadConfig({ NODE_ENV: 'test' }), db);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
  });
  async function login(workspace: 'harbor' | 'juniper') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { origin },
      payload: { workspace },
    });
    expect(response.statusCode).toBe(200);
    const session = sessionSchema.parse(response.json());
    const cookie = response.cookies.find((value) => value.name === 'hostline_session');
    if (!cookie || !session.csrfToken) throw new Error('Expected a signed session.');
    return { cookie: `${cookie.name}=${cookie.value}`, origin, 'x-csrf-token': session.csrfToken };
  }
  async function turn(call: CallSession, text: string, headers: Record<string, string>) {
    const result = await app.inject({
      method: 'POST',
      url: `/api/simulator/calls/${call.id}/turn`,
      headers,
      payload: { text, clientTurnId: randomUUID(), expectedVersion: call.version },
    });
    expect(result.statusCode).toBe(200);
    return callSessionSchema.parse(result.json());
  }
  async function message(headers: Record<string, string>) {
    const started = await app.inject({
      method: 'POST',
      url: '/api/simulator/calls',
      headers,
      payload: {},
    });
    let call = callSessionSchema.parse(started.json());
    for (const text of [
      'Leave a message',
      'Please call about a private dining event',
      'Taylor Example',
      '+12125550142',
    ])
      call = await turn(call, text, headers);
    expect(call.proposal?.kind).toBe('message');
    return call;
  }
  it('rejects unauthenticated access, cross-origin login, and unsafe missing-CSRF requests', async () => {
    expect((await app.inject('/api/bootstrap')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/demo',
          headers: { origin: 'https://attacker.example' },
          payload: { workspace: 'harbor' },
        })
      ).statusCode,
    ).toBe(403);
    const headers = await login('harbor');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/simulator/calls',
          headers: { origin, cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it('commits one message and returns the same result on concurrent exact retries', async () => {
    const headers = await login('harbor');
    const call = await message(headers);
    const payload = {
      proposalId: call.proposal?.id,
      expectedVersion: call.version,
      idempotencyKey: randomUUID(),
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'POST',
          url: `/api/simulator/calls/${call.id}/confirm`,
          headers,
          payload,
        }),
      ),
    );
    for (const result of results) expect(result.statusCode).toBe(200);
    expect(results[0]?.json()).toEqual(results[1]?.json());
    const saved = callSessionSchema.parse(results[0]?.json());
    expect(saved.status).toBe('message_saved');
    const bootstrap = bootstrapSchema.parse(
      (await app.inject({ url: '/api/bootstrap', headers })).json(),
    );
    expect(bootstrap.inbox.filter((item) => item.callId === call.id)).toHaveLength(1);
    const changed = await app.inject({
      method: 'POST',
      url: `/api/simulator/calls/${call.id}/confirm`,
      headers,
      payload: { ...payload, proposalId: randomUUID() },
    });
    expect(changed.statusCode).toBe(409);
  });
  it('isolates known call and inbox identifiers across tenant sessions', async () => {
    const harbor = await login('harbor');
    const call = await message(harbor);
    const saved = callSessionSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: `/api/simulator/calls/${call.id}/confirm`,
          headers: harbor,
          payload: {
            proposalId: call.proposal?.id,
            expectedVersion: call.version,
            idempotencyKey: randomUUID(),
          },
        })
      ).json(),
    );
    const juniper = await login('juniper');
    expect(
      (await app.inject({ url: `/api/inbox/${saved.inboxItemId}`, headers: harbor })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: `/api/inbox/${saved.inboxItemId}`, headers: juniper })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/api/simulator/calls/${call.id}`, headers: juniper })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/inbox/${saved.inboxItemId}`,
          headers: juniper,
          payload: { action: 'CLAIM', expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(404);
    const own = bootstrapSchema.parse(
      (await app.inject({ url: '/api/bootstrap', headers: juniper })).json(),
    );
    expect(own.restaurant.name).not.toBe('Harbor Table');
    expect(own.inbox.some((item) => item.callId === call.id)).toBe(false);
  });
  it('rejects stale edits and gates reservation confirmation after configuration changes', async () => {
    const headers = await login('harbor');
    const call = await message(headers);
    const before = bootstrapSchema.parse(
      (await app.inject({ url: '/api/bootstrap', headers })).json(),
    );
    const { id: _id, version, updatedAt: _updatedAt, ...settings } = before.restaurant;
    const input = {
      expectedVersion: version,
      settings: { ...settings, address: '12 Example Lane, New York' },
    };
    expect(
      (await app.inject({ method: 'PUT', url: '/api/restaurant', headers, payload: input }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/restaurant', headers, payload: input }))
        .statusCode,
    ).toBe(409);
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/simulator/calls/${call.id}/confirm`,
      headers,
      payload: {
        proposalId: call.proposal?.id,
        expectedVersion: call.version,
        idempotencyKey: randomUUID(),
      },
    });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json().error.code).toBe('CONFIG_CHANGED');
  });
  it('requires separate staff handling and communication before closing a message', async () => {
    const headers = await login('harbor');
    const call = await message(headers);
    const saved = callSessionSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: `/api/simulator/calls/${call.id}/confirm`,
          headers,
          payload: {
            proposalId: call.proposal?.id,
            expectedVersion: call.version,
            idempotencyKey: randomUUID(),
          },
        })
      ).json(),
    );
    const url = `/api/inbox/${saved.inboxItemId}`;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url,
          headers,
          payload: { action: 'CLOSE', expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);
    let item = inboxItemSchema.parse(
      (
        await app.inject({
          method: 'PATCH',
          url,
          headers,
          payload: { action: 'CLAIM', expectedVersion: 1 },
        })
      ).json(),
    );
    item = inboxItemSchema.parse(
      (
        await app.inject({
          method: 'PATCH',
          url,
          headers,
          payload: {
            action: 'RECORD_GUEST_NOTICE',
            expectedVersion: item.version,
            noticeNote: 'Synthetic callback completed; event information shared.',
          },
        })
      ).json(),
    );
    item = inboxItemSchema.parse(
      (
        await app.inject({
          method: 'PATCH',
          url,
          headers,
          payload: { action: 'CLOSE', expectedVersion: item.version },
        })
      ).json(),
    );
    expect(item.state).toBe('CLOSED');
  });
  it('does not expose internal voice context without its scoped credential', async () => {
    expect((await app.inject('/internal/voice/context')).statusCode).toBe(401);
    const headers = await login('harbor');
    expect((await app.inject({ url: '/internal/voice/context', headers })).statusCode).toBe(401);
  });
});

describe('startup guardrails', () => {
  it('blocks demo exposure, non-demo database attachment, and production activation', () => {
    expect(() => loadConfig({ API_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => loadConfig({ DASHBOARD_ORIGIN: 'https://public.example' })).toThrow(/loopback/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://localhost/customer' })).toThrow(
      /synthetic/,
    );
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/blocked/);
    expect(() => loadConfig({ AUTH_MODE: 'oidc' })).toThrow(/requires/);
  });
});
