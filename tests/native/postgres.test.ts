import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TENANTS, type CallSession, type VoiceCallRecord } from '@hostline/contracts';
import {
  createDatabase,
  inspectIdentityAccess,
  migrate,
  provisionIdentityAccess,
  type AuthSessionBinding,
  type Database,
  type LoginAttemptBinding,
} from '@hostline/database';
import { demoData } from '../../packages/database/src/seed.js';
import {
  inspectRestoredAuthority,
  quarantineRestoredDatabase,
} from '../../packages/database/src/recovery-operator.js';
import type { RecoveryAuthority, RecoveryManifest } from '../../packages/database/src/privacy.js';
import { nativeTestUrl } from './url.js';

const configured = process.env['TEST_DATABASE_URL'];
if (process.env['HOSTLINE_NATIVE_TEST_REQUIRED'] === 'true' && !configured) {
  throw new Error('A required native conformance run cannot skip TEST_DATABASE_URL.');
}
// Ordinary deterministic checks show an explicit skip. CI uses test:native,
// which requires a destination and refuses remote/production database names.
const destination = configured ? nativeTestUrl(configured) : undefined;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const migratorName = `hostline_native_migrator_${suffix}`;
const runtimeName = `hostline_native_runtime_${suffix}`;
const fixturePassword = randomUUID();
const migration = (file: string) =>
  readFile(new URL(`../../packages/database/migrations/${file}`, import.meta.url), 'utf8');

function asRole(url: string, role: string, applicationName: string): string {
  const value = new URL(url);
  value.username = role;
  value.password = fixturePassword;
  value.searchParams.set('application_name', applicationName);
  return value.toString();
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function phoneFixture(): { call: CallSession; voice: VoiceCallRecord } {
  const id = randomUUID();
  const stamp = new Date().toISOString();
  return {
    call: {
      id,
      version: 1,
      mode: 'voice',
      status: 'active',
      phase: 'idle',
      draft: {},
      messages: [],
      proposal: null,
      outcome: null,
      inboxItemId: null,
      createdAt: stamp,
      updatedAt: stamp,
    },
    voice: {
      id,
      version: 1,
      policyVersion: 1,
      providerCallSid: `CA${randomUUID().replaceAll('-', '')}`,
      accountSid: `AC${'a'.repeat(32)}`,
      state: 'WAITING_FOR_STREAM',
      generation: randomUUID(),
      // Expired leases still hold capacity until authoritative terminal state.
      leaseExpiresAt: '2020-01-01T00:00:00Z',
      streamSid: null,
      streamGrantHash: 'a'.repeat(64),
      streamGrantExpiresAt: '2020-01-01T00:00:00Z',
      entryTwiml: '<Response><Say>Synthetic fixture</Say></Response>',
      controlId: null,
      controlKind: null,
      controlState: null,
      controlTwiml: null,
      confirmationGrantHash: null,
      confirmationExpiresAt: null,
      proposalId: null,
      transferDestination: null,
      transferChildSid: null,
      outcome: null,
      createdAt: stamp,
      updatedAt: stamp,
      endedAt: null,
    },
  };
}

describe.skipIf(!destination)(
  'native PostgreSQL restricted-role and concurrent transaction conformance',
  () => {
    let admin: pg.Pool;
    let migrator: pg.Pool;
    let runtime: pg.Pool;
    let first: Database;
    let second: Database;
    let expectedMigrationVersions: number[];

    beforeAll(async () => {
      if (!destination) throw new Error('Missing native test destination.');
      expectedMigrationVersions = (
        await readdir(new URL('../../packages/database/migrations/', import.meta.url))
      )
        .flatMap((file) => (/^\d{3}_[a-z_]+\.sql$/.test(file) ? [Number.parseInt(file, 10)] : []))
        .sort((a, b) => a - b);
      admin = new pg.Pool({ connectionString: destination, max: 3, connectionTimeoutMillis: 5000 });
      const identity = await admin.query(
        "SELECT current_database() AS name, current_user AS role, current_setting('server_version') AS version",
      );
      expect(identity.rows[0]?.name).toMatch(/^hostline_native_test(?:_[a-z0-9]+)?$/);
      expect(Number.parseInt(String(identity.rows[0]?.version), 10)).toBeGreaterThanOrEqual(16);
      const occupied = await admin.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
      );
      if (occupied.rowCount !== 0) {
        throw new Error(
          'Native fixtures require a fresh empty disposable database; no reset is performed.',
        );
      }
      // These names and credentials are generated synthetic fixtures. Migration
      // ownership and runtime membership are deliberately separate identities.
      await admin.query(
        `CREATE ROLE ${migratorName} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD '${fixturePassword}'`,
      );
      await admin.query(
        `CREATE ROLE ${runtimeName} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '${fixturePassword}'`,
      );
      await admin.query(`ALTER SCHEMA public OWNER TO ${migratorName}`);
      // PostgreSQL roles are cluster-wide. A new disposable database may share
      // an already-created group role; explicit bootstrap administration lets
      // its dedicated non-superuser migrator grant reviewed function ownership.
      for (const role of [
        'hostline_app',
        'hostline_worker',
        'hostline_auth',
        'hostline_auth_broker',
      ]) {
        const existing = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
        if (!existing.rowCount)
          await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        await admin.query(`GRANT ${role} TO ${migratorName} WITH ADMIN OPTION`);
      }
      migrator = new pg.Pool({
        connectionString: asRole(destination, migratorName, 'hostline_native_migrate'),
        max: 2,
      });
      const client = await migrator.connect();
      try {
        await client.query('BEGIN');
        await client.query(await migration('001_initial.sql'));
        for (const seed of demoData()) {
          await client.query('INSERT INTO tenant_registry(id) VALUES($1)', [seed.restaurant.id]);
          await client.query("SELECT set_config('hostline.tenant_id',$1,true)", [
            seed.restaurant.id,
          ]);
          await client.query(
            'INSERT INTO restaurants(tenant_id,version,document) VALUES($1,$2,$3::jsonb)',
            [seed.restaurant.id, seed.restaurant.version, JSON.stringify(seed.restaurant)],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      // In particular migration 003 must backfill two existing FORCE-RLS rows
      // while its table-owning migrator has neither superuser nor BYPASSRLS.
      await migrate(asRole(destination, migratorName, 'hostline_native_migrate'));
      await admin.query(`GRANT hostline_app, hostline_worker, hostline_auth TO ${runtimeName}`);
      runtime = new pg.Pool({
        connectionString: asRole(destination, runtimeName, 'hostline_native_raw'),
        max: 1,
      });
      first = await createDatabase({
        url: asRole(destination, runtimeName, 'hostline_native_first'),
      });
      second = await createDatabase({
        url: asRole(destination, runtimeName, 'hostline_native_second'),
      });
    });

    afterAll(async () => {
      await Promise.allSettled([
        first?.close(),
        second?.close(),
        runtime?.end(),
        migrator?.end(),
        admin?.end(),
      ]);
    });

    async function restricted<T>(
      tenantId: string | null,
      work: (client: pg.PoolClient) => Promise<T>,
    ): Promise<T> {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE hostline_app');
        await client.query("SELECT set_config('hostline.tenant_id',$1,true)", [tenantId ?? '']);
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    async function awaitSecondLock(applicationName = 'hostline_native_second'): Promise<void> {
      const deadline = Date.now() + 1200;
      do {
        const result = await admin.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [applicationName],
        );
        if (result.rowCount) return;
        await delay(10);
      } while (Date.now() < deadline);
      throw new Error('The separate PostgreSQL connection did not wait on the expected lock.');
    }

    it('backfills every existing tenant with a non-superuser, non-bypass migrator and applies migrations once', async () => {
      const role = await migrator.query(
        'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      for (const tenant of Object.values(DEMO_TENANTS)) {
        expect(await first.withTenant(tenant, (tx) => tx.getPhonePolicy())).toMatchObject({
          version: 1,
          voiceEnabled: true,
        });
      }
      const previous = (
        await migrator.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')
      ).rows;
      expect(previous.map((row) => row.version)).toEqual(expectedMigrationVersions);
      if (!destination) throw new Error('Missing destination.');
      await Promise.all([
        migrate(asRole(destination, migratorName, 'hostline_native_migrate')),
        migrate(asRole(destination, migratorName, 'hostline_native_migrate')),
      ]);
      expect(
        (await migrator.query('SELECT version,applied_at FROM schema_migrations ORDER BY version'))
          .rows,
      ).toEqual(previous);
      await expect(first.seedDemo()).rejects.toMatchObject({ code: 'DEMO_REQUIRES_EMBEDDED' });
    });

    it('enforces FORCE RLS with a non-owner runtime role and denies provisioning/worker privileges', async () => {
      await restricted(DEMO_TENANTS.harbor, async (client) => {
        expect(
          (
            await client.query(
              'SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
            )
          ).rows,
        ).toEqual([{ name: 'hostline_app', rolsuper: false, rolbypassrls: false }]);
        const tables = await client.query(
          "SELECT relname,relrowsecurity,relforcerowsecurity,relowner::regrole::text AS owner FROM pg_class WHERE relname IN ('restaurants','calls','inbox','voice_calls','phone_policies','phone_handoffs','receipts','outbox','jobs') ORDER BY relname",
        );
        expect(tables.rows).toHaveLength(9);
        for (const table of tables.rows)
          expect(table).toMatchObject({
            relrowsecurity: true,
            relforcerowsecurity: true,
            owner: migratorName,
          });
        expect((await client.query('SELECT tenant_id FROM restaurants')).rows).toEqual([
          { tenant_id: DEMO_TENANTS.harbor },
        ]);
        expect(
          (
            await client.query(
              'UPDATE restaurants SET version=version WHERE tenant_id=$1 RETURNING tenant_id',
              [DEMO_TENANTS.juniper],
            )
          ).rows,
        ).toEqual([]);
      });
      await expect(
        restricted(DEMO_TENANTS.harbor, (client) => client.query('SELECT * FROM tenant_registry')),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        restricted(DEMO_TENANTS.harbor, (client) => client.query('SELECT * FROM discover_work(5)')),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        restricted(DEMO_TENANTS.harbor, (client) =>
          client.query(
            'INSERT INTO receipts(tenant_id,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4)',
            [DEMO_TENANTS.juniper, randomUUID(), 'fixture', '{}'],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('clears transaction-local role and tenant on the same pooled connection after commit and rollback', async () => {
      const pids: number[] = [];
      for (const tenant of [DEMO_TENANTS.harbor, DEMO_TENANTS.juniper]) {
        await restricted(tenant, async (client) => {
          pids.push(Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid));
          expect((await client.query('SELECT tenant_id FROM restaurants')).rows).toEqual([
            { tenant_id: tenant },
          ]);
        });
        const reset = await runtime.query(
          "SELECT current_user AS role, nullif(current_setting('hostline.tenant_id',true),'') AS tenant",
        );
        expect(reset.rows).toEqual([{ role: runtimeName, tenant: null }]);
      }
      await expect(
        restricted(DEMO_TENANTS.harbor, async (client) => {
          await client.query(
            'INSERT INTO receipts(tenant_id,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4)',
            [DEMO_TENANTS.harbor, 'rolled-back-native', 'fixture', '{}'],
          );
          throw new Error('Expected synthetic rollback');
        }),
      ).rejects.toThrow('Expected synthetic rollback');
      expect(new Set(pids).size).toBe(1);
      expect(
        (
          await runtime.query(
            "SELECT current_user AS role,nullif(current_setting('hostline.tenant_id',true),'') AS tenant",
          )
        ).rows,
      ).toEqual([{ role: runtimeName, tenant: null }]);
      await restricted(null, async (client) =>
        expect((await client.query('SELECT tenant_id FROM restaurants')).rows).toEqual([]),
      );
      expect(
        await first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getReceipt('rolled-back-native')),
      ).toBeNull();
    });

    it('keeps simultaneous tenant contexts separate across independent pools and rolls back an entire failed operation', async () => {
      const held = deferred();
      const release = deferred();
      const key = randomUUID();
      const original = await first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant());
      const failing = first.withTenant(DEMO_TENANTS.harbor, async (tx) => {
        await tx.saveRestaurant(
          { ...original, name: 'Must roll back', version: original.version + 1 },
          original.version,
        );
        await tx.putReceipt(key, 'fixture', {});
        await tx.enqueue('restaurant.updated', original.id);
        held.resolve();
        await release.promise;
        expect((await tx.getRestaurant()).id).toBe(DEMO_TENANTS.harbor);
        throw new Error('Expected synthetic rollback');
      });
      await held.promise;
      try {
        expect((await second.withTenant(DEMO_TENANTS.juniper, (tx) => tx.getRestaurant())).id).toBe(
          DEMO_TENANTS.juniper,
        );
        expect(
          await second.withTenant(DEMO_TENANTS.juniper, (tx) => tx.getReceipt(key)),
        ).toBeNull();
      } finally {
        release.resolve();
      }
      await expect(failing).rejects.toThrow('Expected synthetic rollback');
      expect((await first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant())).name).toBe(
        original.name,
      );
      expect(await first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getReceipt(key))).toBeNull();
      expect(await first.processJobs()).toBe(0);
    });

    it('serializes count-and-insert admission on separate connections and retains expired holds', async () => {
      const winner = phoneFixture();
      const contender = phoneFixture();
      const held = deferred();
      const release = deferred();
      const admitted = first.withTenant(DEMO_TENANTS.harbor, async (tx) => {
        await tx.lockVoiceAdmission();
        expect(await tx.countActiveVoiceCalls(new Date())).toBe(0);
        held.resolve();
        await release.promise;
        await tx.insertCall(winner.call);
        await tx.insertVoiceCall(winner.voice);
        return true;
      });
      await held.promise;
      const competing = second.withTenant(DEMO_TENANTS.harbor, async (tx) => {
        await tx.lockVoiceAdmission();
        if ((await tx.countActiveVoiceCalls(new Date())) >= 1) return false;
        await tx.insertCall(contender.call);
        await tx.insertVoiceCall(contender.voice);
        return true;
      });
      try {
        await awaitSecondLock();
      } finally {
        release.resolve();
      }
      expect(await Promise.all([admitted, competing])).toEqual([true, false]);
      expect(
        await first.withTenant(DEMO_TENANTS.harbor, (tx) =>
          tx.countActiveVoiceCalls(new Date('2030-01-01T00:00:00Z')),
        ),
      ).toBe(1);
      expect(
        await first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getCall(contender.call.id)),
      ).toBeNull();
    });

    it('allows one concurrent phone policy CAS winner without reviving stale versions', async () => {
      const original = await first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy());
      const results = await Promise.allSettled(
        [first, second].map((database, index) =>
          database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
            await tx.lockVoiceAdmission();
            await tx.savePhonePolicy(
              { ...original, version: original.version + 1, voiceEnabled: index === 1 },
              original.version,
            );
          }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failure = results.find((result) => result.status === 'rejected');
      expect(failure).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
      expect(
        (await first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy())).version,
      ).toBe(original.version + 1);
      expect(
        (await first.withTenant(DEMO_TENANTS.juniper, (tx) => tx.getPhonePolicy())).version,
      ).toBe(1);
    });

    it('holds the approved restaurant configuration stable while a confirmation commits', async () => {
      const original = await first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant());
      const held = deferred();
      const release = deferred();
      const key = randomUUID();
      const confirmation = first.withTenant(DEMO_TENANTS.harbor, async (tx) => {
        const approved = await tx.getRestaurant();
        held.resolve();
        await release.promise;
        expect((await tx.getRestaurant()).version).toBe(approved.version);
        await tx.putReceipt(key, 'approved-configuration', {
          configurationVersion: approved.version,
        });
      });
      await held.promise;
      const edit = second.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.saveRestaurant(
          { ...original, name: 'Native configuration update', version: original.version + 1 },
          original.version,
        ),
      );
      try {
        await awaitSecondLock();
      } finally {
        release.resolve();
      }
      await Promise.all([confirmation, edit]);
      expect(await first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getReceipt(key))).toEqual({
        fingerprint: 'approved-configuration',
        result: { configurationVersion: original.version },
      });
      expect(
        (await first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant())).version,
      ).toBe(original.version + 1);
    });

    it('lets concurrent workers complete an internal outbox event once and quarantines unsupported work', async () => {
      await first.withTenant(DEMO_TENANTS.juniper, async (tx) => {
        await tx.enqueue('inbox.updated', randomUUID());
        await tx.enqueue('provider.booking', randomUUID());
      });
      const counts = await Promise.all([first.processJobs(), second.processJobs()]);
      expect(counts.reduce((total, value) => total + value, 0)).toBe(1);
      expect(await first.processJobs()).toBe(0);
      await restricted(DEMO_TENANTS.juniper, async (client) => {
        expect((await client.query('SELECT state,attempts FROM jobs ORDER BY state')).rows).toEqual(
          [
            { state: 'complete', attempts: 1 },
            { state: 'quarantined', attempts: 0 },
          ],
        );
      });
    });

    it('fences a stale leased worker after another connection reclaims its expired lease', async () => {
      const eventId = randomUUID();
      const jobId = randomUUID();
      const oldToken = randomUUID();
      const replacementToken = randomUUID();
      await restricted(DEMO_TENANTS.harbor, async (client) => {
        await client.query(
          'INSERT INTO outbox(tenant_id,id,kind,resource_id) VALUES($1,$2,$3,$4)',
          [DEMO_TENANTS.harbor, eventId, 'inbox.updated', randomUUID()],
        );
        await client.query(
          "INSERT INTO jobs(tenant_id,id,outbox_id,state,attempts,lease_token,lease_expires_at) VALUES($1,$2,$3,'leased',1,$4,'2020-01-01T00:00:00Z')",
          [DEMO_TENANTS.harbor, jobId, eventId, oldToken],
        );
      });
      // A distinct login connection claims the expired job, then a delayed owner
      // attempts completion through the already-used runtime pool.
      if (!destination) throw new Error('Missing destination.');
      const reclaimer = new pg.Client({
        connectionString: asRole(destination, runtimeName, 'hostline_native_reclaimer'),
      });
      await reclaimer.connect();
      try {
        await reclaimer.query('BEGIN');
        await reclaimer.query('SET LOCAL ROLE hostline_app');
        await reclaimer.query("SELECT set_config('hostline.tenant_id',$1,true)", [
          DEMO_TENANTS.harbor,
        ]);
        expect(
          (
            await reclaimer.query(
              "UPDATE jobs SET lease_token=$3,lease_expires_at=now()+interval '30 seconds',attempts=attempts+1 WHERE tenant_id=$1 AND id=$2 AND lease_expires_at<=now() RETURNING id",
              [DEMO_TENANTS.harbor, jobId, replacementToken],
            )
          ).rows,
        ).toEqual([{ id: jobId }]);
        await reclaimer.query('COMMIT');
      } finally {
        await reclaimer.end();
      }
      await restricted(DEMO_TENANTS.harbor, async (client) => {
        expect(
          (
            await client.query(
              "UPDATE jobs SET state='complete',lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND lease_expires_at>now() RETURNING id",
              [DEMO_TENANTS.harbor, jobId, oldToken],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await client.query(
              "UPDATE jobs SET state='complete',lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND lease_expires_at>now() RETURNING id",
              [DEMO_TENANTS.harbor, jobId, replacementToken],
            )
          ).rows,
        ).toEqual([{ id: jobId }]);
      });
    });

    function operatorOptions() {
      if (!destination) throw new Error('Missing destination.');
      return { url: asRole(destination, migratorName, 'hostline_native_operator') };
    }

    async function provisionSubject() {
      const ref = {
        issuer: 'https://native-fixture.example.auth0.com/',
        subject: `auth0|native-${randomUUID()}`,
        tenantId: DEMO_TENANTS.harbor,
      };
      const previous = await inspectIdentityAccess(operatorOptions(), ref);
      const input = {
        ...ref,
        displayName: 'Synthetic native owner',
        workspaceName: 'Synthetic native workspace',
        role: 'owner' as const,
        identityEnabled: true,
        membershipEnabled: true,
        tenantEnabled: true,
        expectedIdentityVersion: previous.identity?.version ?? null,
        expectedMembershipVersion: previous.membership?.version ?? null,
        expectedTenantVersion: previous.tenant?.version ?? null,
      };
      const current = await provisionIdentityAccess(operatorOptions(), input);
      return { ref, input, current };
    }

    async function claimedLogin(issuer: string): Promise<LoginAttemptBinding> {
      const login = {
        tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        issuer,
        clientId: 'synthetic-native-client',
        redirectUri: 'https://native-fixture.example/callback',
      };
      await first.auth.createLoginAttempt({
        ...login,
        encryptedPayload: 'synthetic-encrypted-payload',
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
      });
      const claims = await Promise.all([
        first.auth.consumeLoginAttempt(login),
        second.auth.consumeLoginAttempt(login),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await second.auth.consumeLoginAttempt(login)).toBeNull();
      return login;
    }

    async function sessionFor(ref: { issuer: string; subject: string; tenantId: string }) {
      const login = await claimedLogin(ref.issuer);
      const binding: AuthSessionBinding = {
        tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        issuer: ref.issuer,
        clientId: login.clientId,
      };
      const issue = {
        ...binding,
        subject: ref.subject,
        tenantId: ref.tenantId,
        loginAttempt: login,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        mfaVerifiedAt: new Date().toISOString(),
      };
      const session = await first.auth.issueSession(issue);
      expect(session).toMatchObject({ tenantId: ref.tenantId, role: 'owner' });
      expect(await second.auth.issueSession(issue)).toBeNull();
      return { binding, login, issue, session };
    }

    it('shares one-use login and session state across pools and fences logout against delayed or racing callbacks', async () => {
      const { ref } = await provisionSubject();
      const issued = await sessionFor(ref);
      expect(await second.auth.getSession(issued.binding)).toMatchObject({
        sessionId: issued.session?.sessionId,
        tenantId: ref.tenantId,
        role: 'owner',
      });
      expect(
        await second.auth.getSession({ ...issued.binding, clientId: 'other-client' }),
      ).toBeNull();
      await second.auth.cancelLoginAttempt(issued.login);
      expect(await first.auth.getSession(issued.binding)).toBeNull();

      const cancelled = await claimedLogin(ref.issuer);
      await second.auth.cancelLoginAttempt(cancelled);
      const binding = {
        tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        issuer: ref.issuer,
        clientId: cancelled.clientId,
      };
      const issue = {
        ...binding,
        subject: ref.subject,
        tenantId: ref.tenantId,
        loginAttempt: cancelled,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      expect(await first.auth.issueSession(issue)).toBeNull();

      const racing = await claimedLogin(ref.issuer);
      await Promise.all([
        first.auth.issueSession({ ...issue, loginAttempt: racing }),
        second.auth.cancelLoginAttempt(racing),
      ]);
      expect(await first.auth.getSession(binding)).toBeNull();
      expect(await second.auth.issueSession({ ...issue, loginAttempt: racing })).toBeNull();
    });

    it('lets a mutation admitted before membership revocation commit, then rejects the old session even after reenablement', async () => {
      const { ref, input, current } = await provisionSubject();
      const { binding } = await sessionFor(ref);
      const held = deferred();
      const release = deferred();
      const key = randomUUID();
      const admitted = first.withAuthenticatedTenant(binding, async (tx, session) => {
        expect(session.tenantId).toBe(DEMO_TENANTS.harbor);
        held.resolve();
        await release.promise;
        await tx.putReceipt(key, 'admitted-before-revocation', {});
      });
      await held.promise;
      const revokeInput = {
        ...input,
        membershipEnabled: false,
        expectedIdentityVersion: current.identity?.version ?? null,
        expectedMembershipVersion: current.membership?.version ?? null,
        expectedTenantVersion: current.tenant?.version ?? null,
      };
      const revocation = provisionIdentityAccess(operatorOptions(), revokeInput);
      try {
        await awaitSecondLock('hostline_native_operator');
      } finally {
        release.resolve();
      }
      await admitted;
      const revoked = await revocation;
      expect(await first.withTenant(ref.tenantId, (tx) => tx.getReceipt(key))).not.toBeNull();
      expect(await second.auth.getSession(binding)).toBeNull();
      let entered = false;
      await expect(
        second.withAuthenticatedTenant(binding, async () => {
          entered = true;
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
      expect(entered).toBe(false);
      await provisionIdentityAccess(operatorOptions(), {
        ...revokeInput,
        membershipEnabled: true,
        expectedIdentityVersion: revoked.identity?.version ?? null,
        expectedMembershipVersion: revoked.membership?.version ?? null,
        expectedTenantVersion: revoked.tenant?.version ?? null,
      });
      expect(await first.auth.getSession(binding)).toBeNull();
    });

    it('rejects a mutation when tenant suspension wins first, without entering its business transaction', async () => {
      const { ref, input, current } = await provisionSubject();
      const { binding } = await sessionFor(ref);
      const suspended = await provisionIdentityAccess(operatorOptions(), {
        ...input,
        tenantEnabled: false,
        expectedIdentityVersion: current.identity?.version ?? null,
        expectedMembershipVersion: current.membership?.version ?? null,
        expectedTenantVersion: current.tenant?.version ?? null,
      });
      const key = randomUUID();
      let entered = false;
      await expect(
        second.withAuthenticatedTenant(binding, async (tx) => {
          entered = true;
          await tx.putReceipt(key, 'must-not-save', {});
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
      expect(entered).toBe(false);
      expect(await first.withTenant(ref.tenantId, (tx) => tx.getReceipt(key))).toBeNull();
      await provisionIdentityAccess(operatorOptions(), {
        ...input,
        expectedIdentityVersion: suspended.identity?.version ?? null,
        expectedMembershipVersion: suspended.membership?.version ?? null,
        expectedTenantVersion: suspended.tenant?.version ?? null,
      });
      expect(await first.auth.getSession(binding)).toBeNull();
    });

    it('serializes session logout with an admitted mutation and revokes shared access afterward', async () => {
      const { ref } = await provisionSubject();
      const { binding } = await sessionFor(ref);
      const held = deferred();
      const release = deferred();
      const key = randomUUID();
      const admitted = first.withAuthenticatedTenant(binding, async (tx) => {
        held.resolve();
        await release.promise;
        await tx.putReceipt(key, 'admitted-before-logout', {});
      });
      await held.promise;
      const logout = second.auth.revokeSession(binding);
      try {
        await awaitSecondLock();
      } finally {
        release.resolve();
      }
      await Promise.all([admitted, logout]);
      expect(await first.withTenant(ref.tenantId, (tx) => tx.getReceipt(key))).not.toBeNull();
      expect(await first.auth.getSession(binding)).toBeNull();
      expect(await second.auth.getSession(binding)).toBeNull();
    });

    it('rejects superuser, broker, and indirect table-owner runtime identities before serving traffic', async () => {
      expect(await first.readiness()).toEqual({
        ready: true,
        migrationVersion: expectedMigrationVersions.at(-1),
      });
      if (!destination) throw new Error('Missing destination.');
      const unsafe = await createDatabase({ url: destination });
      try {
        await expect(unsafe.readiness()).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
        await expect(
          unsafe.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant()),
        ).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
      } finally {
        await unsafe.close();
      }
      await admin.query(`GRANT hostline_auth_broker TO ${runtimeName}`);
      try {
        await expect(first.readiness()).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
      } finally {
        await admin.query(`REVOKE hostline_auth_broker FROM ${runtimeName}`);
      }
      await admin.query(`GRANT hostline_privacy TO ${runtimeName}`);
      try {
        await expect(first.readiness()).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
        await expect(
          first.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant()),
        ).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
      } finally {
        await admin.query(`REVOKE hostline_privacy FROM ${runtimeName}`);
      }
      const indirect = `hostline_native_indirect_${suffix}`;
      await admin.query(`CREATE ROLE ${indirect} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await admin.query(`GRANT ${migratorName} TO ${indirect}`);
      await admin.query(`GRANT ${indirect} TO ${runtimeName}`);
      try {
        await expect(first.readiness()).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
      } finally {
        await admin.query(`REVOKE ${indirect} FROM ${runtimeName}`);
      }
      expect(await first.readiness()).toEqual({
        ready: true,
        migrationVersion: expectedMigrationVersions.at(-1),
      });
    });

    it('fails readiness when restricted roles drift into login, administration, or business access', async () => {
      const drifts = [
        {
          change: 'ALTER ROLE hostline_worker LOGIN',
          restore: 'ALTER ROLE hostline_worker NOLOGIN',
          component: 'worker' as const,
        },
        {
          change: 'ALTER ROLE hostline_app CREATEROLE',
          restore: 'ALTER ROLE hostline_app NOCREATEROLE',
        },
        {
          change: 'GRANT SELECT ON calls TO hostline_auth_broker',
          restore: 'REVOKE SELECT ON calls FROM hostline_auth_broker',
        },
        {
          change: 'GRANT hostline_app TO hostline_auth_broker',
          restore: 'REVOKE hostline_app FROM hostline_auth_broker',
        },
      ];
      for (const drift of drifts) {
        await admin.query(drift.change);
        try {
          await expect(first.readiness(drift.component ?? 'api')).rejects.toMatchObject({
            code: 'UNSAFE_DATABASE_ROLE',
          });
        } finally {
          await admin.query(drift.restore);
        }
      }
      expect(await first.readiness()).toEqual({
        ready: true,
        migrationVersion: expectedMigrationVersions.at(-1),
      });
    });

    it('reads only scoped tenant availability without granting the app write access and keeps it stable through admission', async () => {
      const { ref, input, current } = await provisionSubject();
      await restricted(DEMO_TENANTS.harbor, async (client) => {
        expect(
          (
            await client.query('SELECT auth_read_tenant_access($1) AS access', [
              DEMO_TENANTS.juniper,
            ])
          ).rows,
        ).toEqual([{ access: null }]);
      });
      await expect(
        restricted(DEMO_TENANTS.harbor, (client) =>
          client.query('UPDATE auth_tenant_access SET enabled=false WHERE tenant_id=$1', [
            DEMO_TENANTS.harbor,
          ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const held = deferred();
      const release = deferred();
      const admission = first.withTenant(ref.tenantId, async (tx) => {
        expect(await tx.getTenantAccess()).toMatchObject({
          enabled: true,
          version: current.tenant?.version,
        });
        held.resolve();
        await release.promise;
        expect(await tx.getTenantAccess()).toMatchObject({
          enabled: true,
          version: current.tenant?.version,
        });
      });
      await held.promise;
      const suspension = provisionIdentityAccess(operatorOptions(), {
        ...input,
        tenantEnabled: false,
        expectedIdentityVersion: current.identity?.version ?? null,
        expectedMembershipVersion: current.membership?.version ?? null,
        expectedTenantVersion: current.tenant?.version ?? null,
      });
      try {
        await awaitSecondLock('hostline_native_operator');
      } finally {
        release.resolve();
      }
      await Promise.all([admission, suspension]);
      expect(await second.withTenant(ref.tenantId, (tx) => tx.getTenantAccess())).toMatchObject({
        enabled: false,
      });
    });

    it('rejects persisted idle and absolute expiry on every replica and never enters expired-session work', async () => {
      const { ref } = await provisionSubject();
      const idle = await sessionFor(ref);
      await admin.query(
        "UPDATE auth_sessions SET idle_expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [idle.binding.tokenHash],
      );
      expect(await second.auth.getSession(idle.binding)).toBeNull();
      let entered = false;
      await expect(
        first.withAuthenticatedTenant(idle.binding, async () => {
          entered = true;
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(entered).toBe(false);
      const absolute = await sessionFor(ref);
      await admin.query(
        "UPDATE auth_sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour',idle_expires_at=now()-interval '1 hour',mfa_verified_at=NULL WHERE token_hash=$1",
        [absolute.binding.tokenHash],
      );
      expect(await first.auth.getSession(absolute.binding)).toBeNull();
      expect(await second.auth.getSession(absolute.binding)).toBeNull();
      const login = await claimedLogin(ref.issuer);
      await admin.query(
        "UPDATE auth_login_attempts SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 minute' WHERE token_hash=$1",
        [login.tokenHash],
      );
      expect(
        await second.auth.issueSession({
          tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
          issuer: ref.issuer,
          clientId: login.clientId,
          subject: ref.subject,
          tenantId: ref.tenantId,
          loginAttempt: login,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ).toBeNull();
    });

    it('fences a restored database through its original non-bypass migrator and rejects runtime or superuser custody', async () => {
      const { ref } = await provisionSubject();
      const session = await sessionFor(ref);
      const held = await first.withTenant(ref.tenantId, (tx) =>
        tx.countActiveVoiceCalls(new Date()),
      );
      const manifest: RecoveryManifest = {
        installationId: randomUUID(),
        epoch: randomUUID(),
        databaseResourceId: 'db-native-synthetic-restore',
        securityVersion: 1,
        securityReauthorized: false,
        coverageComplete: true,
        coverageStartSequence: 1,
        throughSequence: 0,
        replaySources: [],
      };
      manifest.replaySources.push({
        epoch: manifest.epoch,
        databaseResourceId: manifest.databaseResourceId,
      });
      const input = {
        binding: {
          installationId: manifest.installationId,
          epoch: manifest.epoch,
          databaseResourceId: manifest.databaseResourceId,
        },
        expectedManifest: manifest,
        confirmedInstallationId: manifest.installationId,
        approvalId: randomUUID(),
      };
      const authority: RecoveryAuthority = {
        getManifest: async () => structuredClone(manifest),
        appendDeletion: async () => {
          throw new Error('No native fixture journal writes');
        },
        readDeletions: async () => {
          throw new Error('No native fixture journal reads');
        },
      };
      if (!destination) throw new Error('Missing native test destination.');
      await expect(
        quarantineRestoredDatabase(
          { url: asRole(destination, runtimeName, 'hostline_native_denied_restore') },
          input,
          authority,
        ),
      ).rejects.toMatchObject({ code: 'OPERATOR_UNAVAILABLE' });
      await expect(
        quarantineRestoredDatabase({ url: destination }, input, authority),
      ).rejects.toMatchObject({ code: 'OPERATOR_UNAVAILABLE' });
      expect(await second.auth.getSession(session.binding)).not.toBeNull();
      const counts = await inspectRestoredAuthority(operatorOptions());
      const result = await quarantineRestoredDatabase(operatorOptions(), input, authority);
      expect(result).toMatchObject({ ...counts, quarantined: true, approvalId: input.approvalId });
      expect(await first.auth.getSession(session.binding)).toBeNull();
      expect(await second.auth.getSession(session.binding)).toBeNull();
      expect(await first.withTenant(ref.tenantId, (tx) => tx.getTenantAccess())).toMatchObject({
        enabled: false,
      });
      expect(await second.withTenant(ref.tenantId, (tx) => tx.getPhonePolicy())).toMatchObject({
        voiceEnabled: false,
        requestsEnabled: false,
        transfersEnabled: false,
      });
      expect(
        await second.withTenant(ref.tenantId, (tx) => tx.countActiveVoiceCalls(new Date())),
      ).toBe(held);
      expect(manifest.securityReauthorized).toBe(false);
    });
  },
);
