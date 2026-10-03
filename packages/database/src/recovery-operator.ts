import { randomBytes, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { z } from 'zod';
import { callSessionSchema, inboxItemSchema, voiceCallRecordSchema } from '@hostline/contracts';
import { postgresConnectionConfig } from './postgres.js';
import {
  readRecoveryManifest,
  recoveryBindingSchema,
  recoveryManifestSchema,
  retentionPolicySchema,
  type PrivacySqlClient,
  type RecoveryAuthority,
} from './privacy.js';

export interface RecoveryOperatorOptions {
  url?: string;
  dataDir?: string;
  caFile?: string;
}

export const restoreQuarantineInputSchema = z
  .object({
    binding: recoveryBindingSchema,
    expectedManifest: recoveryManifestSchema,
    confirmedInstallationId: z.uuid(),
    approvalId: z.uuid(),
  })
  .strict()
  .refine(
    (input) =>
      input.confirmedInstallationId === input.binding.installationId &&
      input.expectedManifest.installationId === input.binding.installationId &&
      input.expectedManifest.epoch === input.binding.epoch &&
      input.expectedManifest.databaseResourceId === input.binding.databaseResourceId &&
      !input.expectedManifest.securityReauthorized,
    { message: 'Confirm the exact externally quarantined installation and recovery binding.' },
  );
export type RestoreQuarantineInput = z.infer<typeof restoreQuarantineInputSchema>;

export interface RestoredAuthorityCounts {
  tenants: number;
  identities: number;
  memberships: number;
  sessions: number;
  loginAttempts: number;
  voiceCalls: number;
  nonterminalVoiceCalls: number;
  inboxItems: number;
  openInboxItems: number;
  pendingJobs: number;
  privacyPolicies: number;
}

export class RecoveryQuarantineError extends Error {
  constructor(
    readonly code: 'INVALID_CONFIRMATION' | 'AUTHORITY_CHANGED' | 'OPERATOR_UNAVAILABLE',
  ) {
    super(
      code === 'INVALID_CONFIRMATION'
        ? 'Confirm the exact externally quarantined installation and recovery binding.'
        : code === 'AUTHORITY_CHANGED'
          ? 'Recovery authority changed or is unavailable. Keep the installation quarantined.'
          : 'Recovery fencing could not complete. Keep the installation quarantined.',
    );
    this.name = 'RecoveryQuarantineError';
  }
}

const protectedTables = [
  'tenant_registry',
  'restaurants',
  'calls',
  'inbox',
  'receipts',
  'audit_events',
  'outbox',
  'jobs',
  'voice_calls',
  'phone_policies',
  'phone_handoffs',
  'auth_identities',
  'auth_tenant_access',
  'auth_memberships',
  'auth_sessions',
  'auth_login_attempts',
  'privacy_policies',
  'privacy_holds',
  'privacy_decisions',
  'recovery_checkpoints',
];

/** Never migrates, seeds, changes external authority, or calls a phone provider. */
async function operatorTransaction<T>(
  options: RecoveryOperatorOptions,
  work: (client: PrivacySqlClient) => Promise<T>,
  readOnly = false,
): Promise<T> {
  if (Boolean(options.url) === Boolean(options.dataDir))
    throw new RecoveryQuarantineError('OPERATOR_UNAVAILABLE');
  let close: () => Promise<void>;
  let client: PrivacySqlClient;
  try {
    if (options.url) {
      const pool = new pg.Pool({
        ...(await postgresConnectionConfig({
          url: options.url,
          ...(options.caFile ? { caFile: options.caFile } : {}),
        })),
        max: 1,
        connectionTimeoutMillis: 5000,
      });
      let connection: pg.PoolClient;
      try {
        connection = await pool.connect();
      } catch {
        await pool.end();
        throw new RecoveryQuarantineError('OPERATOR_UNAVAILABLE');
      }
      close = async () => {
        connection.release();
        await pool.end();
      };
      client = {
        query: async (text, values) => {
          const result = await connection.query<Record<string, unknown>>(text, values);
          return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
        },
      };
    } else {
      if (!options.dataDir) throw new RecoveryQuarantineError('OPERATOR_UNAVAILABLE');
      await access(join(options.dataDir, 'PG_VERSION'));
      const embedded = new PGlite(options.dataDir);
      try {
        await embedded.waitReady;
      } catch (error) {
        await embedded.close();
        throw error;
      }
      close = () => embedded.close();
      client = {
        query: async (text, values) => {
          const result = await embedded.query<Record<string, unknown>>(text, values);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
      };
    }
  } catch {
    throw new RecoveryQuarantineError('OPERATOR_UNAVAILABLE');
  }
  try {
    await client.query('BEGIN');
    if (readOnly) await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query("SET LOCAL lock_timeout='2000ms'");
    // The original login must own every affected table. SET ROLE broker alone,
    // a runtime group, or a powerful native superuser is not recovery custody.
    const owner = (
      await client.query(
        `SELECT count(*)::integer AS owned FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND pg_get_userbyid(c.relowner)=session_user`,
        [protectedTables],
      )
    ).rows[0];
    const login = (
      await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')
    ).rows[0];
    if (
      owner?.owned !== protectedTables.length ||
      (options.url && (login?.rolsuper !== false || login?.rolbypassrls !== false))
    )
      throw new RecoveryQuarantineError('OPERATOR_UNAVAILABLE');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Closing the dedicated connection also abandons uncommitted work.
    }
    if (error instanceof RecoveryQuarantineError) throw error;
    throw new RecoveryQuarantineError('OPERATOR_UNAVAILABLE');
  } finally {
    try {
      await close();
    } catch {
      // Closing cannot grant recovery authority or undo a committed local fence.
      // Keep raw driver diagnostics out of the operator response.
    }
  }
}

function emptyCounts(): RestoredAuthorityCounts {
  return {
    tenants: 0,
    identities: 0,
    memberships: 0,
    sessions: 0,
    loginAttempts: 0,
    voiceCalls: 0,
    nonterminalVoiceCalls: 0,
    inboxItems: 0,
    openInboxItems: 0,
    pendingJobs: 0,
    privacyPolicies: 0,
  };
}
async function count(
  client: PrivacySqlClient,
  sql: string,
  values: unknown[] = [],
): Promise<number> {
  const result = await client.query(sql, values);
  return z.coerce
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(result.rows[0]?.n);
}
async function tenantIds(client: PrivacySqlClient): Promise<string[]> {
  await client.query('RESET ROLE');
  return (await client.query('SELECT id FROM tenant_registry ORDER BY id')).rows.map((row) =>
    z.uuid().parse(row.id),
  );
}
async function inspectCounts(
  client: PrivacySqlClient,
  tenants: string[],
): Promise<RestoredAuthorityCounts> {
  const counts = emptyCounts();
  counts.tenants = tenants.length;
  await client.query('SET LOCAL ROLE hostline_auth_broker');
  counts.identities = await count(client, 'SELECT count(*) AS n FROM auth_identities');
  counts.sessions = await count(client, 'SELECT count(*) AS n FROM auth_sessions');
  counts.loginAttempts = await count(client, 'SELECT count(*) AS n FROM auth_login_attempts');
  for (const tenantId of tenants) {
    await client.query("SELECT set_config('hostline.tenant_id',$1,true)", [tenantId]);
    counts.memberships += await count(
      client,
      'SELECT count(*) AS n FROM auth_memberships WHERE tenant_id=$1',
      [tenantId],
    );
    await client.query('RESET ROLE');
    counts.voiceCalls += await count(
      client,
      'SELECT count(*) AS n FROM voice_calls WHERE tenant_id=$1',
      [tenantId],
    );
    counts.nonterminalVoiceCalls += await count(
      client,
      "SELECT count(*) AS n FROM voice_calls WHERE tenant_id=$1 AND state<>'ENDED'",
      [tenantId],
    );
    counts.inboxItems += await count(client, 'SELECT count(*) AS n FROM inbox WHERE tenant_id=$1', [
      tenantId,
    ]);
    counts.openInboxItems += await count(
      client,
      "SELECT count(*) AS n FROM inbox WHERE tenant_id=$1 AND state<>'CLOSED'",
      [tenantId],
    );
    counts.pendingJobs += await count(
      client,
      "SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND state<>'complete'",
      [tenantId],
    );
    counts.privacyPolicies += await count(
      client,
      'SELECT count(*) AS n FROM privacy_policies WHERE tenant_id=$1',
      [tenantId],
    );
    await client.query('SET LOCAL ROLE hostline_auth_broker');
  }
  await client.query('RESET ROLE');
  return counts;
}

/** Opaque counts only; no caller, staff, provider, grant, or session locators. */
export function inspectRestoredAuthority(
  options: RecoveryOperatorOptions,
): Promise<RestoredAuthorityCounts> {
  return operatorTransaction(
    options,
    async (client) => {
      return inspectCounts(client, await tenantIds(client));
    },
    true,
  );
}

async function requireManifest(
  authority: RecoveryAuthority,
  input: RestoreQuarantineInput,
): Promise<void> {
  try {
    const current = await readRecoveryManifest(authority, input.binding.installationId);
    if (!isDeepStrictEqual(current, input.expectedManifest)) throw new Error('Manifest changed');
  } catch {
    throw new RecoveryQuarantineError('AUTHORITY_CHANGED');
  }
}

/**
 * Offline restore fence. Keep the old fleet stopped and the independent manifest
 * false throughout. CLI custody must separately verify the actual RDS target.
 * This function cannot attest current human ownership, routing or provider state.
 */
export async function quarantineRestoredDatabase(
  options: RecoveryOperatorOptions,
  input: RestoreQuarantineInput,
  authority: RecoveryAuthority,
): Promise<RestoredAuthorityCounts & { quarantined: true; approvalId: string }> {
  const parsed = restoreQuarantineInputSchema.safeParse(input);
  if (!parsed.success) throw new RecoveryQuarantineError('INVALID_CONFIRMATION');
  const value = parsed.data;
  await requireManifest(authority, value);
  return operatorTransaction(options, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('recovery_installation:'||$1,0))",
      [value.binding.installationId],
    );
    const tenants = await tenantIds(client);
    await client.query('SET LOCAL ROLE hostline_auth_broker');
    // Login issuance locks its attempt before identity advisory locks. Acquire
    // those table locks first, then drain existing sessions before identity locks.
    // New auth work blocks before taking an identity lock, avoiding inversion.
    await client.query('LOCK TABLE auth_login_attempts IN ACCESS EXCLUSIVE MODE');
    await client.query('LOCK TABLE auth_sessions IN ACCESS EXCLUSIVE MODE');
    await client.query('LOCK TABLE auth_identities IN ACCESS EXCLUSIVE MODE');
    const identities = (await client.query('SELECT id FROM auth_identities ORDER BY id')).rows;
    for (const row of identities)
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('auth_identity:'||$1,0))", [
        z.uuid().parse(row.id),
      ]);
    for (const tenantId of tenants)
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('auth_tenant:'||$1,0))", [
        tenantId,
      ]);
    const counts = await inspectCounts(client, tenants);
    await requireManifest(authority, value);
    await client.query('SET LOCAL ROLE hostline_auth_broker');
    await client.query('UPDATE auth_identities SET version=version+1,enabled=false');
    await client.query('DELETE FROM auth_sessions');
    await client.query(
      "UPDATE auth_login_attempts SET state='CANCELLED',encrypted_payload=NULL WHERE state<>'CANCELLED'",
    );
    const timestamp = new Date().toISOString();
    const expired = new Date(0).toISOString();
    for (const tenantId of tenants) {
      await client.query("SELECT set_config('hostline.tenant_id',$1,true)", [tenantId]);
      await client.query(
        'UPDATE auth_tenant_access SET version=version+1,enabled=false WHERE tenant_id=$1',
        [tenantId],
      );
      await client.query(
        'UPDATE auth_memberships SET version=version+1,enabled=false WHERE tenant_id=$1',
        [tenantId],
      );
      await client.query('RESET ROLE');
      // Follow normal business ordering: configuration, calls, then related rows.
      await client.query('SELECT tenant_id FROM restaurants WHERE tenant_id=$1 FOR UPDATE', [
        tenantId,
      ]);
      await client.query(
        `UPDATE phone_policies SET version=version+1,voice_enabled=false,requests_enabled=false,transfers_enabled=false,updated_at=$2::timestamptz,
         document=jsonb_build_object('version',version+1,'voiceEnabled',false,'requestsEnabled',false,'transfersEnabled',false,
           'updatedAt',to_char($2::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE tenant_id=$1`,
        [tenantId, timestamp],
      );
      for (const row of (
        await client.query('SELECT document FROM calls WHERE tenant_id=$1 ORDER BY id FOR UPDATE', [
          tenantId,
        ])
      ).rows) {
        const call = callSessionSchema.strict().parse(row.document);
        const next = callSessionSchema.strict().parse({
          ...call,
          version: call.version + 1,
          phase: call.status === 'active' ? 'idle' : 'complete',
          draft: {},
          proposal: null,
          updatedAt: timestamp,
        });
        await client.query(
          'UPDATE calls SET version=$3,document=$4::jsonb WHERE tenant_id=$1 AND id=$2 AND version=$5',
          [tenantId, call.id, next.version, JSON.stringify(next), call.version],
        );
      }
      for (const row of (
        await client.query(
          'SELECT document FROM voice_calls WHERE tenant_id=$1 ORDER BY id FOR UPDATE',
          [tenantId],
        )
      ).rows) {
        const voice = voiceCallRecordSchema.parse(row.document);
        const dispatched = voice.controlState !== null && voice.controlState !== 'PREPARED';
        // Possibly sent controls retain all outcome-binding evidence. Expiry is
        // never evidence of provider hangup: every live call remains held.
        const next = voiceCallRecordSchema.parse({
          ...voice,
          version: voice.version + 1,
          state: voice.state === 'ENDED' ? 'ENDED' : 'NEEDS_RECONCILIATION',
          generation: dispatched || voice.state === 'ENDED' ? voice.generation : randomUUID(),
          streamSid: null,
          streamGrantHash: randomBytes(32).toString('hex'),
          streamGrantExpiresAt: expired,
          entryTwiml: '<Response><Hangup/></Response>',
          leaseExpiresAt: expired,
          updatedAt: timestamp,
          ...(!dispatched && voice.state !== 'ENDED'
            ? {
                controlId: null,
                controlKind: null,
                controlState: null,
                controlTwiml: null,
                confirmationGrantHash: null,
                confirmationRetryGrantHash: null,
                confirmationExpiresAt: null,
                proposalId: null,
                transferDestination: null,
              }
            : {}),
        });
        await client.query(
          'UPDATE voice_calls SET version=$3,state=$4,generation=$5,lease_expires_at=$6,document=$7::jsonb WHERE tenant_id=$1 AND id=$2 AND version=$8',
          [
            tenantId,
            voice.id,
            next.version,
            next.state,
            next.generation,
            next.leaseExpiresAt,
            JSON.stringify(next),
            voice.version,
          ],
        );
      }
      for (const row of (
        await client.query('SELECT document FROM inbox WHERE tenant_id=$1 ORDER BY id FOR UPDATE', [
          tenantId,
        ])
      ).rows) {
        const item = inboxItemSchema.strict().parse(row.document);
        const next = inboxItemSchema.strict().parse({
          ...item,
          version: item.version + 1,
          state: item.state === 'CLOSED' ? 'CLOSED' : 'NEEDS_RECONCILIATION',
          assignedTo: null,
          leaseExpiresAt: null,
          updatedAt: timestamp,
        });
        await client.query(
          'UPDATE inbox SET version=$3,state=$4,lease_expires_at=NULL,document=$5::jsonb WHERE tenant_id=$1 AND id=$2 AND version=$6',
          [tenantId, item.id, next.version, next.state, JSON.stringify(next), item.version],
        );
      }
      await client.query(
        "UPDATE jobs SET state='quarantined',lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND state<>'complete'",
        [tenantId],
      );
      for (const row of (
        await client.query('SELECT document FROM privacy_policies WHERE tenant_id=$1 FOR UPDATE', [
          tenantId,
        ])
      ).rows) {
        const policy = retentionPolicySchema.parse(row.document);
        const next = retentionPolicySchema.parse({
          enabled: false,
          version: policy.version + 1,
          policyId: policy.policyId,
        });
        await client.query(
          'UPDATE privacy_policies SET version=$2,document=$3::jsonb WHERE tenant_id=$1 AND version=$4',
          [tenantId, next.version, JSON.stringify(next), policy.version],
        );
      }
      // Holds, admitted deletion decisions, provider receipts and recovery
      // checkpoints retain their protections and immutable replay lineage.
      await client.query(
        "INSERT INTO audit_events(tenant_id,id,actor_id,action,resource_id) VALUES($1,$2,session_user,'recovery.quarantined',$3)",
        [tenantId, randomUUID(), value.approvalId],
      );
      await client.query('SET LOCAL ROLE hostline_auth_broker');
    }
    await requireManifest(authority, value);
    return { ...counts, quarantined: true, approvalId: value.approvalId };
  });
}
