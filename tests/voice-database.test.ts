import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TENANTS, type CallSession, type VoiceCallRecord } from '@hostline/contracts';
import { createDatabase, type Database } from '@hostline/database';
import { demoData } from '../packages/database/src/seed.js';

const accountSid = `AC${'a'.repeat(32)}`;
const providerSid = () => `CA${randomUUID().replaceAll('-', '')}`;
const now = new Date('2026-09-30T16:00:00Z');

function fixtures(changes: Partial<VoiceCallRecord> = {}): {
  call: CallSession;
  voice: VoiceCallRecord;
} {
  const id = randomUUID();
  const stamp = now.toISOString();
  const voice: VoiceCallRecord = {
    id,
    providerCallSid: providerSid(),
    accountSid,
    version: 1,
    state: 'WAITING_FOR_STREAM',
    generation: randomUUID(),
    leaseExpiresAt: '2026-09-30T16:05:00Z',
    streamSid: null,
    streamGrantHash: 'a'.repeat(64),
    streamGrantExpiresAt: '2026-09-30T16:00:30Z',
    entryTwiml: '<Response><Say>Synthetic test response</Say></Response>',
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
    ...changes,
  };
  return {
    call: {
      id: voice.id,
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
    voice,
  };
}

async function insert(database: Database, voice: VoiceCallRecord, call: CallSession) {
  await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
    await tx.insertCall(call);
    await tx.insertVoiceCall(voice);
  });
}

describe('durable tenant-scoped phone control', () => {
  let database: Database;
  beforeAll(async () => {
    database = await createDatabase();
    await database.seedDemo();
  });
  afterAll(async () => {
    await database.close();
  });

  it('isolates phone control and keeps grant hashes out of browser call summaries', async () => {
    const { voice, call } = fixtures({ state: 'ENDED', endedAt: now.toISOString() });
    await insert(database, voice, call);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.getVoiceCall(voice.providerCallSid),
      ),
    ).toEqual(voice);
    await database.withTenant(DEMO_TENANTS.juniper, async (tx) => {
      expect(await tx.getVoiceCall(voice.providerCallSid)).toBeNull();
      expect(await tx.getVoiceCallById(voice.id)).toBeNull();
      await expect(tx.insertVoiceCall(voice)).rejects.toMatchObject({
        code: 'INVALID_REFERENCE',
      });
    });
    const summaries = await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.listCalls());
    const summary = summaries.find((item) => item.id === voice.id);
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('providerCallSid');
    expect(summary).not.toHaveProperty('streamGrantHash');
    expect(summary).not.toHaveProperty('entryTwiml');
  });

  it('deduplicates provider calls and forbids rebinding the account or provider ID', async () => {
    const { voice, call } = fixtures({ state: 'ENDED', endedAt: now.toISOString() });
    await insert(database, voice, call);
    const duplicate = fixtures({ providerCallSid: voice.providerCallSid });
    await expect(insert(database, duplicate.voice, duplicate.call)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getCall(duplicate.call.id)),
    ).toBeNull();
    await expect(
      database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.saveVoiceCall({ ...voice, version: 2, accountSid: `AC${'b'.repeat(32)}` }, 1),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.saveVoiceCall({ ...voice, version: 2, providerCallSid: providerSid() }, 1),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getVoiceCallById(voice.id)),
    ).toEqual(voice);
  });

  it('permits one concurrent version winner without losing a phone-control transition', async () => {
    const { voice, call } = fixtures({ state: 'ENDED', endedAt: now.toISOString() });
    await insert(database, voice, call);
    const results = await Promise.allSettled(
      ['terminal-one', 'terminal-two'].map((outcome) =>
        database.withTenant(DEMO_TENANTS.harbor, (tx) =>
          tx.saveVoiceCall({ ...voice, version: 2, outcome }, 1),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getVoiceCallById(voice.id)),
    ).toMatchObject({ version: 2, outcome: 'terminal-one' });
  });

  it('holds admission after lease expiry until authoritative terminal state is persisted', async () => {
    const records = [
      fixtures(),
      fixtures({ leaseExpiresAt: '2026-09-30T15:59:59Z' }),
      fixtures({ state: 'ENDED', endedAt: now.toISOString() }),
      fixtures({ state: 'NEEDS_RECONCILIATION', leaseExpiresAt: '2026-09-30T15:59:59Z' }),
    ];
    for (const { voice, call } of records) await insert(database, voice, call);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.countActiveVoiceCalls(now)),
    ).toBe(3);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.countActiveVoiceCalls(new Date('2026-10-01T16:00:00Z')),
      ),
    ).toBe(3);
    expect(
      await database.withTenant(DEMO_TENANTS.juniper, (tx) => tx.countActiveVoiceCalls(now)),
    ).toBe(0);
    for (const { voice } of records) {
      await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.saveVoiceCall({ ...voice, state: 'ENDED', endedAt: now.toISOString(), version: 2 }, 1),
      );
    }
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.countActiveVoiceCalls(now)),
    ).toBe(0);
  });

  it('serializes count-and-insert admission so concurrent calls cannot overbook a slot', async () => {
    const admitted = await Promise.all(
      [fixtures(), fixtures()].map(({ voice, call }) =>
        database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
          await tx.lockVoiceAdmission();
          if ((await tx.countActiveVoiceCalls(now)) >= 1) return null;
          await tx.insertCall(call);
          await tx.insertVoiceCall(voice);
          return voice;
        }),
      ),
    );
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.countActiveVoiceCalls(now)),
    ).toBe(1);
    const winner = admitted.find((voice) => voice !== null);
    if (!winner) throw new Error('Expected one admitted fixture');
    await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
      tx.saveVoiceCall({ ...winner, state: 'ENDED', endedAt: now.toISOString(), version: 2 }, 1),
    );
  });
});

it('upgrades an existing v1 database once and preserves terminal replay tombstones on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hostline-voice-upgrade-'));
  let sql: PGlite | undefined;
  let database: Database | undefined;
  const { voice, call } = fixtures({
    state: 'ENDED',
    endedAt: now.toISOString(),
    outcome: 'synthetic-call-completed',
  });
  try {
    sql = new PGlite(directory);
    await sql.waitReady;
    await sql.exec(
      await readFile(
        new URL('../packages/database/migrations/001_initial.sql', import.meta.url),
        'utf8',
      ),
    );
    const priorVersion = (await sql.query('SELECT applied_at FROM schema_migrations')).rows;
    await sql.close();
    sql = undefined;
    database = await createDatabase({ dataDir: directory });
    await database.seedDemo();
    await insert(database, voice, call);
    await database.close();
    database = undefined;
    sql = new PGlite(directory);
    await sql.waitReady;
    expect(
      (await sql.query('SELECT version FROM schema_migrations ORDER BY version')).rows.slice(0, 3),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(
      (await sql.query('SELECT applied_at FROM schema_migrations WHERE version=1')).rows,
    ).toEqual(priorVersion);
    const migrationDates = (
      await sql.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')
    ).rows;
    await sql.close();
    sql = undefined;
    database = await createDatabase({ dataDir: directory });
    await database.seedDemo();
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.getVoiceCall(voice.providerCallSid),
      ),
    ).toEqual(voice);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.countActiveVoiceCalls(now)),
    ).toBe(0);
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

describe('phone-control PostgreSQL isolation and constraints through the restricted role', () => {
  let sql: PGlite;
  const harbor = fixtures();
  const juniper = fixtures();
  beforeAll(async () => {
    sql = new PGlite();
    await sql.waitReady;
    for (const file of ['001_initial.sql', '002_voice_calls.sql']) {
      await sql.exec(
        await readFile(new URL(`../packages/database/migrations/${file}`, import.meta.url), 'utf8'),
      );
    }
    for (const seed of demoData()) {
      await sql.query('INSERT INTO tenant_registry(id) VALUES ($1)', [seed.restaurant.id]);
      await sql.query('INSERT INTO restaurants(tenant_id,version,document) VALUES ($1,$2,$3)', [
        seed.restaurant.id,
        seed.restaurant.version,
        JSON.stringify(seed.restaurant),
      ]);
    }
    for (const [tenantId, value] of [
      [DEMO_TENANTS.harbor, harbor],
      [DEMO_TENANTS.juniper, juniper],
    ] as const) {
      await sql.query(
        'INSERT INTO calls(tenant_id,id,version,created_at,document) VALUES($1,$2,1,$3,$4)',
        [tenantId, value.call.id, value.call.createdAt, JSON.stringify(value.call)],
      );
      await insertRaw(tenantId, value.voice);
    }
  });
  afterAll(async () => {
    await sql.close();
  });

  function insertRaw(tenantId: string, voice: VoiceCallRecord) {
    return sql.query(
      'INSERT INTO voice_calls(tenant_id,id,provider_call_sid,version,state,generation,lease_expires_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        tenantId,
        voice.id,
        voice.providerCallSid,
        voice.version,
        voice.state,
        voice.generation,
        voice.leaseExpiresAt,
        JSON.stringify(voice),
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

  it('forces RLS and grants neither ownership, bypass, deletion, nor worker access', async () => {
    await restricted(DEMO_TENANTS.harbor, async () => {
      expect(
        (
          await sql.query(
            "SELECT relrowsecurity,relforcerowsecurity,relowner::regrole::text AS owner FROM pg_class WHERE relname='voice_calls'",
          )
        ).rows,
      ).toEqual([
        expect.objectContaining({
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: expect.not.stringMatching(/^hostline_app$/),
        }),
      ]);
      expect(
        (await sql.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
          .rows,
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      expect((await sql.query('SELECT id FROM voice_calls')).rows).toEqual([
        { id: harbor.voice.id },
      ]);
      expect(
        (
          await sql.query(
            'UPDATE voice_calls SET version=version WHERE tenant_id=$1 RETURNING id',
            [DEMO_TENANTS.juniper],
          )
        ).rows,
      ).toEqual([]);
    });
    expect(await restricted(null, () => sql.query('SELECT id FROM voice_calls'))).toMatchObject({
      rows: [],
    });
    await expect(
      restricted(DEMO_TENANTS.harbor, () => sql.query('DELETE FROM voice_calls')),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      restricted(
        DEMO_TENANTS.harbor,
        () => sql.query('SELECT * FROM voice_calls'),
        'hostline_worker',
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects cross-tenant inserts and foreign call references even with known resource IDs', async () => {
    await expect(
      restricted(DEMO_TENANTS.harbor, () => insertRaw(DEMO_TENANTS.juniper, fixtures().voice)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      restricted(DEMO_TENANTS.harbor, () =>
        insertRaw(DEMO_TENANTS.harbor, fixtures({ id: juniper.call.id }).voice),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('cannot bypass version/state/generation consistency with raw document updates', async () => {
    for (const replacement of [
      { ...harbor.voice, version: 2 },
      { ...harbor.voice, state: 'ENDED' },
      { ...harbor.voice, generation: randomUUID() },
      { ...harbor.voice, leaseExpiresAt: '2026-09-30T16:10:00Z' },
      { ...harbor.voice, providerCallSid: providerSid() },
    ]) {
      await expect(
        restricted(DEMO_TENANTS.harbor, () =>
          sql.query('UPDATE voice_calls SET document=$3 WHERE tenant_id=$1 AND id=$2', [
            DEMO_TENANTS.harbor,
            harbor.voice.id,
            JSON.stringify(replacement),
          ]),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});
