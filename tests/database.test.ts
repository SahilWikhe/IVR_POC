import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TENANTS } from '@hostline/contracts';
import { createDatabase, type Database, type TenantTransaction } from '@hostline/database';
import { demoData } from '../packages/database/src/seed.js';

describe('tenant persistence and durable business transactions', () => {
  let db: Database;
  beforeAll(async () => {
    db = await createDatabase();
    await db.seedDemo();
  });
  afterAll(async () => {
    await db.close();
  });

  it('seeds two isolated workspaces and never resets settings on restart', async () => {
    const harbor = await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant());
    await db.withTenant(DEMO_TENANTS.harbor, (tx) =>
      tx.saveRestaurant(
        { ...harbor, name: 'Harbor Table updated', version: harbor.version + 1 },
        harbor.version,
      ),
    );
    await db.seedDemo();
    expect((await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant())).name).toBe(
      'Harbor Table updated',
    );
    expect((await db.withTenant(DEMO_TENANTS.juniper, (tx) => tx.getRestaurant())).name).toBe(
      'Juniper Kitchen',
    );
    expect(await db.withTenant(DEMO_TENANTS.juniper, (tx) => tx.listInbox())).toEqual([]);
  });

  it('cross-tenant resource IDs cannot reveal calls or inbox records', async () => {
    const item = (await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.listInbox()))[0];
    expect(item).toBeDefined();
    if (!item) throw new Error('Missing demo fixture');
    await db.withTenant(DEMO_TENANTS.juniper, async (tx) => {
      expect(await tx.getInbox(item.id)).toBeNull();
      expect(await tx.getCall(item.callId)).toBeNull();
    });
    await expect(
      db.withTenant(DEMO_TENANTS.juniper, (tx) => tx.insertInbox({ ...item, id: randomUUID() })),
    ).rejects.toMatchObject({ code: 'INVALID_REFERENCE', status: 409 });
  });

  it('concurrent stale edits allow one winner without overwriting it', async () => {
    const original = await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant());
    const results = await Promise.allSettled(
      ['First edit', 'Second edit'].map((name) =>
        db.withTenant(DEMO_TENANTS.harbor, (tx) =>
          tx.saveRestaurant({ ...original, name, version: original.version + 1 }, original.version),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant())).version).toBe(
      original.version + 1,
    );
  });

  it('rolled-back changes never leave a receipt, outbox event, or pending job', async () => {
    const key = randomUUID();
    const original = await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant());
    await expect(
      db.withTenant(DEMO_TENANTS.harbor, async (tx) => {
        await tx.saveRestaurant(
          { ...original, name: 'Must roll back', version: original.version + 1 },
          original.version,
        );
        await tx.putReceipt(key, 'synthetic-fingerprint', { saved: true });
        await tx.enqueue('restaurant.updated', original.id);
        throw new Error('Rollback expected');
      }),
    ).rejects.toThrow('Rollback expected');
    expect((await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant())).name).toBe(
      original.name,
    );
    expect(await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getReceipt(key))).toBeNull();
    expect(await db.processJobs()).toBe(0);
  });

  it('commits receipt and outbox atomically; retries cannot duplicate a tenant key', async () => {
    const key = randomUUID();
    await db.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.putReceipt(key, 'fingerprint-v1', {
        inboxItemId: '41000000-0000-4000-8000-000000000001',
      });
      await tx.enqueue('inbox.updated', '41000000-0000-4000-8000-000000000001');
    });
    await expect(
      db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.putReceipt(key, 'different-fingerprint', {})),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getReceipt(key))).toMatchObject({
      fingerprint: 'fingerprint-v1',
    });
    expect(await db.withTenant(DEMO_TENANTS.juniper, (tx) => tx.getReceipt(key))).toBeNull();
    await db.withTenant(DEMO_TENANTS.juniper, (tx) => tx.putReceipt(key, 'other-tenant', {}));
    expect(await db.processJobs()).toBe(1);
    expect(await db.processJobs()).toBe(0);
  });

  it('holds expired fulfillment for reconciliation and releases expired review', async () => {
    const items = await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.listInbox());
    const fulfillment = items[0];
    const review = items[1];
    if (!fulfillment || !review) throw new Error('Missing demo fixtures');
    await db.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.saveInbox(
        {
          ...fulfillment,
          state: 'IN_FULFILLMENT',
          assignedTo: 'staff-a',
          leaseExpiresAt: '2020-01-01T00:00:00Z',
          version: fulfillment.version + 1,
        },
        fulfillment.version,
      );
      await tx.saveInbox(
        {
          ...review,
          state: 'IN_REVIEW',
          assignedTo: 'staff-b',
          leaseExpiresAt: '2020-01-01T00:00:00Z',
          version: review.version + 1,
        },
        review.version,
      );
    });
    expect(await db.processJobs()).toBe(2);
    const result = await db.withTenant(DEMO_TENANTS.harbor, async (tx) => ({
      fulfillment: await tx.getInbox(fulfillment.id),
      review: await tx.getInbox(review.id),
    }));
    expect(result.fulfillment).toMatchObject({
      state: 'NEEDS_RECONCILIATION',
      assignedTo: 'staff-a',
      leaseExpiresAt: null,
    });
    expect(result.review).toMatchObject({
      state: 'ACKNOWLEDGED',
      assignedTo: null,
      leaseExpiresAt: null,
    });
    expect(await db.withTenant(DEMO_TENANTS.juniper, (tx) => tx.listInbox())).toEqual([]);
    expect(await db.processJobs()).toBe(2);
    expect(await db.processJobs()).toBe(0);
  });

  it('serializes entire embedded transactions and clears tenant context after errors', async () => {
    let signalEntered = () => {};
    let unblock = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const first = db.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      signalEntered();
      await blocked;
      expect((await tx.getRestaurant()).id).toBe(DEMO_TENANTS.harbor);
      throw new Error('Expected rollback');
    });
    await entered;
    const second = db.withTenant(DEMO_TENANTS.juniper, (tx) => tx.getRestaurant());
    unblock();
    await expect(first).rejects.toThrow('Expected rollback');
    expect((await second).id).toBe(DEMO_TENANTS.juniper);
    expect((await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant())).id).toBe(
      DEMO_TENANTS.harbor,
    );
  });

  it('rejects using a transaction after its tenant context has ended', async () => {
    let ended: TenantTransaction | undefined;
    await db.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      ended = tx;
    });
    if (!ended) throw new Error('Missing transaction');
    await expect(ended.getRestaurant()).rejects.toMatchObject({ code: 'TRANSACTION_ENDED' });
  });

  it('quarantines unsupported job kinds instead of claiming an external effect succeeded', async () => {
    await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.enqueue('provider.booking', randomUUID()));
    expect(await db.processJobs()).toBe(0);
    expect(await db.processJobs()).toBe(0);
    await db.withTenant(DEMO_TENANTS.juniper, (tx) => tx.enqueue('inbox.updated', randomUUID()));
    expect(await db.processJobs()).toBe(1);
  });

  it('keeps old unresolved requests visible through a closed-record flood and pages the complete inbox', async () => {
    const template = demoData()[0];
    const templateItem = template?.inbox[0];
    const templateCall = template?.calls[0];
    if (!templateItem || !templateCall) throw new Error('Missing demo fixture');
    const oldOpenId = randomUUID();
    const newOpenId = randomUUID();
    await db.withTenant(DEMO_TENANTS.juniper, async (tx) => {
      for (let i = 0; i < 207; i += 1) {
        const callId = randomUUID();
        const id = i === 0 ? oldOpenId : i === 206 ? newOpenId : randomUUID();
        const createdAt = new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString();
        await tx.insertCall({
          ...templateCall,
          id: callId,
          inboxItemId: id,
          createdAt,
          updatedAt: createdAt,
        });
        await tx.insertInbox({
          ...templateItem,
          id,
          callId,
          state: i === 0 || i === 206 ? 'PENDING_STAFF_REVIEW' : 'CLOSED',
          createdAt,
          updatedAt: createdAt,
        });
      }
    });
    const first = await db.withTenant(DEMO_TENANTS.juniper, (tx) => tx.listInbox());
    const second = await db.withTenant(DEMO_TENANTS.juniper, (tx) =>
      tx.listInbox({ offset: 200, limit: 200 }),
    );
    expect(first).toHaveLength(200);
    expect(second).toHaveLength(7);
    expect(first.slice(0, 2).map((item) => item.id)).toEqual([oldOpenId, newOpenId]);
    expect(new Set([...first, ...second].map((item) => item.id)).size).toBe(207);
    await expect(
      db.withTenant(DEMO_TENANTS.juniper, (tx) => tx.listInbox({ limit: 201 })),
    ).rejects.toThrow();
  });
});

it('creates missing parents and persists a demo edit across a disk-backed restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hostline-database-test-'));
  const directory = join(root, 'missing-parent', 'nested', 'database');
  const key = randomUUID();
  let database: Database | undefined;
  try {
    database = await createDatabase({ dataDir: directory });
    await database.seedDemo();
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      const original = await tx.getRestaurant();
      await tx.saveRestaurant(
        { ...original, name: 'Persisted restaurant edit', version: original.version + 1 },
        original.version,
      );
      await tx.putReceipt(key, 'restart-test', { saved: true });
    });
    await database.close();
    database = await createDatabase({ dataDir: directory });
    await database.seedDemo();
    expect((await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant())).name).toBe(
      'Persisted restaurant edit',
    );
    expect(await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getReceipt(key))).toEqual({
      fingerprint: 'restart-test',
      result: { saved: true },
    });
  } finally {
    if (database) await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

describe('PostgreSQL engine RLS, control-plane privilege, and lease fencing', () => {
  let sql: PGlite;
  beforeAll(async () => {
    sql = new PGlite();
    await sql.waitReady;
    await sql.exec(
      await readFile(
        new URL('../packages/database/migrations/001_initial.sql', import.meta.url),
        'utf8',
      ),
    );
    for (const seed of demoData()) {
      await sql.query('INSERT INTO tenant_registry(id) VALUES ($1)', [seed.restaurant.id]);
      await sql.query('INSERT INTO restaurants(tenant_id,version,document) VALUES ($1,$2,$3)', [
        seed.restaurant.id,
        seed.restaurant.version,
        JSON.stringify(seed.restaurant),
      ]);
    }
  });
  afterAll(async () => {
    await sql.close();
  });

  async function restricted<T>(tenantId: string | null, work: () => Promise<T>): Promise<T> {
    await sql.exec('BEGIN; SET LOCAL ROLE hostline_app;');
    try {
      if (tenantId) await sql.query("SELECT set_config('hostline.tenant_id',$1,true)", [tenantId]);
      const result = await work();
      await sql.exec('COMMIT');
      return result;
    } catch (error) {
      await sql.exec('ROLLBACK');
      throw error;
    }
  }

  it('uses a non-owner, non-superuser, non-bypass role and FORCE RLS', async () => {
    await restricted(DEMO_TENANTS.harbor, async () => {
      expect(
        (
          await sql.query(
            'SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user',
          )
        ).rows,
      ).toEqual([{ name: 'hostline_app', rolsuper: false, rolbypassrls: false }]);
      expect(
        (
          await sql.query(
            "SELECT relrowsecurity, relforcerowsecurity, relowner::regrole::text AS owner FROM pg_class WHERE relname='inbox'",
          )
        ).rows,
      ).toEqual([
        expect.objectContaining({
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: expect.not.stringMatching(/^hostline_app$/),
        }),
      ]);
      expect((await sql.query('SELECT tenant_id FROM restaurants')).rows).toEqual([
        { tenant_id: DEMO_TENANTS.harbor },
      ]);
      expect(
        (
          await sql.query(
            'UPDATE restaurants SET version=version WHERE tenant_id=$1 RETURNING tenant_id',
            [DEMO_TENANTS.juniper],
          )
        ).rows,
      ).toEqual([]);
    });
    await restricted(null, async () => {
      expect((await sql.query('SELECT tenant_id FROM restaurants')).rows).toEqual([]);
    });
  });

  it('WITH CHECK rejects cross-tenant insert and runtime cannot read provisioning registry', async () => {
    await expect(
      restricted(DEMO_TENANTS.harbor, () =>
        sql.query(
          'INSERT INTO receipts(tenant_id,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4)',
          [DEMO_TENANTS.juniper, 'attack-key', 'fingerprint', '{}'],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      restricted(DEMO_TENANTS.harbor, () => sql.query('SELECT * FROM tenant_registry')),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      restricted(DEMO_TENANTS.harbor, () => sql.query('SELECT * FROM discover_work(5)')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('reclaims expired work with a new fencing token; stale ownership cannot complete it', async () => {
    const eventId = randomUUID();
    const jobId = randomUUID();
    const oldToken = randomUUID();
    const replacementToken = randomUUID();
    await restricted(DEMO_TENANTS.harbor, async () => {
      await sql.query('INSERT INTO outbox(tenant_id,id,kind,resource_id) VALUES($1,$2,$3,$4)', [
        DEMO_TENANTS.harbor,
        eventId,
        'inbox.updated',
        randomUUID(),
      ]);
      await sql.query(
        "INSERT INTO jobs(tenant_id,id,outbox_id,state,attempts,lease_token,lease_expires_at) VALUES($1,$2,$3,'leased',1,$4,'2020-01-01T00:00:00Z')",
        [DEMO_TENANTS.harbor, jobId, eventId, oldToken],
      );
      await sql.query(
        "UPDATE jobs SET lease_token=$3,lease_expires_at=now()+interval '30 seconds',attempts=attempts+1 WHERE tenant_id=$1 AND id=$2 AND lease_expires_at<=now()",
        [DEMO_TENANTS.harbor, jobId, replacementToken],
      );
      expect(
        (
          await sql.query(
            "UPDATE jobs SET state='complete',lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 RETURNING id",
            [DEMO_TENANTS.harbor, jobId, oldToken],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await sql.query(
            "UPDATE jobs SET state='complete',lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND lease_expires_at>now() RETURNING id",
            [DEMO_TENANTS.harbor, jobId, replacementToken],
          )
        ).rows,
      ).toEqual([{ id: jobId }]);
    });
  });

  it('worker discovery yields only bounded opaque references and no caller content', async () => {
    await restricted(DEMO_TENANTS.juniper, async () => {
      for (let i = 0; i < 3; i += 1) {
        const eventId = randomUUID();
        await sql.query('INSERT INTO outbox(tenant_id,id,kind,resource_id) VALUES($1,$2,$3,$4)', [
          DEMO_TENANTS.juniper,
          eventId,
          'inbox.updated',
          randomUUID(),
        ]);
        await sql.query('INSERT INTO jobs(tenant_id,id,outbox_id) VALUES($1,$2,$3)', [
          DEMO_TENANTS.juniper,
          randomUUID(),
          eventId,
        ]);
      }
    });
    await sql.exec('BEGIN; SET LOCAL ROLE hostline_worker;');
    try {
      const result = await sql.query('SELECT * FROM discover_work(2)');
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({
        tenant_id: DEMO_TENANTS.juniper,
        resource_id: expect.any(String),
        work_kind: 'job',
      });
      await sql.exec('COMMIT');
    } catch (error) {
      await sql.exec('ROLLBACK');
      throw error;
    }
    await sql.exec('BEGIN; SET LOCAL ROLE hostline_worker;');
    await expect(sql.query('SELECT * FROM inbox')).rejects.toMatchObject({ code: '42501' });
    await sql.exec('ROLLBACK');
  });
});
