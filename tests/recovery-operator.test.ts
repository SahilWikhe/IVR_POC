import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEMO_TENANTS,
  type CallSession,
  type InboxItem,
  type VoiceCallRecord,
} from '@hostline/contracts';
import {
  createDatabase,
  inspectIdentityAccess,
  provisionIdentityAccess,
  type AuthSessionBinding,
  type Database,
  type LoginAttemptBinding,
} from '@hostline/database';
import {
  inspectRestoredAuthority,
  quarantineRestoredDatabase,
  type RestoreQuarantineInput,
} from '../packages/database/src/recovery-operator.js';
import {
  deletionDecisionDigest,
  type RecoveryAuthority,
  type RecoveryManifest,
} from '../packages/database/src/privacy.js';

const stamp = new Date().toISOString();
const future = () => new Date(Date.now() + 240_000).toISOString();
const opaque = () => createHash('sha256').update(randomUUID()).digest('hex');
const issuer = 'https://restore-identity.test.invalid/';
const clientId = 'synthetic-restore-client';
const redirectUri = 'https://restore-dashboard.test.invalid/api/auth/callback';
const tenantIds = [DEMO_TENANTS.harbor, DEMO_TENANTS.juniper];
const priorEpoch = randomUUID();
const manifest: RecoveryManifest = {
  installationId: randomUUID(),
  epoch: randomUUID(),
  databaseResourceId: 'db-restored-synthetic',
  securityVersion: 2,
  securityReauthorized: false,
  coverageComplete: true,
  coverageStartSequence: 1,
  throughSequence: 1,
  replaySources: [],
};
manifest.replaySources = [
  { epoch: priorEpoch, databaseResourceId: 'db-old-synthetic' },
  { epoch: manifest.epoch, databaseResourceId: manifest.databaseResourceId },
];
const input: RestoreQuarantineInput = {
  binding: {
    installationId: manifest.installationId,
    epoch: manifest.epoch,
    databaseResourceId: manifest.databaseResourceId,
  },
  expectedManifest: manifest,
  confirmedInstallationId: manifest.installationId,
  approvalId: randomUUID(),
};
const getManifest = vi.fn(async () => structuredClone(manifest));
const authority: RecoveryAuthority = {
  getManifest,
  appendDeletion: vi.fn(async () => {
    throw new Error('No journal writes permitted');
  }),
  readDeletions: vi.fn(async () => {
    throw new Error('No journal reads needed for fencing');
  }),
};

function phoneFixture(controlState: VoiceCallRecord['controlState'], ended = false) {
  const callId = randomUUID();
  const proposalId = randomUUID();
  const call: CallSession = {
    id: callId,
    version: 1,
    mode: 'voice',
    status: ended ? 'ended' : 'active',
    phase: 'awaiting_confirmation',
    draft: { name: 'Synthetic Guest', callbackNumber: '+12125550144' },
    messages: [],
    proposal: {
      id: proposalId,
      kind: 'message',
      reservation: null,
      message: {
        name: 'Synthetic Guest',
        callbackNumber: '+12125550144',
        message: 'Synthetic request',
      },
      readback: 'Synthetic canonical message',
      digest: opaque(),
      expiresAt: future(),
      configVersion: 1,
      referenceAt: stamp,
    },
    outcome: null,
    inboxItemId: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const voice: VoiceCallRecord = {
    id: callId,
    providerCallSid: `CA${randomUUID().replaceAll('-', '')}`,
    accountSid: `AC${'a'.repeat(32)}`,
    version: 1,
    policyVersion: 1,
    state: ended ? 'ENDED' : controlState ? 'CONTROL_PENDING' : 'STREAMING',
    generation: randomUUID(),
    leaseExpiresAt: future(),
    streamSid: `MZ${'a'.repeat(32)}`,
    streamGrantHash: opaque(),
    streamGrantExpiresAt: future(),
    entryTwiml: '<Response><Connect/></Response>',
    controlId: controlState ? randomUUID() : null,
    controlKind: controlState ? 'transfer' : null,
    controlState,
    controlTwiml: controlState ? '<Response><Dial>+12125550145</Dial></Response>' : null,
    confirmationGrantHash: controlState ? opaque() : null,
    confirmationExpiresAt: controlState ? future() : null,
    proposalId: controlState ? proposalId : null,
    transferDestination: controlState ? '+12125550145' : null,
    transferChildSid: controlState && controlState !== 'PREPARED' ? `CA${'b'.repeat(32)}` : null,
    outcome: ended ? 'Provider terminal evidence' : 'Provider outcome uncertain',
    createdAt: stamp,
    updatedAt: stamp,
    endedAt: ended ? stamp : null,
  };
  return { call, voice };
}

describe('explicit offline restored-authority quarantine', () => {
  let directory: string;
  const voices: VoiceCallRecord[] = [];
  const inbox: InboxItem[] = [];
  const sessions: AuthSessionBinding[] = [];
  const attempts: LoginAttemptBinding[] = [];
  const policyId = randomUUID();
  const oldApprovalId = randomUUID();
  const holdApprovalId = randomUUID();
  const eventId = randomUUID();
  const receiptKey = 'synthetic-sent-control-receipt';
  const jobs: string[] = [];

  async function read<T>(work: (sql: PGlite) => Promise<T>): Promise<T> {
    const sql = new PGlite(directory);
    await sql.waitReady;
    try {
      return await work(sql);
    } finally {
      await sql.close();
    }
  }
  async function brokerRows(table: 'auth_identities' | 'auth_sessions' | 'auth_login_attempts') {
    return read(async (sql) => {
      await sql.exec('BEGIN; SET LOCAL ROLE hostline_auth_broker');
      try {
        return (
          await sql.query<Record<string, unknown>>(
            `SELECT * FROM ${table} ORDER BY ${table === 'auth_identities' ? 'id' : 'token_hash'}`,
          )
        ).rows;
      } finally {
        await sql.exec('ROLLBACK');
      }
    });
  }
  async function claim(database: Database, pending = false) {
    const login = { tokenHash: opaque(), issuer, clientId, redirectUri };
    attempts.push(login);
    await database.auth.createLoginAttempt({
      ...login,
      encryptedPayload: 'synthetic-encrypted-state',
      expiresAt: future(),
    });
    if (!pending) expect(await database.auth.consumeLoginAttempt(login)).not.toBeNull();
    return login;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hostline-restore-fence-'));
    let database = await createDatabase({ dataDir: directory });
    await database.seedDemo();
    await database.close();
    for (const tenantId of tenantIds) {
      const reference = { issuer, subject: `synthetic-${tenantId}`, tenantId };
      const snapshot = await inspectIdentityAccess({ dataDir: directory }, reference);
      await provisionIdentityAccess(
        { dataDir: directory },
        {
          ...reference,
          displayName: 'Synthetic Owner',
          workspaceName: 'Synthetic Restaurant',
          role: 'owner',
          identityEnabled: true,
          membershipEnabled: true,
          tenantEnabled: true,
          expectedIdentityVersion: null,
          expectedMembershipVersion: null,
          expectedTenantVersion: snapshot.tenant?.version ?? null,
        },
      );
    }
    database = await createDatabase({ dataDir: directory });
    for (const tenantId of tenantIds) {
      const session = { tokenHash: opaque(), issuer, clientId };
      sessions.push(session);
      expect(
        await database.auth.issueSession({
          ...session,
          subject: `synthetic-${tenantId}`,
          tenantId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          loginAttempt: await claim(database),
        }),
      ).not.toBeNull();
    }
    await claim(database, true);
    await claim(database);
    for (const [controlState, ended] of [
      [null, false],
      ['PREPARED', false],
      ['DISPATCHED', false],
      ['ACCEPTED', false],
      ['UNKNOWN', false],
      ['COMPLETED', false],
      ['COMPLETED', true],
    ] as const) {
      const fixture = phoneFixture(controlState, ended);
      voices.push(fixture.voice);
      await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
        await tx.insertCall(fixture.call);
        await tx.insertVoiceCall(fixture.voice);
      });
    }
    for (const state of [
      'IN_FULFILLMENT',
      'PENDING_STAFF_REVIEW',
      'BOOKED_AWAITING_GUEST_NOTICE',
      'CLOSED',
    ] as const) {
      const item: InboxItem = {
        id: randomUUID(),
        callId: voices[0]!.id,
        kind: 'message',
        state,
        version: 1,
        name: 'Synthetic Guest',
        callbackNumber: '+12125550144',
        reservation: null,
        message: 'Synthetic request',
        assignedTo: 'synthetic-owner',
        leaseExpiresAt: future(),
        bookingEvidence: 'Synthetic booking reference',
        evidenceSource: 'STAFF_REPORTED',
        guestNotice: 'PENDING',
        guestNoticeNote: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      inbox.push(item);
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.insertInbox(item));
    }
    await database.close();
    await read(async (sql) => {
      const tenantId = DEMO_TENANTS.harbor;
      const callId = voices[0]!.id;
      const policy = {
        enabled: true,
        version: 1,
        policyId,
        approvalId: oldApprovalId,
        closedAfterDays: 30,
      };
      const decision = {
        installationId: manifest.installationId,
        epoch: priorEpoch,
        databaseResourceId: 'db-old-synthetic',
        schemaVersion: 1,
        kind: 'MINIMIZE_CALLER_CONTENT',
        eventId,
        tenantId,
        callId,
        policyId,
        policyVersion: 1,
        cutoffAt: stamp,
        decidedAt: stamp,
      } as const;
      await sql.query('INSERT INTO privacy_policies(tenant_id,version,document) VALUES($1,1,$2)', [
        tenantId,
        JSON.stringify(policy),
      ]);
      await sql.query(
        'INSERT INTO privacy_holds(tenant_id,call_id,approval_id,expires_at) VALUES($1,$2,$3,$4)',
        [tenantId, callId, holdApprovalId, future()],
      );
      await sql.query(
        'INSERT INTO privacy_decisions(tenant_id,call_id,event_id,document,admitted_at,admitted_policy_version,journal_sequence) VALUES($1,$2,$3,$4,$5,1,1)',
        [tenantId, callId, eventId, JSON.stringify(decision), stamp],
      );
      await sql.query(
        'INSERT INTO receipts(tenant_id,idempotency_key,fingerprint,result,resource_call_id) VALUES($1,$2,$3,$4,$5)',
        [
          tenantId,
          receiptKey,
          deletionDecisionDigest(decision),
          JSON.stringify({ accepted: true }),
          callId,
        ],
      );
      await sql.query(
        'INSERT INTO recovery_checkpoints(installation_id,epoch,database_resource_id,security_version,applied_through_sequence,updated_at) VALUES($1,$2,$3,1,1,$4)',
        [manifest.installationId, priorEpoch, 'db-old-synthetic', stamp],
      );
      for (const state of ['pending', 'leased', 'complete']) {
        const id = randomUUID();
        jobs.push(id);
        await sql.query('INSERT INTO outbox(tenant_id,id,kind,resource_id) VALUES($1,$2,$3,$4)', [
          tenantId,
          id,
          'internal.synthetic',
          callId,
        ]);
        await sql.query(
          'INSERT INTO jobs(tenant_id,id,outbox_id,state,lease_token,lease_expires_at) VALUES($1,$2,$2,$3,$4,$5)',
          [
            tenantId,
            id,
            state,
            state === 'leased' ? randomUUID() : null,
            state === 'leased' ? future() : null,
          ],
        );
      }
    });
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('inspects only opaque counts without changing restored authority', async () => {
    const counts = await inspectRestoredAuthority({ dataDir: directory });
    expect(counts).toMatchObject({
      tenants: 2,
      identities: 2,
      memberships: 2,
      sessions: 2,
      loginAttempts: 4,
      voiceCalls: 7,
      nonterminalVoiceCalls: 6,
      privacyPolicies: 1,
      pendingJobs: 2,
    });
    expect(Object.values(counts).every((value) => typeof value === 'number')).toBe(true);
    expect(await brokerRows('auth_sessions')).toHaveLength(2);
  });

  it('refuses an empty offline directory without creating a database', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'hostline-empty-restore-'));
    try {
      await expect(inspectRestoredAuthority({ dataDir: empty })).rejects.toMatchObject({
        code: 'OPERATOR_UNAVAILABLE',
      });
      await expect(
        quarantineRestoredDatabase({ dataDir: empty }, input, authority),
      ).rejects.toMatchObject({ code: 'OPERATOR_UNAVAILABLE' });
      expect(await readdir(empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('rejects wrong typed confirmation, a mismatched resource, or already authorized recovery before any database work', async () => {
    const invalid = [
      { ...input, confirmedInstallationId: randomUUID() },
      { ...input, binding: { ...input.binding, databaseResourceId: 'wrong-restored-resource' } },
      { ...input, expectedManifest: { ...manifest, securityReauthorized: true } },
      { ...input, approvalId: 'not-an-approval-uuid' },
    ];
    getManifest.mockClear();
    for (const value of invalid)
      await expect(
        quarantineRestoredDatabase({ dataDir: directory }, value, authority),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIRMATION' });
    expect(getManifest).not.toHaveBeenCalled();
    expect(await brokerRows('auth_sessions')).toHaveLength(2);
  });

  it('requires a fresh matching independent manifest and sanitizes unavailable authority', async () => {
    getManifest.mockResolvedValueOnce({ ...manifest, securityVersion: 3 });
    await expect(
      quarantineRestoredDatabase({ dataDir: directory }, input, authority),
    ).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    getManifest.mockRejectedValueOnce(new Error('Synthetic confidential connection details'));
    await expect(
      quarantineRestoredDatabase({ dataDir: directory }, input, authority),
    ).rejects.toMatchObject({
      code: 'AUTHORITY_CHANGED',
      message: 'Recovery authority changed or is unavailable. Keep the installation quarantined.',
    });
    expect(await brokerRows('auth_sessions')).toHaveLength(2);
  });

  it('rolls every local fence and audit back if authority changes after mutations', async () => {
    getManifest
      .mockResolvedValueOnce(structuredClone(manifest))
      .mockResolvedValueOnce(structuredClone(manifest))
      .mockResolvedValueOnce({ ...manifest, securityReauthorized: true });
    await expect(
      quarantineRestoredDatabase({ dataDir: directory }, input, authority),
    ).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    expect(await brokerRows('auth_sessions')).toHaveLength(2);
    expect(await brokerRows('auth_identities')).toEqual(
      expect.arrayContaining([expect.objectContaining({ enabled: true, version: 1 })]),
    );
    await read(async (sql) => {
      expect(
        (
          await sql.query(
            "SELECT count(*)::int AS n FROM audit_events WHERE action='recovery.quarantined'",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (await sql.query('SELECT version,voice_enabled FROM phone_policies ORDER BY tenant_id'))
          .rows,
      ).toEqual([
        { version: 1, voice_enabled: true },
        { version: 1, voice_enabled: true },
      ]);
      expect((await sql.query('SELECT state FROM jobs WHERE id=$1', [jobs[1]])).rows).toEqual([
        { state: 'leased' },
      ]);
    });
  });

  it('atomically invalidates restored sessions/logins/epochs and holds every uncertain call and job', async () => {
    const result = await quarantineRestoredDatabase({ dataDir: directory }, input, authority);
    expect(result).toMatchObject({
      quarantined: true,
      approvalId: input.approvalId,
      sessions: 2,
      identities: 2,
      nonterminalVoiceCalls: 6,
    });
    expect(await brokerRows('auth_sessions')).toEqual([]);
    expect(
      (await brokerRows('auth_login_attempts')).every(
        (row) => row['state'] === 'CANCELLED' && row['encrypted_payload'] === null,
      ),
    ).toBe(true);
    expect(
      (await brokerRows('auth_identities')).every(
        (row) => row['enabled'] === false && row['version'] === 2,
      ),
    ).toBe(true);
    await read(async (sql) => {
      expect(
        (await sql.query('SELECT version,enabled FROM auth_tenant_access ORDER BY tenant_id')).rows,
      ).toEqual([
        { version: 3, enabled: false },
        { version: 3, enabled: false },
      ]);
      expect(
        (await sql.query('SELECT version,enabled FROM auth_memberships ORDER BY tenant_id')).rows,
      ).toEqual([
        { version: 2, enabled: false },
        { version: 2, enabled: false },
      ]);
      expect(
        (
          await sql.query(
            'SELECT version,voice_enabled,requests_enabled,transfers_enabled FROM phone_policies ORDER BY tenant_id',
          )
        ).rows,
      ).toEqual(
        tenantIds.map(() => ({
          version: 2,
          voice_enabled: false,
          requests_enabled: false,
          transfers_enabled: false,
        })),
      );
      for (const original of voices) {
        const restored = (
          await sql.query<{ document: VoiceCallRecord }>(
            'SELECT document FROM voice_calls WHERE id=$1',
            [original.id],
          )
        ).rows[0]!.document;
        expect(restored).toMatchObject({
          providerCallSid: original.providerCallSid,
          accountSid: original.accountSid,
          policyVersion: original.policyVersion,
          state: original.state === 'ENDED' ? 'ENDED' : 'NEEDS_RECONCILIATION',
          version: 2,
          endedAt: original.endedAt,
          outcome: original.outcome,
          streamSid: null,
          entryTwiml: '<Response><Hangup/></Response>',
        });
        expect(restored.streamGrantHash).not.toBe(original.streamGrantHash);
        expect(new Date(restored.streamGrantExpiresAt).getTime()).toBe(0);
        expect(new Date(restored.leaseExpiresAt).getTime()).toBe(0);
        if (original.controlState && original.controlState !== 'PREPARED') {
          for (const field of [
            'generation',
            'controlId',
            'controlKind',
            'controlState',
            'controlTwiml',
            'confirmationGrantHash',
            'confirmationExpiresAt',
            'proposalId',
            'transferDestination',
            'transferChildSid',
          ] as const)
            expect(restored[field]).toEqual(original[field]);
        } else {
          expect(restored.generation).not.toBe(original.generation);
          expect(restored).toMatchObject({
            controlId: null,
            controlKind: null,
            controlState: null,
            confirmationGrantHash: null,
            proposalId: null,
          });
        }
        const call = (
          await sql.query<{ document: CallSession }>('SELECT document FROM calls WHERE id=$1', [
            original.id,
          ])
        ).rows[0]!.document;
        expect(call).toMatchObject({ version: 2, proposal: null, draft: {} });
      }
      expect(
        (await sql.query<{ state: string }>('SELECT state FROM jobs ORDER BY id')).rows.filter(
          (row) => row.state === 'quarantined',
        ),
      ).toHaveLength(2);
      expect(
        (
          await sql.query('SELECT state,lease_token,lease_expires_at FROM jobs WHERE id=$1', [
            jobs[2],
          ])
        ).rows,
      ).toEqual([{ state: 'complete', lease_token: null, lease_expires_at: null }]);
      expect(
        (
          await sql.query(
            "SELECT actor_id,resource_id FROM audit_events WHERE action='recovery.quarantined'",
          )
        ).rows,
      ).toEqual(tenantIds.map(() => ({ actor_id: 'postgres', resource_id: input.approvalId })));
    });
  });

  it('keeps staff evidence, closed tombstones, holds and deletion lineage while removing unused approvals', async () => {
    await read(async (sql) => {
      for (const original of inbox) {
        const restored = (
          await sql.query<{ document: InboxItem }>('SELECT document FROM inbox WHERE id=$1', [
            original.id,
          ])
        ).rows[0]!.document;
        expect(restored).toMatchObject({
          version: 2,
          state: original.state === 'CLOSED' ? 'CLOSED' : 'NEEDS_RECONCILIATION',
          assignedTo: null,
          leaseExpiresAt: null,
          bookingEvidence: original.bookingEvidence,
          evidenceSource: original.evidenceSource,
          guestNotice: original.guestNotice,
        });
      }
      expect((await sql.query('SELECT document FROM privacy_policies')).rows).toEqual([
        { document: { enabled: false, version: 2, policyId } },
      ]);
      expect((await sql.query('SELECT approval_id FROM privacy_holds')).rows).toEqual([
        { approval_id: holdApprovalId },
      ]);
      expect(
        (
          await sql.query(
            'SELECT event_id,admitted_policy_version,journal_sequence FROM privacy_decisions',
          )
        ).rows,
      ).toEqual([{ event_id: eventId, admitted_policy_version: 1, journal_sequence: 1 }]);
      expect(
        (await sql.query('SELECT result FROM receipts WHERE idempotency_key=$1', [receiptKey]))
          .rows,
      ).toEqual([{ result: { accepted: true } }]);
      expect(
        (
          await sql.query(
            'SELECT epoch,database_resource_id,security_version,applied_through_sequence FROM recovery_checkpoints',
          )
        ).rows,
      ).toEqual([
        {
          epoch: priorEpoch,
          database_resource_id: 'db-old-synthetic',
          security_version: 1,
          applied_through_sequence: 1,
        },
      ]);
    });
    expect(authority.appendDeletion).not.toHaveBeenCalled();
    expect(authority.readDeletions).not.toHaveBeenCalled();
    expect(manifest.securityReauthorized).toBe(false);
  });

  it('cannot revive old sessions or claimed callbacks after explicitly reconstructing access', async () => {
    const tenantId = DEMO_TENANTS.harbor;
    const reference = { issuer, subject: `synthetic-${tenantId}`, tenantId };
    const current = await inspectIdentityAccess({ dataDir: directory }, reference);
    await provisionIdentityAccess(
      { dataDir: directory },
      {
        ...reference,
        displayName: 'Current Synthetic Owner',
        workspaceName: 'Current Restaurant',
        role: 'owner',
        identityEnabled: true,
        membershipEnabled: true,
        tenantEnabled: true,
        expectedIdentityVersion: current.identity!.version,
        expectedMembershipVersion: current.membership!.version,
        expectedTenantVersion: current.tenant!.version,
      },
    );
    const database = await createDatabase({ dataDir: directory });
    try {
      for (const session of sessions) expect(await database.auth.getSession(session)).toBeNull();
      for (const login of attempts) {
        expect(await database.auth.consumeLoginAttempt(login)).toBeNull();
        expect(
          await database.auth.issueSession({
            tokenHash: opaque(),
            issuer,
            clientId,
            subject: reference.subject,
            tenantId,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            loginAttempt: login,
          }),
        ).toBeNull();
      }
      expect(
        await database.withTenant(tenantId, (tx) => tx.countActiveVoiceCalls(new Date())),
      ).toBe(6);
      expect(await database.withTenant(tenantId, (tx) => tx.getPhonePolicy())).toMatchObject({
        version: 2,
        voiceEnabled: false,
      });
    } finally {
      await database.close();
    }
  });
});
