import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TENANTS, type ProvisionIdentityAccess } from '@hostline/contracts';
import {
  createDatabase,
  inspectIdentityAccess,
  provisionIdentityAccess,
  inspectRestaurant,
  provisionRestaurant,
  type AuthSessionBinding,
  type Database,
  type LoginAttemptBinding,
} from '@hostline/database';
import { demoData } from '../packages/database/src/seed.js';

const issuer = 'https://identity.test.invalid/';
const clientId = 'synthetic-client';
const redirectUri = 'https://dashboard.test.invalid/api/auth/callback';
const hash = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const loginBinding = (): LoginAttemptBinding => ({
  tokenHash: hash(),
  issuer,
  clientId,
  redirectUri,
});
const sessionBinding = (): AuthSessionBinding => ({ tokenHash: hash(), issuer, clientId });
const future = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

async function claim(db: Database): Promise<LoginAttemptBinding> {
  const login = loginBinding();
  await db.auth.createLoginAttempt({
    ...login,
    encryptedPayload: 'opaque-authenticated-ciphertext',
    expiresAt: future(4),
  });
  expect(await db.auth.consumeLoginAttempt(login)).toMatchObject({
    encryptedPayload: 'opaque-authenticated-ciphertext',
  });
  return login;
}

describe('durable identity sessions, login cancellation and operator-only authority', () => {
  let directory: string;
  let db: Database;
  const reference = { issuer, subject: 'synthetic-owner', tenantId: DEMO_TENANTS.harbor };
  const base = {
    issuer,
    subject: 'synthetic-owner',
    tenantId: DEMO_TENANTS.harbor,
    displayName: 'Synthetic Owner',
    workspaceName: 'Harbor Table',
    role: 'owner' as const,
    identityEnabled: true,
    membershipEnabled: true,
    tenantEnabled: true,
  };
  async function edit(patch: Partial<typeof base>) {
    await db.close();
    const current = await inspectIdentityAccess({ dataDir: directory }, reference);
    await provisionIdentityAccess(
      { dataDir: directory },
      {
        ...base,
        ...patch,
        expectedIdentityVersion: current.identity?.version ?? null,
        expectedMembershipVersion: current.membership?.version ?? null,
        expectedTenantVersion: current.tenant?.version ?? null,
      },
    );
    db = await createDatabase({ dataDir: directory });
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hostline-identity-'));
    db = await createDatabase({ dataDir: directory });
    await db.seedDemo();
    await edit({});
  });
  afterAll(async () => {
    await db?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('never authorizes unknown subjects and enforces callback claim and issuer/client binding', async () => {
    const binding = sessionBinding();
    const login = await claim(db);
    expect(
      await db.auth.issueSession({
        ...binding,
        subject: 'unknown',
        expiresAt: future(60),
        loginAttempt: login,
      }),
    ).toBeNull();
    expect(
      await db.auth.issueSession({
        ...binding,
        subject: base.subject,
        clientId: 'another-client',
        expiresAt: future(60),
        loginAttempt: login,
      }),
    ).toBeNull();
    const session = await db.auth.issueSession({
      ...binding,
      subject: base.subject,
      expiresAt: future(60),
      loginAttempt: login,
      mfaVerifiedAt: new Date().toISOString(),
    });
    expect(session).toMatchObject({
      tenantId: DEMO_TENANTS.harbor,
      role: 'owner',
      displayName: 'Synthetic Owner',
    });
    expect(
      await db.auth.getSession({ ...binding, issuer: 'https://other.test.invalid/' }),
    ).toBeNull();
    expect(await db.auth.getSession({ ...binding, clientId: 'another-client' })).toBeNull();
    expect(
      await db.auth.issueSession({
        ...sessionBinding(),
        subject: base.subject,
        expiresAt: future(60),
        loginAttempt: login,
      }),
    ).toBeNull();
    await db.auth.revokeSession(binding);
  });

  it('claims login once across concurrent consumers without consuming another callback binding', async () => {
    const login = loginBinding();
    await db.auth.createLoginAttempt({
      ...login,
      encryptedPayload: 'encrypted-state-nonce-verifier',
      expiresAt: future(4),
    });
    expect(
      await db.auth.consumeLoginAttempt({
        ...login,
        redirectUri: 'https://other.test.invalid/callback',
      }),
    ).toBeNull();
    const results = await Promise.all([
      db.auth.consumeLoginAttempt(login),
      db.auth.consumeLoginAttempt(login),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await db.auth.cancelLoginAttempt(login);
  });

  it('logout cancels a claimed callback before external provider completion', async () => {
    const login = await claim(db);
    await db.auth.cancelLoginAttempt(login);
    expect(
      await db.auth.issueSession({
        ...sessionBinding(),
        subject: base.subject,
        expiresAt: future(60),
        loginAttempt: login,
      }),
    ).toBeNull();
  });

  it('logout also invalidates an issued session whose callback cookie has not arrived', async () => {
    const login = await claim(db);
    const binding = sessionBinding();
    expect(
      await db.auth.issueSession({
        ...binding,
        subject: base.subject,
        expiresAt: future(60),
        loginAttempt: login,
      }),
    ).not.toBeNull();
    await db.auth.cancelLoginAttempt({
      ...login,
      redirectUri: 'https://other.test.invalid/callback',
    });
    expect(await db.auth.getSession(binding)).not.toBeNull();
    await db.auth.cancelLoginAttempt(login);
    expect(await db.auth.getSession(binding)).toBeNull();
  });

  it('keeps absolute expiry stable while validating durable sessions and binding business transactions', async () => {
    const login = await claim(db);
    const binding = sessionBinding();
    const issued = await db.auth.issueSession({
      ...binding,
      subject: base.subject,
      expiresAt: future(60),
      loginAttempt: login,
    });
    await db.close();
    db = await createDatabase({ dataDir: directory });
    const read = await db.auth.getSession(binding);
    expect(read?.sessionId).toBe(issued?.sessionId);
    expect(read?.expiresAt).toBe(issued?.expiresAt);
    expect(Date.parse(read?.idleExpiresAt ?? '')).toBeLessThanOrEqual(
      Date.now() + 30 * 60_000 + 1000,
    );
    const target = await db.withAuthenticatedTenant(binding, async (tx, session) => ({
      restaurant: (await tx.getRestaurant()).id,
      sessionTenant: session.tenantId,
      foreign: await tx.getCall('31000000-0000-4000-8000-000000000099'),
    }));
    expect(target).toEqual({
      restaurant: DEMO_TENANTS.harbor,
      sessionTenant: DEMO_TENANTS.harbor,
      foreign: null,
    });
    await db.auth.revokeSession(binding);
    await db.close();
    db = await createDatabase({ dataDir: directory });
    expect(await db.auth.getSession(binding)).toBeNull();
    await expect(
      db.withAuthenticatedTenant(binding, (tx) => tx.getRestaurant()),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('membership suspension and reenablement never revive an older session', async () => {
    const binding = sessionBinding();
    await db.auth.issueSession({
      ...binding,
      subject: base.subject,
      expiresAt: future(60),
      loginAttempt: await claim(db),
    });
    await edit({ membershipEnabled: false });
    expect(await db.auth.getSession(binding)).toBeNull();
    expect(
      await db.auth.issueSession({
        ...sessionBinding(),
        subject: base.subject,
        expiresAt: future(60),
        loginAttempt: await claim(db),
      }),
    ).toBeNull();
    await edit({ membershipEnabled: true });
    expect(await db.auth.getSession(binding)).toBeNull();
    await db.seedDemo();
    expect(await db.auth.getSession(binding)).toBeNull();
  });

  it('tenant suspension fences staff and synthetic startup preserves suspension', async () => {
    const binding = sessionBinding();
    await db.auth.issueSession({
      ...binding,
      subject: base.subject,
      expiresAt: future(60),
      loginAttempt: await claim(db),
    });
    await edit({ tenantEnabled: false });
    await db.seedDemo();
    expect((await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getTenantAccess())).enabled).toBe(
      false,
    );
    expect(await db.auth.getSession(binding)).toBeNull();
    await edit({ tenantEnabled: true });
    expect(await db.auth.getSession(binding)).toBeNull();
  });

  it('operator stale versions conflict atomically without resurrecting access', async () => {
    await db.close();
    const current = await inspectIdentityAccess({ dataDir: directory }, reference);
    const input: ProvisionIdentityAccess = {
      ...base,
      expectedIdentityVersion: current.identity?.version ?? null,
      expectedMembershipVersion: current.membership?.version ?? null,
      expectedTenantVersion: current.tenant?.version ?? null,
    };
    await provisionIdentityAccess({ dataDir: directory }, { ...input, membershipEnabled: false });
    await expect(provisionIdentityAccess({ dataDir: directory }, input)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      (await inspectIdentityAccess({ dataDir: directory }, reference)).membership?.enabled,
    ).toBe(false);
    db = await createDatabase({ dataDir: directory });
    await edit({ membershipEnabled: true });
  });

  it('provisions restaurant metadata only through the explicit operator with CAS and suspended access', async () => {
    const restaurant = {
      ...demoData()[0]!.restaurant,
      id: randomUUID(),
      version: 1,
      name: 'Synthetic New Pilot',
    };
    await db.close();
    expect(await inspectRestaurant({ dataDir: directory }, { tenantId: restaurant.id })).toEqual({
      restaurant: null,
      tenantAccess: null,
    });
    const input = {
      restaurant,
      tenantEnabled: false,
      expectedRestaurantVersion: null,
      expectedTenantVersion: null,
    };
    const created = await provisionRestaurant({ dataDir: directory }, input);
    expect(created).toMatchObject({
      restaurant: { id: restaurant.id, version: 1 },
      tenantAccess: { version: 1, enabled: false, workspaceName: 'Synthetic New Pilot' },
    });
    await expect(provisionRestaurant({ dataDir: directory }, input)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const updated = await provisionRestaurant(
      { dataDir: directory },
      {
        restaurant: { ...restaurant, version: 2, name: 'Updated Synthetic Pilot' },
        tenantEnabled: true,
        expectedRestaurantVersion: 1,
        expectedTenantVersion: 1,
      },
    );
    expect(updated.tenantAccess).toMatchObject({
      version: 2,
      enabled: true,
      workspaceName: 'Updated Synthetic Pilot',
    });
    db = await createDatabase({ dataDir: directory });
    expect((await db.withTenant(restaurant.id, (tx) => tx.getRestaurant())).name).toBe(
      'Updated Synthetic Pilot',
    );
    expect(
      await db.auth.issueSession({
        ...sessionBinding(),
        subject: 'unprovisioned-subject',
        expiresAt: future(60),
        loginAttempt: await claim(db),
      }),
    ).toBeNull();
  });

  it('checks current schema and fixed roles using bounded readiness metadata', async () => {
    expect(await db.readiness()).toEqual({ ready: true, migrationVersion: 5 });
  });
});

describe('database auth broker privileges, idle expiration and durable ciphertext minimization', () => {
  let sql: PGlite;
  beforeAll(async () => {
    sql = new PGlite();
    await sql.waitReady;
    for (const file of [
      '001_initial.sql',
      '002_voice_calls.sql',
      '003_phone_operations.sql',
      '004_identity.sql',
    ])
      await sql.exec(
        await readFile(new URL(`../packages/database/migrations/${file}`, import.meta.url), 'utf8'),
      );
    for (const seed of demoData()) {
      await sql.query('INSERT INTO tenant_registry(id) VALUES($1)', [seed.restaurant.id]);
      await sql.query('INSERT INTO restaurants(tenant_id,version,document) VALUES($1,$2,$3)', [
        seed.restaurant.id,
        seed.restaurant.version,
        JSON.stringify(seed.restaurant),
      ]);
      await sql.query(
        'INSERT INTO auth_tenant_access(tenant_id,version,enabled,workspace_name) VALUES($1,1,true,$2)',
        [seed.restaurant.id, seed.restaurant.name],
      );
    }
  });
  afterAll(async () => {
    await sql.close();
  });
  async function role<T>(
    name: 'hostline_auth' | 'hostline_auth_broker' | 'hostline_app' | 'hostline_worker',
    work: () => Promise<T>,
  ) {
    await sql.exec(`BEGIN; SET LOCAL ROLE ${name};`);
    try {
      const result = await work();
      await sql.exec('COMMIT');
      return result;
    } catch (error) {
      await sql.exec('ROLLBACK');
      throw error;
    }
  }
  it.each(['hostline_auth', 'hostline_worker', 'hostline_app'] as const)(
    '%s cannot directly read auth token, identity or routing tables',
    async (name) => {
      for (const table of [
        'auth_sessions',
        'auth_login_attempts',
        'auth_identities',
        'auth_membership_routes',
        'auth_memberships',
      ])
        await expect(role(name, () => sql.query(`SELECT * FROM ${table}`))).rejects.toMatchObject({
          code: '42501',
        });
    },
  );
  it('auth broker cannot read caller content and has forced tenant isolation for memberships', async () => {
    for (const table of ['restaurants', 'calls', 'inbox', 'voice_calls', 'phone_handoffs'])
      await expect(
        role('hostline_auth_broker', () => sql.query(`SELECT * FROM ${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
    expect(
      await role('hostline_auth_broker', () => sql.query('SELECT * FROM auth_tenant_access')),
    ).toMatchObject({ rows: [] });
    const states = await sql.query(
      "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('hostline_auth','hostline_auth_broker') ORDER BY rolname",
    );
    expect(states.rows).toEqual([
      { rolname: 'hostline_auth', rolsuper: false, rolbypassrls: false },
      { rolname: 'hostline_auth_broker', rolsuper: false, rolbypassrls: false },
    ]);
  });
  it('public and worker cannot invoke auth lookup or issuance functions', async () => {
    await expect(
      role('hostline_worker', () =>
        sql.query('SELECT auth_read_session($1,$2,$3)', [hash(), issuer, clientId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await sql.query(
          "SELECT bool_and(NOT has_function_privilege('public',oid,'EXECUTE')) AS private FROM pg_proc WHERE proname LIKE 'auth_%'",
        )
      ).rows,
    ).toEqual([{ private: true }]);
  });
  it('claim clears encrypted payload while cancellation retains a bounded callback fence', async () => {
    const tokenHash = hash();
    await role('hostline_auth', () =>
      sql.query('SELECT auth_create_login($1,$2,$3,$4,$5,$6)', [
        tokenHash,
        issuer,
        clientId,
        redirectUri,
        'opaque-authenticated-ciphertext',
        future(4),
      ]),
    );
    await role('hostline_auth', () =>
      sql.query('SELECT auth_consume_login($1,$2,$3,$4)', [
        tokenHash,
        issuer,
        clientId,
        redirectUri,
      ]),
    );
    expect(
      (
        await sql.query(
          'SELECT token_hash,state,encrypted_payload FROM auth_login_attempts WHERE token_hash=$1',
          [tokenHash],
        )
      ).rows,
    ).toEqual([{ token_hash: tokenHash, state: 'CLAIMED', encrypted_payload: null }]);
    await role('hostline_auth', () =>
      sql.query('SELECT auth_cancel_login($1,$2,$3,$4)', [
        tokenHash,
        issuer,
        clientId,
        redirectUri,
      ]),
    );
    expect(
      (
        await sql.query(
          'SELECT state,encrypted_payload FROM auth_login_attempts WHERE token_hash=$1',
          [tokenHash],
        )
      ).rows,
    ).toEqual([{ state: 'CANCELLED', encrypted_payload: null }]);
  });
  it('rejects excessive lifetimes and bounds pending login storage for an application', async () => {
    expect(
      (
        await role('hostline_auth', () =>
          sql.query('SELECT auth_create_login($1,$2,$3,$4,$5,$6) AS created', [
            hash(),
            issuer,
            clientId,
            redirectUri,
            'ciphertext',
            future(6),
          ]),
        )
      ).rows,
    ).toEqual([{ created: false }]);
    await sql.query(
      "INSERT INTO auth_login_attempts(token_hash,issuer,client_id,redirect_uri,encrypted_payload,expires_at) SELECT lpad(to_hex(n),64,'0'),$1,$2,$3,'ciphertext',now()+interval '4 minutes' FROM generate_series(1,1000)n",
      [issuer, 'capped-client', redirectUri],
    );
    expect(
      (
        await role('hostline_auth', () =>
          sql.query('SELECT auth_create_login($1,$2,$3,$4,$5,$6) AS created', [
            hash(),
            issuer,
            'capped-client',
            redirectUri,
            'ciphertext',
            future(4),
          ]),
        )
      ).rows,
    ).toEqual([{ created: false }]);
  });
});
