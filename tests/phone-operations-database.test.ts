import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_TENANTS,
  handoffSchema,
  phonePolicySchema,
  updatePhonePolicyInputSchema,
  type CallSession,
  type Handoff,
  type VoiceCallRecord,
} from '@hostline/contracts';
import { createDatabase, type Database } from '@hostline/database';
import { demoData } from '../packages/database/src/seed.js';

const stamp = '2026-09-30T16:00:00.000Z';
const providerSid = () => `CA${randomUUID().replaceAll('-', '')}`;

function fixtures(createdAt = stamp): {
  call: CallSession;
  voice: VoiceCallRecord;
  handoff: Handoff;
} {
  const id = randomUUID();
  const controlId = randomUUID();
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
      createdAt,
      updatedAt: createdAt,
    },
    voice: {
      id,
      providerCallSid: providerSid(),
      accountSid: `AC${'a'.repeat(32)}`,
      version: 1,
      state: 'TRANSFER_PENDING',
      generation: randomUUID(),
      leaseExpiresAt: '2026-09-30T16:05:00.000Z',
      streamSid: null,
      streamGrantHash: 'a'.repeat(64),
      streamGrantExpiresAt: '2026-09-30T16:00:30.000Z',
      entryTwiml: '<Response><Say>Synthetic test</Say></Response>',
      controlId,
      controlKind: 'transfer',
      controlState: 'PREPARED',
      controlTwiml: '<Response><Say>Synthetic staff transfer</Say></Response>',
      confirmationGrantHash: 'b'.repeat(64),
      confirmationExpiresAt: '2026-09-30T16:01:00.000Z',
      proposalId: null,
      transferDestination: '+12025550131',
      transferChildSid: null,
      outcome: null,
      createdAt,
      updatedAt: createdAt,
      endedAt: null,
    },
    handoff: {
      callId: id,
      controlId,
      reason: 'requested_staff',
      summary: 'Caller asked to speak with restaurant staff.',
      createdAt,
    },
  };
}

async function insert(database: Database, tenantId: string, value: ReturnType<typeof fixtures>) {
  await database.withTenant(tenantId, async (tx) => {
    await tx.lockVoiceAdmission();
    await tx.insertCall(value.call);
    await tx.insertVoiceCall(value.voice);
  });
}

const migration = (file: string) =>
  readFile(new URL(`../packages/database/migrations/${file}`, import.meta.url), 'utf8');

it('rejects tenant authority, hidden grants, and malformed phone operation inputs', () => {
  const policy = {
    version: 1,
    voiceEnabled: true,
    requestsEnabled: true,
    transfersEnabled: true,
    updatedAt: stamp,
  };
  expect(phonePolicySchema.safeParse(policy).success).toBe(true);
  expect(phonePolicySchema.safeParse({ ...policy, tenantId: DEMO_TENANTS.juniper }).success).toBe(
    false,
  );
  expect(phonePolicySchema.safeParse({ ...policy, version: 0 }).success).toBe(false);
  expect(
    updatePhonePolicyInputSchema.safeParse({
      expectedVersion: 1,
      policy: { voiceEnabled: true, requestsEnabled: false, transfersEnabled: false },
    }).success,
  ).toBe(true);
  expect(updatePhonePolicyInputSchema.safeParse({ expectedVersion: 1, policy }).success).toBe(
    false,
  );
  expect(
    handoffSchema.safeParse({ ...fixtures().handoff, confirmationToken: 'c'.repeat(64) }).success,
  ).toBe(false);
  expect(handoffSchema.safeParse({ ...fixtures().handoff, summary: 'x'.repeat(301) }).success).toBe(
    false,
  );
});

describe('tenant-scoped phone policies and private staff context', () => {
  let database: Database;
  beforeAll(async () => {
    database = await createDatabase();
    await database.seedDemo();
  });
  afterAll(async () => {
    await database.close();
  });

  it('seeds permissive policy without overwriting a restaurant restriction', async () => {
    const original = await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy());
    expect(original).toMatchObject({
      version: 1,
      voiceEnabled: true,
      requestsEnabled: true,
      transfersEnabled: true,
    });
    const changed = { ...original, version: 2, voiceEnabled: false, updatedAt: stamp };
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      await tx.savePhonePolicy(changed, 1);
    });
    await database.seedDemo();
    expect(await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy())).toEqual(
      changed,
    );
    expect(
      await database.withTenant(DEMO_TENANTS.juniper, (tx) => tx.getPhonePolicy()),
    ).toMatchObject({ version: 1, voiceEnabled: true });
  });

  it('admits one concurrent policy version winner and rejects skipped versions', async () => {
    const original = await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy());
    const results = await Promise.allSettled(
      [false, true].map((requestsEnabled) =>
        database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
          await tx.lockVoiceAdmission();
          await tx.savePhonePolicy(
            { ...original, version: original.version + 1, requestsEnabled, updatedAt: stamp },
            original.version,
          );
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const current = await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy());
    expect(current).toMatchObject({ version: original.version + 1, requestsEnabled: false });
    await expect(
      database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
        await tx.lockVoiceAdmission();
        await tx.savePhonePolicy({ ...current, version: current.version + 2 }, current.version);
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('lists a bounded, stable page of this tenant phone records only', async () => {
    const oldest = fixtures('2026-09-30T16:01:00.000Z');
    const newest = fixtures('2026-09-30T16:02:00.000Z');
    const foreign = fixtures('2026-09-30T16:03:00.000Z');
    await insert(database, DEMO_TENANTS.harbor, oldest);
    await insert(database, DEMO_TENANTS.harbor, newest);
    await insert(database, DEMO_TENANTS.juniper, foreign);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.listVoiceCalls({ limit: 1 })),
    ).toEqual([newest.voice]);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.listVoiceCalls({ limit: 1, offset: 1 }),
      ),
    ).toEqual([oldest.voice]);
    expect(await database.withTenant(DEMO_TENANTS.juniper, (tx) => tx.listVoiceCalls())).toEqual([
      foreign.voice,
    ]);
    for (const options of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: 100_001 }]) {
      await expect(
        database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.listVoiceCalls(options)),
      ).rejects.toThrow();
    }
  });

  it('stores only the current transfer context and prevents stale or foreign replacements', async () => {
    const value = fixtures();
    await insert(database, DEMO_TENANTS.harbor, value);
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      expect(await tx.getHandoff(value.call.id)).toBeNull();
      await tx.saveHandoff(value.handoff);
    });
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getHandoff(value.call.id)),
    ).toEqual(value.handoff);
    expect(
      await database.withTenant(DEMO_TENANTS.juniper, (tx) => tx.getHandoff(value.call.id)),
    ).toBeNull();
    await expect(
      database.withTenant(DEMO_TENANTS.juniper, async (tx) => {
        await tx.lockVoiceAdmission();
        await tx.saveHandoff(value.handoff);
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const replacement = {
      ...value.handoff,
      controlId: randomUUID(),
      reason: 'allergy_question' as const,
      summary: 'Caller has a question about restaurant allergy procedures.',
    };
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      await tx.saveVoiceCall({ ...value.voice, version: 2, controlId: replacement.controlId }, 1);
      await tx.saveHandoff(replacement);
    });
    await expect(
      database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
        await tx.lockVoiceAdmission();
        await tx.saveHandoff(value.handoff);
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getHandoff(value.call.id)),
    ).toEqual(replacement);
  });

  it('rolls back policy and handoff changes together without leaking context into call summaries', async () => {
    const value = fixtures();
    await insert(database, DEMO_TENANTS.harbor, value);
    const original = await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy());
    await expect(
      database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
        await tx.lockVoiceAdmission();
        await tx.savePhonePolicy(
          { ...original, version: original.version + 1, transfersEnabled: false },
          original.version,
        );
        await tx.saveHandoff(value.handoff);
        throw new Error('Synthetic transaction rollback');
      }),
    ).rejects.toThrow('Synthetic transaction rollback');
    expect(await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy())).toEqual(
      original,
    );
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getHandoff(value.call.id)),
    ).toBeNull();
    const summary = (await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.listCalls())).find(
      (call) => call.id === value.call.id,
    );
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('handoff');
    expect(summary).not.toHaveProperty('controlId');
    expect(summary).not.toHaveProperty('streamGrantHash');
  });
});

it('upgrades existing v2 policy once and preserves restrictions and handoff context across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hostline-phone-operations-'));
  let sql: PGlite | undefined;
  let database: Database | undefined;
  const value = fixtures();
  try {
    sql = new PGlite(directory);
    await sql.waitReady;
    for (const file of ['001_initial.sql', '002_voice_calls.sql'])
      await sql.exec(await migration(file));
    for (const seed of demoData()) {
      await sql.query('INSERT INTO tenant_registry(id) VALUES($1)', [seed.restaurant.id]);
      await sql.query('INSERT INTO restaurants(tenant_id,version,document) VALUES($1,$2,$3)', [
        seed.restaurant.id,
        seed.restaurant.version,
        JSON.stringify(seed.restaurant),
      ]);
    }
    const priorMigrations = (
      await sql.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')
    ).rows;
    await sql.close();
    sql = undefined;
    database = await createDatabase({ dataDir: directory });
    await database.seedDemo();
    await insert(database, DEMO_TENANTS.harbor, value);
    const policy = await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy());
    expect(policy).toMatchObject({
      version: 1,
      voiceEnabled: true,
      requestsEnabled: true,
      transfersEnabled: true,
    });
    const changed = { ...policy, version: 2, requestsEnabled: false, updatedAt: stamp };
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      await tx.savePhonePolicy(changed, 1);
      await tx.saveHandoff(value.handoff);
    });
    await database.close();
    database = undefined;
    sql = new PGlite(directory);
    await sql.waitReady;
    const migrationDates = (
      await sql.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')
    ).rows;
    expect(migrationDates).toHaveLength(3);
    expect(migrationDates.slice(0, 2)).toEqual(priorMigrations);
    await sql.close();
    sql = undefined;
    database = await createDatabase({ dataDir: directory });
    await database.seedDemo();
    expect(await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy())).toEqual(
      changed,
    );
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getHandoff(value.call.id)),
    ).toEqual(value.handoff);
    await database.close();
    database = undefined;
    sql = new PGlite(directory);
    await sql.waitReady;
    expect(
      (await sql.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')).rows,
    ).toEqual(migrationDates);
  } finally {
    if (database) await database.close();
    if (sql) await sql.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('initializes a post-migration tenant policy once under the restaurant admission lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hostline-new-tenant-policy-'));
  let sql: PGlite | undefined;
  let database: Database | undefined;
  const tenantId = randomUUID();
  try {
    sql = new PGlite(directory);
    await sql.waitReady;
    for (const file of ['001_initial.sql', '002_voice_calls.sql', '003_phone_operations.sql'])
      await sql.exec(await migration(file));
    const seed = demoData()[0];
    if (!seed) throw new Error('Missing synthetic restaurant');
    const restaurant = { ...seed.restaurant, id: tenantId };
    await sql.query('INSERT INTO tenant_registry(id) VALUES($1)', [tenantId]);
    await sql.query('INSERT INTO restaurants(tenant_id,version,document) VALUES($1,$2,$3)', [
      tenantId,
      restaurant.version,
      JSON.stringify(restaurant),
    ]);
    expect((await sql.query('SELECT tenant_id FROM phone_policies')).rows).toEqual([]);
    await sql.close();
    sql = undefined;
    database = await createDatabase({ dataDir: directory });
    const db = database;
    const policies = await Promise.all([
      db.withTenant(tenantId, (tx) => tx.getPhonePolicy()),
      db.withTenant(tenantId, (tx) => tx.getPhonePolicy()),
    ]);
    expect(policies[0]).toEqual(policies[1]);
    expect(policies[0]).toMatchObject({
      version: 1,
      voiceEnabled: true,
      requestsEnabled: true,
      transfersEnabled: true,
    });
    await database.close();
    database = undefined;
    sql = new PGlite(directory);
    await sql.waitReady;
    expect((await sql.query('SELECT tenant_id,version FROM phone_policies')).rows).toEqual([
      { tenant_id: tenantId, version: 1 },
    ]);
  } finally {
    if (database) await database.close();
    if (sql) await sql.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('operations PostgreSQL constraints and forced tenant isolation', () => {
  let sql: PGlite;
  const harbor = fixtures();
  const juniper = fixtures();
  beforeAll(async () => {
    sql = new PGlite();
    await sql.waitReady;
    for (const file of ['001_initial.sql', '002_voice_calls.sql', '003_phone_operations.sql']) {
      await sql.exec(await migration(file));
    }
    for (const [tenantId, value] of [
      [DEMO_TENANTS.harbor, harbor],
      [DEMO_TENANTS.juniper, juniper],
    ] as const) {
      const seed = demoData().find((item) => item.restaurant.id === tenantId);
      if (!seed) throw new Error('Missing synthetic restaurant');
      await sql.query('INSERT INTO tenant_registry(id) VALUES($1)', [tenantId]);
      await sql.query('INSERT INTO restaurants(tenant_id,version,document) VALUES($1,$2,$3)', [
        tenantId,
        seed.restaurant.version,
        JSON.stringify(seed.restaurant),
      ]);
      const policy = {
        version: 1,
        voiceEnabled: true,
        requestsEnabled: true,
        transfersEnabled: true,
        updatedAt: stamp,
      };
      await sql.query(
        'INSERT INTO phone_policies(tenant_id,version,voice_enabled,requests_enabled,transfers_enabled,updated_at,document) VALUES($1,1,true,true,true,$2,$3)',
        [tenantId, stamp, JSON.stringify(policy)],
      );
      await sql.query(
        'INSERT INTO calls(tenant_id,id,version,created_at,document) VALUES($1,$2,1,$3,$4)',
        [tenantId, value.call.id, stamp, JSON.stringify(value.call)],
      );
      await sql.query(
        'INSERT INTO voice_calls(tenant_id,id,provider_call_sid,version,state,generation,lease_expires_at,document) VALUES($1,$2,$3,1,$4,$5,$6,$7)',
        [
          tenantId,
          value.voice.id,
          value.voice.providerCallSid,
          value.voice.state,
          value.voice.generation,
          value.voice.leaseExpiresAt,
          JSON.stringify(value.voice),
        ],
      );
      await insertRawHandoff(tenantId, value.handoff);
    }
  });
  afterAll(async () => {
    await sql.close();
  });

  function insertRawHandoff(tenantId: string, handoff: Handoff) {
    return sql.query(
      'INSERT INTO phone_handoffs(tenant_id,call_id,control_id,reason,summary,created_at,document) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        tenantId,
        handoff.callId,
        handoff.controlId,
        handoff.reason,
        handoff.summary,
        handoff.createdAt,
        JSON.stringify(handoff),
      ],
    );
  }
  async function restricted<T>(
    tenantId: string | null,
    work: () => Promise<T>,
    role: 'hostline_app' | 'hostline_worker' = 'hostline_app',
  ): Promise<T> {
    await sql.exec(
      role === 'hostline_app'
        ? 'BEGIN; SET LOCAL ROLE hostline_app;'
        : 'BEGIN; SET LOCAL ROLE hostline_worker;',
    );
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

  it('enforces RLS on both tables and denies deletion and worker access', async () => {
    expect(
      (
        await sql.query(
          "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN('phone_policies','phone_handoffs') ORDER BY relname",
        )
      ).rows,
    ).toEqual([
      { relname: 'phone_handoffs', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'phone_policies', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    await restricted(DEMO_TENANTS.harbor, async () => {
      expect((await sql.query('SELECT tenant_id FROM phone_policies')).rows).toEqual([
        { tenant_id: DEMO_TENANTS.harbor },
      ]);
      expect((await sql.query('SELECT call_id FROM phone_handoffs')).rows).toEqual([
        { call_id: harbor.call.id },
      ]);
      expect(
        (
          await sql.query(
            'UPDATE phone_policies SET version=version WHERE tenant_id=$1 RETURNING tenant_id',
            [DEMO_TENANTS.juniper],
          )
        ).rows,
      ).toEqual([]);
    });
    for (const table of ['phone_policies', 'phone_handoffs']) {
      expect(
        (await restricted(null, () => sql.query(`SELECT tenant_id FROM ${table}`))).rows,
      ).toEqual([]);
      await expect(
        restricted(DEMO_TENANTS.harbor, () => sql.query(`DELETE FROM ${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        restricted(
          DEMO_TENANTS.harbor,
          () => sql.query(`SELECT * FROM ${table}`),
          'hostline_worker',
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('rejects cross-tenant handoffs even when both call and control IDs are known', async () => {
    await expect(
      restricted(DEMO_TENANTS.harbor, () =>
        insertRawHandoff(DEMO_TENANTS.juniper, { ...fixtures().handoff, callId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await sql.query('DELETE FROM phone_handoffs WHERE tenant_id=$1', [DEMO_TENANTS.juniper]);
    await expect(
      restricted(DEMO_TENANTS.harbor, () => insertRawHandoff(DEMO_TENANTS.harbor, juniper.handoff)),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects raw document inconsistency and hidden token fields', async () => {
    for (const patch of [
      { version: 2 },
      { voiceEnabled: false },
      { confirmationToken: 'a'.repeat(64) },
    ]) {
      await expect(
        restricted(DEMO_TENANTS.harbor, () =>
          sql.query('UPDATE phone_policies SET document=document || $2::jsonb WHERE tenant_id=$1', [
            DEMO_TENANTS.harbor,
            JSON.stringify(patch),
          ]),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    for (const patch of [
      { controlId: randomUUID() },
      { summary: 'x'.repeat(301) },
      { streamGrant: 'a'.repeat(64) },
    ]) {
      await expect(
        restricted(DEMO_TENANTS.harbor, () =>
          sql.query('UPDATE phone_handoffs SET document=document || $2::jsonb WHERE tenant_id=$1', [
            DEMO_TENANTS.harbor,
            JSON.stringify(patch),
          ]),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});

it('backfills every existing tenant through a migration identity without RLS bypass', async () => {
  const sql = new PGlite();
  try {
    await sql.waitReady;
    for (const file of ['001_initial.sql', '002_voice_calls.sql'])
      await sql.exec(await migration(file));
    for (const seed of demoData()) {
      await sql.query('INSERT INTO tenant_registry(id) VALUES($1)', [seed.restaurant.id]);
      await sql.query('INSERT INTO restaurants(tenant_id,version,document) VALUES($1,$2,$3)', [
        seed.restaurant.id,
        seed.restaurant.version,
        JSON.stringify(seed.restaurant),
      ]);
    }
    await sql.exec(
      'CREATE ROLE phone_ops_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE,CREATE ON SCHEMA public TO phone_ops_migrator; GRANT SELECT ON tenant_registry,restaurants TO phone_ops_migrator; GRANT REFERENCES ON restaurants,voice_calls TO phone_ops_migrator; GRANT INSERT ON schema_migrations TO phone_ops_migrator; BEGIN; SET LOCAL ROLE phone_ops_migrator;',
    );
    await sql.query("SELECT set_config('hostline.tenant_id',$1,true)", [DEMO_TENANTS.harbor]);
    await sql.exec(await migration('003_phone_operations.sql'));
    expect(
      (await sql.query("SELECT current_setting('hostline.tenant_id') AS tenant_id")).rows,
    ).toEqual([{ tenant_id: DEMO_TENANTS.harbor }]);
    expect((await sql.query('SELECT tenant_id FROM phone_policies')).rows).toEqual([
      { tenant_id: DEMO_TENANTS.harbor },
    ]);
    await sql.exec('COMMIT');
    expect(
      (await sql.query('SELECT tenant_id FROM phone_policies ORDER BY tenant_id')).rows,
    ).toEqual(
      demoData()
        .map((seed) => ({ tenant_id: seed.restaurant.id }))
        .sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)),
    );
  } finally {
    await sql.close();
  }
});
