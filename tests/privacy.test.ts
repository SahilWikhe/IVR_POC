import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSession, InboxItem, VoiceCallRecord } from '@hostline/contracts';
import {
  admitPrivacyDecision,
  applyPrivacyDecision,
  deletionDecisionDigest,
  inspectRecoveryReadiness,
  planPrivacyBatch,
  readRecoveryCheckpoint,
  readRecoveryDeletionPage,
  replayRecoveryJournal,
  runPrivacyBatch,
  saveRetentionPolicy,
  type DeletionDecision,
  type PrivacyOperatorPersistence,
  type PrivacySqlClient,
  type RecoveryAuthority,
  type RecoveryBinding,
  type RecoveryManifest,
  type RetentionPolicy,
} from '../packages/database/src/privacy.js';
import { createPrivacyPersistence } from '../packages/database/src/privacy-persistence.js';

const stamp = '2026-09-01T12:00:00.000Z',
  now = new Date('2026-10-31T12:00:00.000Z');
const privateText = 'Synthetic private guest content';
const tenant = randomUUID(),
  otherTenant = randomUUID();
const binding: RecoveryBinding = {
  installationId: randomUUID(),
  epoch: randomUUID(),
  databaseResourceId: 'synthetic-db-resource',
};
const policy: RetentionPolicy = {
  enabled: true,
  version: 1,
  policyId: randomUUID(),
  approvalId: randomUUID(),
  closedAfterDays: 30,
};
let database: PGlite;
let persistence: PrivacyOperatorPersistence;
let authority: FakeAuthority;
const query: PrivacySqlClient['query'] = async (text, values) => {
  const result = await database.query<Record<string, unknown>>(text, values);
  return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
};

class FakeAuthority implements RecoveryAuthority {
  manifest: RecoveryManifest = {
    ...binding,
    securityVersion: 1,
    securityReauthorized: true,
    coverageComplete: true,
    coverageStartSequence: 1,
    throughSequence: 0,
    replaySources: [{ epoch: binding.epoch, databaseResourceId: binding.databaseResourceId }],
  };
  entries: Array<{ sequence: number; decision: DeletionDecision; decisionDigest: string }> = [];
  failBeforeAppend = false;
  loseAcknowledgment = false;
  afterPage: (() => Promise<void>) | undefined;
  async getManifest() {
    return { ...this.manifest, throughSequence: this.entries.length };
  }
  async appendDeletion(decision: DeletionDecision) {
    if (this.failBeforeAppend) throw new Error('Synthetic unavailable authority');
    if (
      decision.installationId !== this.manifest.installationId ||
      decision.epoch !== this.manifest.epoch ||
      decision.databaseResourceId !== this.manifest.databaseResourceId
    )
      throw new Error('Binding rejected');
    const previous = this.entries.find((entry) => entry.decision.eventId === decision.eventId);
    const entry = previous ?? {
      sequence: this.entries.length + 1,
      decision,
      decisionDigest: deletionDecisionDigest(decision),
    };
    if (!previous) this.entries.push(entry);
    if (this.loseAcknowledgment) {
      this.loseAcknowledgment = false;
      throw new Error('Acknowledgment lost after commit');
    }
    return {
      eventId: entry.decision.eventId,
      sequence: entry.sequence,
      decisionDigest: entry.decisionDigest,
    };
  }
  async readDeletions(input: {
    installationId: string;
    epoch: string;
    afterSequence: number;
    limit: number;
  }) {
    const page = {
      installationId: input.installationId,
      epoch: input.epoch,
      afterSequence: input.afterSequence,
      throughSequence: this.entries.length,
      entries: this.entries.slice(input.afterSequence, input.afterSequence + input.limit),
      hasMore: input.afterSequence + input.limit < this.entries.length,
    };
    const after = this.afterPage;
    this.afterPage = undefined;
    await after?.();
    return page;
  }
}

beforeAll(async () => {
  database = new PGlite();
  await database.waitReady;
  for (const name of [
    '001_initial.sql',
    '002_voice_calls.sql',
    '003_phone_operations.sql',
    '004_identity.sql',
    '005_privacy.sql',
  ])
    await database.exec(
      await readFile(new URL(`../packages/database/migrations/${name}`, import.meta.url), 'utf8'),
    );
  let tail = Promise.resolve();
  const transaction = async <T>(
    tenantId: string | null,
    work: (client: PrivacySqlClient) => Promise<T>,
  ): Promise<T> => {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await query('BEGIN');
      await query('SET LOCAL ROLE hostline_privacy');
      await query("SELECT set_config('hostline.tenant_id',$1,true)", [tenantId ?? '']);
      try {
        const result = await work({ query });
        await query('COMMIT');
        return result;
      } catch (error) {
        await query('ROLLBACK');
        throw error;
      }
    } finally {
      release();
    }
  };
  persistence = {
    withTenant: (tenantId, work) => transaction(tenantId, work),
    withControl: (work) => transaction(null, work),
    readCheckpoint: (id) => transaction(null, (client) => readRecoveryCheckpoint(client, id)),
    close: async () => undefined,
  };
});
beforeEach(async () => {
  await database.exec('TRUNCATE tenant_registry,recovery_checkpoints CASCADE');
  for (const id of [tenant, otherTenant]) {
    await query('INSERT INTO tenant_registry(id) VALUES($1)', [id]);
    await query('INSERT INTO restaurants(tenant_id,version,document) VALUES($1,1,$2::jsonb)', [
      id,
      JSON.stringify({ id, version: 1 }),
    ]);
  }
  authority = new FakeAuthority();
  await query(
    'INSERT INTO recovery_checkpoints(installation_id,epoch,database_resource_id,security_version,applied_through_sequence,updated_at) VALUES($1,$2,$3,1,0,$4)',
    [binding.installationId, binding.epoch, binding.databaseResourceId, now.toISOString()],
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await database.close();
});

async function fixture(
  tenantId = tenant,
  patch: {
    call?: Partial<CallSession>;
    inbox?: Partial<InboxItem>;
    voice?: Partial<VoiceCallRecord>;
  } = {},
) {
  const callId = randomUUID(),
    inboxId = randomUUID(),
    controlId = randomUUID();
  const call: CallSession = {
    id: callId,
    version: 1,
    mode: 'voice',
    status: 'message_saved',
    phase: 'complete',
    draft: { name: privateText, callbackNumber: '+12125550144' },
    messages: [{ id: randomUUID(), role: 'caller', text: privateText, createdAt: stamp }],
    proposal: null,
    outcome: privateText,
    inboxItemId: inboxId,
    createdAt: stamp,
    updatedAt: stamp,
    ...patch.call,
  };
  const inbox: InboxItem = {
    id: inboxId,
    callId,
    kind: 'message',
    state: 'CLOSED',
    version: 1,
    name: privateText,
    callbackNumber: '+12125550144',
    reservation: null,
    message: privateText,
    assignedTo: null,
    leaseExpiresAt: null,
    bookingEvidence: privateText,
    evidenceSource: 'STAFF_REPORTED',
    guestNotice: 'COMMUNICATION_RECORDED',
    guestNoticeNote: privateText,
    createdAt: stamp,
    updatedAt: stamp,
    ...patch.inbox,
  };
  const voice: VoiceCallRecord = {
    id: callId,
    providerCallSid: `CA${randomUUID().replaceAll('-', '')}`,
    accountSid: `AC${'a'.repeat(32)}`,
    version: 1,
    policyVersion: 1,
    state: 'ENDED',
    generation: randomUUID(),
    leaseExpiresAt: stamp,
    streamSid: null,
    streamGrantHash: 'a'.repeat(64),
    streamGrantExpiresAt: stamp,
    entryTwiml: `<Response><Say>${privateText}</Say></Response>`,
    controlId,
    controlKind: 'readback',
    controlState: 'COMPLETED',
    controlTwiml: `<Response><Say>${privateText}</Say></Response>`,
    confirmationGrantHash: 'b'.repeat(64),
    confirmationExpiresAt: stamp,
    proposalId: null,
    transferDestination: '+12125550144',
    transferChildSid: null,
    outcome: privateText,
    createdAt: stamp,
    updatedAt: stamp,
    endedAt: stamp,
    ...patch.voice,
  };
  await query(
    'INSERT INTO calls(tenant_id,id,version,created_at,document) VALUES($1,$2,$3,$4,$5::jsonb)',
    [tenantId, callId, call.version, stamp, JSON.stringify(call)],
  );
  await query(
    'INSERT INTO inbox(tenant_id,id,call_id,version,state,lease_expires_at,created_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
    [
      tenantId,
      inboxId,
      callId,
      inbox.version,
      inbox.state,
      inbox.leaseExpiresAt,
      stamp,
      JSON.stringify(inbox),
    ],
  );
  await query(
    'INSERT INTO voice_calls(tenant_id,id,provider_call_sid,version,state,generation,lease_expires_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
    [
      tenantId,
      callId,
      voice.providerCallSid,
      voice.version,
      voice.state,
      voice.generation,
      voice.leaseExpiresAt,
      JSON.stringify(voice),
    ],
  );
  await query(
    'INSERT INTO phone_handoffs(tenant_id,call_id,control_id,reason,summary,created_at,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
    [
      tenantId,
      callId,
      controlId,
      'allergy_question',
      privateText,
      stamp,
      JSON.stringify({
        callId,
        controlId,
        reason: 'allergy_question',
        summary: privateText,
        createdAt: stamp,
      }),
    ],
  );
  await query(
    'INSERT INTO receipts(tenant_id,idempotency_key,fingerprint,result,resource_call_id) VALUES($1,$2,$3,$4::jsonb,$5)',
    [
      tenantId,
      `voice:tool:${callId}:test-tool`,
      'unchanged-fingerprint',
      JSON.stringify({ controlId, twiml: voice.controlTwiml }),
      callId,
    ],
  );
  await query(
    'INSERT INTO receipts(tenant_id,idempotency_key,fingerprint,result,resource_call_id) VALUES($1,$2,$3,$4::jsonb,$5)',
    [
      tenantId,
      `voice:confirmation:${'b'.repeat(64)}`,
      'callback-fingerprint',
      JSON.stringify({ tenantId, twiml: voice.entryTwiml, outcome: privateText }),
      callId,
    ],
  );
  return { call, inbox, voice, callId };
}
const enable = (tenantId = tenant) =>
  persistence.withTenant(tenantId, (client) => saveRetentionPolicy(client, tenantId, policy, null));
async function rows(tenantId = tenant) {
  return (
    await query(
      'SELECT document FROM calls WHERE tenant_id=$1 UNION ALL SELECT document FROM inbox WHERE tenant_id=$1 UNION ALL SELECT document FROM voice_calls WHERE tenant_id=$1 UNION ALL SELECT document FROM phone_handoffs WHERE tenant_id=$1 UNION ALL SELECT result AS document FROM receipts WHERE tenant_id=$1',
      [tenantId],
    )
  ).rows;
}
async function planned(tenantId = tenant) {
  return persistence.withTenant(tenantId, (client) =>
    planPrivacyBatch(client, { tenantId, binding, now }),
  );
}
async function admit(decision: DeletionDecision) {
  return persistence.withTenant(decision.tenantId, (client) =>
    admitPrivacyDecision(client, { decision, binding, now }),
  );
}

describe('approved caller-content minimization', () => {
  it('replans an unadmitted stale-policy decision with a new event while fencing the old proposal', async () => {
    await fixture();
    await enable();
    const old = (await planned())[0];
    if (!old) throw new Error('Missing decision');
    const changed = { ...policy, version: 2 };
    await persistence.withTenant(tenant, (client) =>
      saveRetentionPolicy(client, tenant, changed, 1),
    );
    expect(await admit(old)).toBe(false);
    const current = (await planned())[0];
    if (!current) throw new Error('Missing replanned decision');
    expect(current.eventId).not.toBe(old.eventId);
    expect(current.policyVersion).toBe(2);
    await expect(admit(old)).rejects.toMatchObject({ code: 'DECISION_BINDING_CHANGED' });
    expect(await admit(current)).toBe(true);
    expect(authority.entries).toEqual([]);
  });
  it('keeps cleanup off without an explicit policy and prevents ordinary API/worker privacy mutations', async () => {
    await fixture();
    expect(await runPrivacyBatch({ persistence, binding, tenantId: tenant, now })).toEqual({
      planned: 0,
      minimized: 0,
      held: 0,
      unavailable: 0,
      needsReplay: false,
    });
    expect(JSON.stringify(await rows())).toContain(privateText);
    for (const role of ['hostline_app', 'hostline_worker']) {
      await query('BEGIN');
      await query(`SET LOCAL ROLE ${role}`);
      await expect(
        query('UPDATE recovery_checkpoints SET applied_through_sequence=10'),
      ).rejects.toMatchObject({ code: '42501' });
      await query('ROLLBACK');
    }
  });
  it('removes caller payload from every supported surface while preserving terminal replay and idempotency evidence', async () => {
    const value = await fixture();
    await enable();
    expect(
      await runPrivacyBatch({ persistence, binding, authority, tenantId: tenant, now }),
    ).toMatchObject({ planned: 1, minimized: 1, needsReplay: true });
    const all = JSON.stringify(await rows());
    expect(all).not.toContain(privateText);
    expect(all).not.toContain('+12125550144');
    const voice = (await query('SELECT document FROM voice_calls WHERE id=$1', [value.callId]))
      .rows[0]?.document;
    expect(voice).toMatchObject({
      state: 'ENDED',
      providerCallSid: value.voice.providerCallSid,
      generation: value.voice.generation,
      streamGrantHash: value.voice.streamGrantHash,
      confirmationGrantHash: value.voice.confirmationGrantHash,
      controlState: 'COMPLETED',
      controlTwiml: null,
    });
    expect((await query('SELECT fingerprint FROM receipts ORDER BY fingerprint')).rows).toEqual([
      { fingerprint: 'callback-fingerprint' },
      { fingerprint: 'unchanged-fingerprint' },
    ]);
    expect(authority.entries).toHaveLength(1);
    expect(JSON.stringify(authority.entries)).not.toContain(privateText);
    const result = await replayRecoveryJournal({
      persistence,
      authority,
      binding,
      now,
      mode: 'scheduled',
    });
    expect(result.complete).toBe(true);
    expect(
      (await inspectRecoveryReadiness({ binding, checkpoint: result.checkpoint, authority })).ready,
    ).toBe(true);
  });
  it('never admits active calls, fulfillment uncertainty, unresolved dispatches, young records, or legal holds', async () => {
    await fixture(tenant, { call: { status: 'active' } });
    await fixture(otherTenant, { inbox: { state: 'NEEDS_RECONCILIATION' } });
    await enable();
    await enable(otherTenant);
    expect(await planned()).toEqual([]);
    expect(await planned(otherTenant)).toEqual([]);
    await query('TRUNCATE calls CASCADE');
    await fixture(tenant, { voice: { controlState: 'UNKNOWN' } });
    expect(await planned()).toEqual([]);
    await query('TRUNCATE calls CASCADE');
    await fixture(tenant, { call: { updatedAt: now.toISOString() } });
    expect(await planned()).toEqual([]);
    await query('TRUNCATE calls CASCADE');
    const held = await fixture();
    await query(
      'INSERT INTO privacy_holds(tenant_id,call_id,approval_id,expires_at) VALUES($1,$2,$3,$4)',
      [tenant, held.callId, randomUUID(), '2027-01-01T00:00:00Z'],
    );
    expect(await planned()).toEqual([]);
    expect(authority.entries).toEqual([]);
  });
  it('blocks unknown and unlinked receipt formats instead of reporting partial privacy completion', async () => {
    const value = await fixture();
    await enable();
    await query(
      'INSERT INTO receipts(tenant_id,idempotency_key,fingerprint,result,resource_call_id) VALUES($1,$2,$3,$4::jsonb,$5)',
      [tenant, 'unknown-operation', 'opaque', JSON.stringify({ privateText }), value.callId],
    );
    await expect(planned()).rejects.toMatchObject({ code: 'UNKNOWN_RECEIPT' });
    await query('DELETE FROM receipts WHERE idempotency_key=$1', ['unknown-operation']);
    await query(
      'INSERT INTO receipts(tenant_id,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)',
      [tenant, 'legacy-operation', 'opaque', JSON.stringify({ privateText })],
    );
    await expect(planned()).rejects.toMatchObject({ code: 'LEGACY_RECEIPTS' });
    expect(authority.entries).toEqual([]);
    expect(JSON.stringify(await rows())).toContain(privateText);
  });
  it('honors a hold before admission, and completes an admitted decision despite later hold/policy edits', async () => {
    const value = await fixture();
    await enable();
    const decision = (await planned())[0];
    if (!decision) throw new Error('Missing decision');
    await query(
      'INSERT INTO privacy_holds(tenant_id,call_id,approval_id,expires_at) VALUES($1,$2,$3,$4)',
      [tenant, value.callId, randomUUID(), '2027-01-01T00:00:00Z'],
    );
    expect(await admit(decision)).toBe(false);
    await query('DELETE FROM privacy_holds');
    expect(await admit(decision)).toBe(true);
    await query(
      'INSERT INTO privacy_holds(tenant_id,call_id,approval_id,expires_at) VALUES($1,$2,$3,$4)',
      [tenant, value.callId, randomUUID(), '2027-01-01T00:00:00Z'],
    );
    await persistence.withTenant(tenant, (client) =>
      saveRetentionPolicy(
        client,
        tenant,
        { enabled: false, version: 2, policyId: policy.policyId },
        1,
      ),
    );
    expect(
      await runPrivacyBatch({ persistence, binding, authority, tenantId: tenant, now }),
    ).toMatchObject({ minimized: 1, needsReplay: true });
    expect(JSON.stringify(await rows())).not.toContain(privateText);
  });
  it('retries a precommit journal outage under one admitted event and reconciles a lost acknowledgment without duplicate journal entries', async () => {
    await fixture();
    await enable();
    authority.failBeforeAppend = true;
    expect(
      await runPrivacyBatch({ persistence, binding, authority, tenantId: tenant, now }),
    ).toMatchObject({ unavailable: 1, minimized: 0 });
    expect(JSON.stringify(await rows())).toContain(privateText);
    authority.failBeforeAppend = false;
    authority.loseAcknowledgment = true;
    expect(
      await runPrivacyBatch({ persistence, binding, authority, tenantId: tenant, now }),
    ).toMatchObject({ unavailable: 1, needsReplay: true });
    expect(authority.entries).toHaveLength(1);
    await expect(
      runPrivacyBatch({ persistence, binding, authority, tenantId: tenant, now }),
    ).rejects.toMatchObject({ code: 'RECOVERY_QUARANTINED' });
    const result = await replayRecoveryJournal({
      persistence,
      authority,
      binding,
      now,
      mode: 'scheduled',
    });
    expect(result.complete).toBe(true);
    expect(authority.entries).toHaveLength(1);
    expect(JSON.stringify(await rows())).not.toContain(privateText);
  });
  it('enforces tenant-scoped plans and explicit bounded batches', async () => {
    await fixture();
    await fixture(otherTenant);
    await enable();
    await enable(otherTenant);
    const first = await persistence.withTenant(tenant, (client) =>
      planPrivacyBatch(client, { tenantId: tenant, binding, now, limit: 1 }),
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.tenantId).toBe(tenant);
    await expect(
      persistence.withTenant(otherTenant, (client) =>
        planPrivacyBatch(client, { tenantId: tenant, binding, now }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      persistence.withTenant(tenant, (client) =>
        planPrivacyBatch(client, { tenantId: tenant, binding, now, limit: 26 }),
      ),
    ).rejects.toBeDefined();
    expect(JSON.stringify(await rows(otherTenant))).toContain(privateText);
  });
});

describe('independent authority and restore quarantine', () => {
  it('opens an existing offline database under the dedicated role and fences escaped SQL callbacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hostline-privacy-operator-'));
    let operator: PrivacyOperatorPersistence | undefined;
    try {
      const directory = join(root, 'database'),
        offline = new PGlite(directory);
      await offline.waitReady;
      for (const name of [
        '001_initial.sql',
        '002_voice_calls.sql',
        '003_phone_operations.sql',
        '004_identity.sql',
        '005_privacy.sql',
      ])
        await offline.exec(
          await readFile(
            new URL(`../packages/database/migrations/${name}`, import.meta.url),
            'utf8',
          ),
        );
      await offline.close();
      operator = await createPrivacyPersistence({ dataDir: directory });
      let escaped: PrivacySqlClient | undefined;
      const role = await operator.withControl(async (client) => {
        escaped = client;
        return (await client.query('SELECT current_user AS role')).rows[0]?.role;
      });
      expect(role).toBe('hostline_privacy');
      expect(await operator.readCheckpoint(binding.installationId)).toBeNull();
      await expect(escaped?.query('SELECT 1')).rejects.toMatchObject({ code: 'TRANSACTION_ENDED' });
      await operator.close();
      await expect(operator.withControl(async () => undefined)).rejects.toMatchObject({
        code: 'PERSISTENCE_CLOSED',
      });
      // Offline test owner can simulate role drift. The assumed role is still
      // checked even though original embedded administration is an exception.
      for (const [unsafe, safe] of [
        ['BYPASSRLS', 'NOBYPASSRLS'],
        ['CREATEROLE', 'NOCREATEROLE'],
        ['LOGIN', 'NOLOGIN'],
      ]) {
        const owner = new PGlite(directory);
        await owner.waitReady;
        await owner.exec(`ALTER ROLE hostline_privacy ${unsafe}`);
        await owner.close();
        await expect(createPrivacyPersistence({ dataDir: directory })).rejects.toMatchObject({
          code: 'UNSAFE_PRIVACY_ROLE',
        });
        const reset = new PGlite(directory);
        await reset.waitReady;
        await reset.exec(`ALTER ROLE hostline_privacy ${safe}`);
        await reset.close();
      }
      const owner = new PGlite(directory);
      await owner.waitReady;
      await owner.exec('GRANT hostline_auth_broker TO hostline_privacy');
      await owner.close();
      await expect(createPrivacyPersistence({ dataDir: directory })).rejects.toMatchObject({
        code: 'UNSAFE_PRIVACY_ROLE',
      });
    } finally {
      await operator?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('fails closed for missing authority, changed epoch/resource/security, incomplete coverage, and rolled-back checkpoints', async () => {
    const checkpoint = await persistence.readCheckpoint(binding.installationId);
    expect(await inspectRecoveryReadiness({ binding, checkpoint })).toEqual({
      ready: false,
      reason: 'UNCONFIGURED',
    });
    for (const patch of [
      { epoch: randomUUID() },
      { databaseResourceId: 'different-resource' },
      { securityReauthorized: false },
      { securityVersion: 2 },
      { coverageComplete: false },
    ]) {
      authority.manifest = {
        ...new FakeAuthority().manifest,
        ...patch,
        replaySources: [
          { epoch: binding.epoch, databaseResourceId: binding.databaseResourceId },
          {
            epoch: typeof patch.epoch === 'string' ? patch.epoch : binding.epoch,
            databaseResourceId:
              typeof patch.databaseResourceId === 'string'
                ? patch.databaseResourceId
                : binding.databaseResourceId,
          },
        ].filter(
          (source, index, list) =>
            list.findIndex(
              (other) =>
                other.epoch === source.epoch &&
                other.databaseResourceId === source.databaseResourceId,
            ) === index,
        ),
      };
      expect((await inspectRecoveryReadiness({ binding, checkpoint, authority })).ready).toBe(
        false,
      );
    }
    authority = new FakeAuthority();
    const value = await fixture();
    await enable();
    const decision = (await planned())[0];
    if (!decision) throw new Error('Missing decision');
    await admit(decision);
    await authority.appendDeletion(decision);
    expect(await inspectRecoveryReadiness({ binding, checkpoint, authority })).toEqual({
      ready: false,
      reason: 'REPLAY_PENDING',
    });
    const foreign = { ...binding, databaseResourceId: 'foreign-db' };
    await expect(
      persistence.withTenant(tenant, (client) =>
        applyPrivacyDecision(client, {
          decision,
          acknowledgment: {
            eventId: decision.eventId,
            sequence: 1,
            decisionDigest: deletionDecisionDigest(decision),
          },
          binding: foreign,
          now,
          mode: 'scheduled',
        }),
      ),
    ).rejects.toMatchObject({ code: 'DECISION_BINDING_CHANGED' });
    expect(
      (await query('SELECT state FROM voice_calls WHERE id=$1', [value.callId])).rows[0]?.state,
    ).toBe('ENDED');
  });
  it('reapplies historical deletion after a controlled epoch/resource change without reopening restored uncertain states', async () => {
    const value = await fixture();
    await enable();
    await persistence.withTenant(tenant, (client) =>
      saveRetentionPolicy(client, tenant, { ...policy, version: 2 }, 1),
    );
    await runPrivacyBatch({ persistence, binding, authority, tenantId: tenant, now });
    // Synthetic older database copy: the independent journal is deliberately retained.
    const restoredCall = { ...value.call, status: 'active', phase: 'awaiting_confirmation' };
    const restoredVoice = {
      ...value.voice,
      state: 'NEEDS_RECONCILIATION',
      controlState: 'UNKNOWN',
    };
    const restoredInbox = { ...value.inbox, state: 'IN_FULFILLMENT' };
    await query('UPDATE calls SET document=$2::jsonb,version=1 WHERE id=$1', [
      value.callId,
      JSON.stringify(restoredCall),
    ]);
    await query(
      "UPDATE voice_calls SET document=$2::jsonb,state='NEEDS_RECONCILIATION',version=1 WHERE id=$1",
      [value.callId, JSON.stringify(restoredVoice)],
    );
    await query(
      "UPDATE inbox SET document=$2::jsonb,state='IN_FULFILLMENT',version=1 WHERE id=$1",
      [value.inbox.id, JSON.stringify(restoredInbox)],
    );
    await query('TRUNCATE privacy_decisions');
    const recovered = {
      ...binding,
      epoch: randomUUID(),
      databaseResourceId: 'synthetic-restored-db',
    };
    authority.manifest = {
      ...authority.manifest,
      ...recovered,
      replaySources: [
        ...authority.manifest.replaySources,
        { epoch: recovered.epoch, databaseResourceId: recovered.databaseResourceId },
      ],
    };
    expect(
      (
        await inspectRecoveryReadiness({
          binding: recovered,
          checkpoint: await persistence.readCheckpoint(binding.installationId),
          authority,
        })
      ).ready,
    ).toBe(false);
    const result = await replayRecoveryJournal({
      persistence,
      authority,
      binding: recovered,
      now,
      mode: 'restore',
    });
    expect(result.complete).toBe(true);
    expect(
      Number(
        (
          await query('SELECT admitted_policy_version FROM privacy_decisions WHERE call_id=$1', [
            value.callId,
          ])
        ).rows[0]?.admitted_policy_version,
      ),
    ).toBe(2);
    expect(JSON.stringify(await rows())).not.toContain(privateText);
    expect(
      (await query('SELECT state FROM inbox WHERE id=$1', [value.inbox.id])).rows[0]?.state,
    ).toBe('IN_FULFILLMENT');
    expect(
      (await query('SELECT state FROM voice_calls WHERE id=$1', [value.callId])).rows[0]?.state,
    ).toBe('NEEDS_RECONCILIATION');
    expect(
      (await query('SELECT document FROM calls WHERE id=$1', [value.callId])).rows[0]?.document,
    ).toMatchObject({ status: 'active', proposal: null, draft: {}, messages: [] });
  });
  it('replays concurrent decisions across tenants without skipping a newly appended sequence', async () => {
    await fixture();
    await fixture(otherTenant);
    await enable();
    await enable(otherTenant);
    const first = (await planned())[0],
      second = (await planned(otherTenant))[0];
    if (!first || !second) throw new Error('Missing decisions');
    await admit(first);
    await admit(second);
    await authority.appendDeletion(first);
    authority.afterPage = async () => {
      await authority.appendDeletion(second);
    };
    const result = await replayRecoveryJournal({
      persistence,
      authority,
      binding,
      now,
      mode: 'scheduled',
    });
    expect(result).toMatchObject({ replayed: 2, throughSequence: 2, complete: true });
    expect(result.checkpoint.appliedThroughSequence).toBe(2);
    expect(JSON.stringify(await rows(otherTenant))).not.toContain(privateText);
  });
  it('rejects journal gaps and unapproved historical bindings and independently bounds an authority that ignores cancellation', async () => {
    await fixture();
    await enable();
    const decision = (await planned())[0];
    if (!decision) throw new Error('Missing decision');
    authority.entries.push({
      sequence: 2,
      decision,
      decisionDigest: deletionDecisionDigest(decision),
    });
    await expect(
      readRecoveryDeletionPage(authority, {
        installationId: binding.installationId,
        epoch: binding.epoch,
        afterSequence: 0,
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_GAP' });
    const foreign = { ...decision, epoch: randomUUID() };
    authority.entries = [
      { sequence: 1, decision: foreign, decisionDigest: deletionDecisionDigest(foreign) },
    ];
    await expect(
      readRecoveryDeletionPage(authority, {
        installationId: binding.installationId,
        epoch: binding.epoch,
        afterSequence: 0,
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_GAP' });
    vi.useFakeTimers();
    let aborted = false;
    const unavailable: RecoveryAuthority = {
      ...authority,
      getManifest: (_input, signal) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise(() => {});
      },
      appendDeletion: (input) => authority.appendDeletion(input),
      readDeletions: (input) => authority.readDeletions(input),
    };
    const pending = inspectRecoveryReadiness({
      binding,
      checkpoint: { ...binding, securityVersion: 1, appliedThroughSequence: 0 },
      authority: unavailable,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ ready: false, reason: 'AUTHORITY_UNAVAILABLE' });
    expect(aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
