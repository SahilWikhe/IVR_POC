import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { z } from 'zod';
import {
  callSessionSchema,
  callSummarySchema,
  idSchema,
  inboxItemSchema,
  handoffSchema,
  phonePolicySchema,
  restaurantSchema,
  voiceCallRecordSchema,
  tenantAccessSchema,
  type CallSession,
  type CallSummary,
  type InboxItem,
  type Handoff,
  type PhonePolicy,
  type Restaurant,
  type VoiceCallRecord,
  type TenantAccess,
} from '@hostline/contracts';
import { expireFulfillment } from '@hostline/domain';
import { demoData } from './seed.js';
import { postgresConnectionConfig } from './postgres.js';
import {
  createAuthPersistence,
  readAuthSession,
  type AuthPersistence,
  type AuthSessionBinding,
  type AuthSession,
} from './identity.js';
import { readRecoveryCheckpoint, type RecoveryCheckpoint } from './privacy.js';
export * from './identity.js';
export * from './identity-operator.js';
export * from './privacy.js';
export * from './privacy-persistence.js';
export * from './aws-recovery.js';
export * from './recovery-runtime.js';
export * from './recovery-operator.js';
export * from './postgres.js';

type Row = Record<string, unknown>;
interface QueryResult {
  rows: Row[];
  rowCount: number;
}
interface SqlClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export class PersistenceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PersistenceError';
  }
}

export interface TenantTransaction {
  getRestaurant(): Promise<Restaurant>;
  getTenantAccess(): Promise<TenantAccess>;
  saveRestaurant(value: Restaurant, expectedVersion: number): Promise<void>;
  getPhonePolicy(): Promise<PhonePolicy>;
  savePhonePolicy(value: PhonePolicy, expectedVersion: number): Promise<void>;
  listInbox(options?: { offset?: number; limit?: number }): Promise<InboxItem[]>;
  getInbox(id: string): Promise<InboxItem | null>;
  insertInbox(item: InboxItem): Promise<void>;
  saveInbox(item: InboxItem, expectedVersion: number): Promise<void>;
  listCalls(): Promise<CallSummary[]>;
  getCall(id: string): Promise<CallSession | null>;
  insertCall(call: CallSession): Promise<void>;
  saveCall(call: CallSession, expectedVersion: number): Promise<void>;
  getVoiceCall(providerCallSid: string): Promise<VoiceCallRecord | null>;
  getVoiceCallById(id: string): Promise<VoiceCallRecord | null>;
  listVoiceCalls(options?: { offset?: number; limit?: number }): Promise<VoiceCallRecord[]>;
  insertVoiceCall(call: VoiceCallRecord): Promise<void>;
  saveVoiceCall(call: VoiceCallRecord, expectedVersion: number): Promise<void>;
  countActiveVoiceCalls(now: Date): Promise<number>;
  lockVoiceAdmission(): Promise<void>;
  getHandoff(callId: string): Promise<Handoff | null>;
  saveHandoff(value: Handoff): Promise<void>;
  getReceipt(key: string): Promise<{ fingerprint: string; result: unknown } | null>;
  putReceipt(
    key: string,
    fingerprint: string,
    result: unknown,
    resourceCallId?: string,
  ): Promise<void>;
  audit(actorId: string, action: string, resourceId: string): Promise<void>;
  enqueue(kind: string, resourceId: string): Promise<void>;
}
export interface Database {
  readonly auth: AuthPersistence;
  withAuthenticatedTenant<T>(
    binding: AuthSessionBinding,
    work: (tx: TenantTransaction, session: AuthSession) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
  readiness(component?: 'api' | 'worker'): Promise<{ ready: true; migrationVersion: number }>;
  readRecoveryCheckpoint(installationId: string): Promise<RecoveryCheckpoint | null>;
  withTenant<T>(tenantId: string, work: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  seedDemo(): Promise<void>;
  processJobs(limit?: number): Promise<number>;
}

const documentSchema = z.object({ document: z.unknown() });
const keySchema = z.string().min(1).max(250);
const actionSchema = z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/);
const jsonValueSchema = z.json();
const receiptSchema = z.object({ fingerprint: keySchema, result: jsonValueSchema });
const workSchema = z.object({
  tenant_id: idSchema,
  resource_id: idSchema,
  work_kind: z.enum(['job', 'fulfillment']),
});
const jobSchema = z.object({
  id: idSchema,
  lease_token: idSchema,
  attempts: z.number().int().min(1).max(5),
});
const providerCallSidSchema = z.string().regex(/^CA[0-9a-fA-F]{32}$/);
const countSchema = z.object({ count: z.coerce.number().int().min(0) });

function safeDatabaseError(error: unknown): never {
  if (error instanceof PersistenceError) throw error;
  const parsed = z.object({ code: z.string() }).safeParse(error);
  if (parsed.success && ['23505', '40001', '40P01'].includes(parsed.data.code)) {
    throw new PersistenceError('CONFLICT', 409, 'This item changed. Refresh and try again.');
  }
  if (parsed.success && ['23503', '42501', '23514'].includes(parsed.data.code)) {
    throw new PersistenceError(
      'INVALID_REFERENCE',
      409,
      'The requested change is not available in this workspace.',
    );
  }
  // Do not carry raw SQL errors: detail fields can include names and phone numbers.
  throw new PersistenceError(
    'PERSISTENCE_UNAVAILABLE',
    503,
    'The workspace could not save this change. Please try again.',
  );
}

function nextVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1 || actual !== expected + 1) {
    throw new PersistenceError('CONFLICT', 409, 'This item changed. Refresh and try again.');
  }
}

function requireUpdated(result: QueryResult): void {
  if (result.rowCount !== 1)
    throw new PersistenceError(
      'CONFLICT',
      409,
      'This item changed or is no longer available. Refresh and try again.',
    );
}

class Transaction implements TenantTransaction {
  private active = true;
  constructor(
    private readonly client: SqlClient,
    readonly tenantId: string,
  ) {}
  finish(): void {
    this.active = false;
  }
  async query(text: string, values: unknown[] = []): Promise<QueryResult> {
    if (!this.active)
      throw new PersistenceError('TRANSACTION_ENDED', 500, 'This operation is no longer active.');
    try {
      return await this.client.query(text, values);
    } catch (error) {
      safeDatabaseError(error);
    }
  }
  async getTenantAccess(): Promise<TenantAccess> {
    const row = (
      await this.query('SELECT public.auth_read_tenant_access($1::uuid) AS document', [
        this.tenantId,
      ])
    ).rows[0];
    if (!row)
      throw new PersistenceError(
        'TENANT_UNAVAILABLE',
        503,
        'The restaurant access policy is not available.',
      );
    return tenantAccessSchema.parse(documentSchema.parse(row).document);
  }
  async getRestaurant(): Promise<Restaurant> {
    // Hold the approved config version stable through a confirmation transaction.
    // PostgreSQL settings updates must wait until the read/confirmation commits.
    const row = (
      await this.query('SELECT document FROM restaurants WHERE tenant_id = $1 FOR SHARE', [
        this.tenantId,
      ])
    ).rows[0];
    if (!row) throw new PersistenceError('NOT_FOUND', 404, 'Restaurant not found.');
    return restaurantSchema.parse(documentSchema.parse(row).document);
  }
  async saveRestaurant(value: Restaurant, expectedVersion: number): Promise<void> {
    const restaurant = restaurantSchema.parse(value);
    if (restaurant.id !== this.tenantId)
      throw new PersistenceError('NOT_FOUND', 404, 'Restaurant not found.');
    nextVersion(restaurant.version, expectedVersion);
    requireUpdated(
      await this.query(
        'UPDATE restaurants SET version = $2, document = $3::jsonb WHERE tenant_id = $1 AND version = $4',
        [this.tenantId, restaurant.version, JSON.stringify(restaurant), expectedVersion],
      ),
    );
  }
  async getPhonePolicy(): Promise<PhonePolicy> {
    const read = async () =>
      (await this.query('SELECT document FROM phone_policies WHERE tenant_id=$1', [this.tenantId]))
        .rows[0];
    let row = await read();
    if (!row) {
      // A tenant provisioned after migration may not yet have a policy row.
      // Serialize initialization on its existing restaurant before inserting;
      // do not lock a missing row or race an owner policy update.
      await this.lockVoiceAdmission();
      const policy: PhonePolicy = {
        version: 1,
        voiceEnabled: true,
        requestsEnabled: true,
        transfersEnabled: true,
        updatedAt: new Date().toISOString(),
      };
      await this.query(
        'INSERT INTO phone_policies(tenant_id,version,voice_enabled,requests_enabled,transfers_enabled,updated_at,document) VALUES($1,1,true,true,true,$2,$3::jsonb) ON CONFLICT(tenant_id) DO NOTHING',
        [this.tenantId, policy.updatedAt, JSON.stringify(policy)],
      );
      row = await read();
    }
    if (!row) throw new PersistenceError('NOT_FOUND', 404, 'Restaurant policy not found.');
    return phonePolicySchema.parse(documentSchema.parse(row).document);
  }
  async savePhonePolicy(value: PhonePolicy, expectedVersion: number): Promise<void> {
    const policy = phonePolicySchema.parse(value);
    nextVersion(policy.version, expectedVersion);
    requireUpdated(
      await this.query(
        'UPDATE phone_policies SET version=$2,voice_enabled=$3,requests_enabled=$4,transfers_enabled=$5,updated_at=$6,document=$7::jsonb WHERE tenant_id=$1 AND version=$8',
        [
          this.tenantId,
          policy.version,
          policy.voiceEnabled,
          policy.requestsEnabled,
          policy.transfersEnabled,
          policy.updatedAt,
          JSON.stringify(policy),
          expectedVersion,
        ],
      ),
    );
  }
  async listInbox(options: { offset?: number; limit?: number } = {}): Promise<InboxItem[]> {
    const pagination = z
      .object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(200),
      })
      .strict()
      .parse(options);
    const result = await this.query(
      "SELECT document FROM inbox WHERE tenant_id = $1 ORDER BY CASE WHEN state='CLOSED' THEN 1 ELSE 0 END, created_at ASC, id LIMIT $2 OFFSET $3",
      [this.tenantId, pagination.limit, pagination.offset],
    );
    return result.rows.map((row) => inboxItemSchema.parse(documentSchema.parse(row).document));
  }
  async getInbox(id: string): Promise<InboxItem | null> {
    const row = (
      await this.query('SELECT document FROM inbox WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
        this.tenantId,
        idSchema.parse(id),
      ])
    ).rows[0];
    return row ? inboxItemSchema.parse(documentSchema.parse(row).document) : null;
  }
  async insertInbox(value: InboxItem): Promise<void> {
    const item = inboxItemSchema.parse(value);
    await this.query(
      'INSERT INTO inbox (tenant_id,id,call_id,version,state,lease_expires_at,created_at,document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [
        this.tenantId,
        item.id,
        item.callId,
        item.version,
        item.state,
        item.leaseExpiresAt,
        item.createdAt,
        JSON.stringify(item),
      ],
    );
  }
  async saveInbox(value: InboxItem, expectedVersion: number): Promise<void> {
    const item = inboxItemSchema.parse(value);
    nextVersion(item.version, expectedVersion);
    requireUpdated(
      await this.query(
        'UPDATE inbox SET version=$3,state=$4,lease_expires_at=$5,document=$6::jsonb WHERE tenant_id=$1 AND id=$2 AND version=$7 AND call_id=$8',
        [
          this.tenantId,
          item.id,
          item.version,
          item.state,
          item.leaseExpiresAt,
          JSON.stringify(item),
          expectedVersion,
          item.callId,
        ],
      ),
    );
  }
  async listCalls(): Promise<CallSummary[]> {
    const result = await this.query(
      'SELECT document FROM calls WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 100',
      [this.tenantId],
    );
    return result.rows.map((row) => callSummarySchema.parse(documentSchema.parse(row).document));
  }
  async getCall(id: string): Promise<CallSession | null> {
    const row = (
      await this.query('SELECT document FROM calls WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        this.tenantId,
        idSchema.parse(id),
      ])
    ).rows[0];
    return row ? callSessionSchema.parse(documentSchema.parse(row).document) : null;
  }
  async insertCall(value: CallSession): Promise<void> {
    const call = callSessionSchema.parse(value);
    await this.query(
      'INSERT INTO calls (tenant_id,id,version,created_at,document) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [this.tenantId, call.id, call.version, call.createdAt, JSON.stringify(call)],
    );
  }
  async saveCall(value: CallSession, expectedVersion: number): Promise<void> {
    const call = callSessionSchema.parse(value);
    nextVersion(call.version, expectedVersion);
    requireUpdated(
      await this.query(
        'UPDATE calls SET version=$3,document=$4::jsonb WHERE tenant_id=$1 AND id=$2 AND version=$5',
        [this.tenantId, call.id, call.version, JSON.stringify(call), expectedVersion],
      ),
    );
  }
  async getVoiceCall(providerCallSid: string): Promise<VoiceCallRecord | null> {
    const row = (
      await this.query(
        'SELECT document FROM voice_calls WHERE tenant_id=$1 AND provider_call_sid=$2 FOR UPDATE',
        [this.tenantId, providerCallSidSchema.parse(providerCallSid)],
      )
    ).rows[0];
    return row ? voiceCallRecordSchema.parse(documentSchema.parse(row).document) : null;
  }
  async getVoiceCallById(id: string): Promise<VoiceCallRecord | null> {
    const row = (
      await this.query('SELECT document FROM voice_calls WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        this.tenantId,
        idSchema.parse(id),
      ])
    ).rows[0];
    return row ? voiceCallRecordSchema.parse(documentSchema.parse(row).document) : null;
  }
  async listVoiceCalls(
    options: { offset?: number; limit?: number } = {},
  ): Promise<VoiceCallRecord[]> {
    const pagination = z
      .object({
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(options);
    const result = await this.query(
      'SELECT v.document FROM voice_calls v JOIN calls c ON(c.tenant_id=v.tenant_id AND c.id=v.id) WHERE v.tenant_id=$1 ORDER BY c.created_at DESC,v.id LIMIT $2 OFFSET $3',
      [this.tenantId, pagination.limit, pagination.offset],
    );
    return result.rows.map((row) =>
      voiceCallRecordSchema.parse(documentSchema.parse(row).document),
    );
  }
  async insertVoiceCall(value: VoiceCallRecord): Promise<void> {
    const call = voiceCallRecordSchema.parse(value);
    await this.query(
      'INSERT INTO voice_calls (tenant_id,id,provider_call_sid,version,state,generation,lease_expires_at,document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [
        this.tenantId,
        call.id,
        call.providerCallSid,
        call.version,
        call.state,
        call.generation,
        call.leaseExpiresAt,
        JSON.stringify(call),
      ],
    );
  }
  async saveVoiceCall(value: VoiceCallRecord, expectedVersion: number): Promise<void> {
    const call = voiceCallRecordSchema.parse(value);
    nextVersion(call.version, expectedVersion);
    requireUpdated(
      await this.query(
        "UPDATE voice_calls SET version=$3,state=$4,generation=$5,lease_expires_at=$6,document=$7::jsonb WHERE tenant_id=$1 AND id=$2 AND version=$8 AND provider_call_sid=$9 AND document->>'accountSid'=$10",
        [
          this.tenantId,
          call.id,
          call.version,
          call.state,
          call.generation,
          call.leaseExpiresAt,
          JSON.stringify(call),
          expectedVersion,
          call.providerCallSid,
          call.accountSid,
        ],
      ),
    );
  }
  async countActiveVoiceCalls(now: Date): Promise<number> {
    z.date().parse(now);
    // A control lease expiring does not prove Twilio stopped its hosted
    // Say/Gather/Dial instructions. Only authoritative terminal state frees
    // admission; abandoned calls remain held for operator reconciliation.
    const row = (
      await this.query(
        "SELECT count(*) AS count FROM voice_calls WHERE tenant_id=$1 AND state<>'ENDED'",
        [this.tenantId],
      )
    ).rows[0];
    return countSchema.parse(row).count;
  }
  async lockVoiceAdmission(): Promise<void> {
    const row = (
      await this.query('SELECT tenant_id FROM restaurants WHERE tenant_id=$1 FOR UPDATE', [
        this.tenantId,
      ])
    ).rows[0];
    if (!row) throw new PersistenceError('NOT_FOUND', 404, 'Restaurant not found.');
  }
  async getHandoff(callId: string): Promise<Handoff | null> {
    const row = (
      await this.query('SELECT document FROM phone_handoffs WHERE tenant_id=$1 AND call_id=$2', [
        this.tenantId,
        idSchema.parse(callId),
      ])
    ).rows[0];
    return row ? handoffSchema.parse(documentSchema.parse(row).document) : null;
  }
  async saveHandoff(value: Handoff): Promise<void> {
    const handoff = handoffSchema.parse(value);
    // The API first persists its transfer control under the restaurant admission
    // lock. A stale control cannot replace that call's current staff context.
    requireUpdated(
      await this.query(
        `INSERT INTO phone_handoffs(tenant_id,call_id,control_id,reason,summary,created_at,document)
        SELECT tenant_id,id,$3::uuid,$4,$5,$6::timestamptz,$7::jsonb FROM voice_calls
        WHERE tenant_id=$1 AND id=$2 AND document->>'controlKind'='transfer' AND document->>'controlId'=$3::uuid::text
        ON CONFLICT(tenant_id,call_id) DO UPDATE SET control_id=EXCLUDED.control_id,reason=EXCLUDED.reason,summary=EXCLUDED.summary,created_at=EXCLUDED.created_at,document=EXCLUDED.document`,
        [
          this.tenantId,
          handoff.callId,
          handoff.controlId,
          handoff.reason,
          handoff.summary,
          handoff.createdAt,
          JSON.stringify(handoff),
        ],
      ),
    );
  }
  async getReceipt(key: string): Promise<{ fingerprint: string; result: unknown } | null> {
    const row = (
      await this.query(
        'SELECT fingerprint,result FROM receipts WHERE tenant_id=$1 AND idempotency_key=$2',
        [this.tenantId, keySchema.parse(key)],
      )
    ).rows[0];
    return row ? receiptSchema.parse(row) : null;
  }
  async putReceipt(
    key: string,
    fingerprint: string,
    result: unknown,
    resourceCallId?: string,
  ): Promise<void> {
    await this.query(
      'INSERT INTO receipts (tenant_id,idempotency_key,fingerprint,result,resource_call_id) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [
        this.tenantId,
        keySchema.parse(key),
        keySchema.parse(fingerprint),
        JSON.stringify(jsonValueSchema.parse(result)),
        resourceCallId === undefined ? null : idSchema.parse(resourceCallId),
      ],
    );
  }
  async audit(actorId: string, action: string, resourceId: string): Promise<void> {
    await this.query(
      'INSERT INTO audit_events (tenant_id,id,actor_id,action,resource_id) VALUES ($1,$2,$3,$4,$5)',
      [
        this.tenantId,
        randomUUID(),
        keySchema.parse(actorId),
        actionSchema.parse(action),
        idSchema.parse(resourceId),
      ],
    );
  }
  async enqueue(kind: string, resourceId: string): Promise<void> {
    const eventId = randomUUID();
    await this.query('INSERT INTO outbox (tenant_id,id,kind,resource_id) VALUES ($1,$2,$3,$4)', [
      this.tenantId,
      eventId,
      actionSchema.parse(kind),
      idSchema.parse(resourceId),
    ]);
    await this.query('INSERT INTO jobs (tenant_id,id,outbox_id) VALUES ($1,$2,$3)', [
      this.tenantId,
      randomUUID(),
      eventId,
    ]);
  }
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(work: () => Promise<T>): Promise<T> {
    const predecessor = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

interface Backend {
  run<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  embedded: boolean;
}

function pgClient(client: pg.PoolClient): SqlClient {
  return {
    query: async (text, values) => {
      const result = await client.query<Row>(text, values);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
  };
}

const migrations = [
  { version: 1, file: '001_initial.sql' },
  { version: 2, file: '002_voice_calls.sql' },
  { version: 3, file: '003_phone_operations.sql' },
  { version: 4, file: '004_identity.sql' },
  { version: 5, file: '005_privacy.sql' },
] as const;

async function readMigration(file: string): Promise<string> {
  const configuredDirectory = process.env['HOSTLINE_MIGRATIONS_DIR'];
  if (configuredDirectory) return readFile(resolve(configuredDirectory, file), 'utf8');
  try {
    return await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
  } catch (error) {
    if (!z.object({ code: z.literal('ENOENT') }).safeParse(error).success) throw error;
    return readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
  }
}

async function applyMigration(
  client: SqlClient,
  execute: (sql: string) => Promise<void>,
): Promise<void> {
  // The transaction and advisory lock serialize concurrent migration commands.
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(873622019)');
    const table = await client.query("SELECT to_regclass('public.schema_migrations') AS name");
    const applied = new Set<number>();
    if (table.rows[0]?.name !== null) {
      const existing = await client.query('SELECT version FROM schema_migrations');
      for (const row of existing.rows) {
        applied.add(z.object({ version: z.number().int().positive() }).parse(row).version);
      }
    }
    for (const migration of migrations) {
      if (!applied.has(migration.version)) await execute(await readMigration(migration.file));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    safeDatabaseError(error);
  }
}

export async function migrate(url: string, options: { caFile?: string } = {}): Promise<void> {
  const pool = new pg.Pool({
    ...(await postgresConnectionConfig({ url, ...options })),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const client = await pool.connect();
  try {
    await applyMigration(pgClient(client), async (sql) => {
      await client.query(sql);
    });
  } finally {
    client.release();
    await pool.end();
  }
}

async function requireSafeRuntimeRoles(client: SqlClient): Promise<void> {
  const safety = await client.query(
    "SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolcreaterole,rolcreatedb,rolreplication, EXISTS (SELECT FROM pg_class c WHERE c.relname IN ('restaurants','calls','inbox','voice_calls','phone_policies','phone_handoffs','receipts','audit_events','outbox','jobs') AND pg_has_role('hostline_auth_broker',c.relowner,'MEMBER')) OR pg_has_role('hostline_auth_broker','hostline_app','MEMBER') OR pg_has_role('hostline_auth_broker','hostline_worker','MEMBER') OR pg_has_role('hostline_auth_broker','hostline_privacy','MEMBER') OR EXISTS(SELECT FROM pg_class c WHERE c.relname IN ('restaurants','calls','inbox','voice_calls','phone_policies','phone_handoffs','receipts','audit_events','outbox','jobs') AND has_table_privilege('hostline_auth_broker',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS unsafe_broker, EXISTS (SELECT FROM pg_class WHERE relname IN ('restaurants','calls','inbox','voice_calls','phone_policies','phone_handoffs','receipts','audit_events','outbox','jobs','auth_identities','auth_membership_routes','auth_sessions','auth_login_attempts','auth_tenant_access','auth_memberships','auth_operator_events','privacy_policies','privacy_holds','privacy_decisions','recovery_checkpoints') AND relowner = pg_roles.oid) AS owns_tables FROM pg_roles WHERE rolname IN (current_user,'hostline_auth_broker')",
  );
  if (
    safety.rows.length !== 2 ||
    safety.rows.some(
      (row) =>
        row['rolsuper'] !== false ||
        row['rolbypassrls'] !== false ||
        row['owns_tables'] !== false ||
        row['rolcanlogin'] !== false ||
        row['rolcreaterole'] !== false ||
        row['rolcreatedb'] !== false ||
        row['rolreplication'] !== false ||
        row['unsafe_broker'] !== false,
    )
  ) {
    throw new PersistenceError(
      'UNSAFE_DATABASE_ROLE',
      503,
      'The database runtime role must enforce tenant isolation.',
    );
  }
}

export async function createDatabase(
  options: { url?: string; dataDir?: string; caFile?: string } = {},
): Promise<Database> {
  let backend: Backend;
  if (options.url) {
    const pool = new pg.Pool({
      ...(await postgresConnectionConfig({
        url: options.url,
        ...(options.caFile ? { caFile: options.caFile } : {}),
      })),
      max: 10,
      connectionTimeoutMillis: 5000,
    });
    backend = {
      embedded: false,
      run: async (work) => {
        const client = await pool.connect();
        try {
          return await work(pgClient(client));
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    // PGlite creates the database files but expects filesystem parents to exist.
    // URI-backed stores (for example memory://) are not filesystem directories.
    if (options.dataDir && !/^[a-z][a-z0-9+.-]*:\/\//i.test(options.dataDir)) {
      await mkdir(resolve(options.dataDir), { recursive: true, mode: 0o700 });
    }
    const embedded = new PGlite(options.dataDir);
    await embedded.waitReady;
    const mutex = new Mutex();
    const client: SqlClient = {
      query: async (text, values) => {
        const result = await embedded.query<Row>(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
    };
    await applyMigration(client, async (sql) => {
      await embedded.exec(sql);
    });
    backend = {
      embedded: true,
      run: (work) => mutex.run(() => work(client)),
      close: () => mutex.run(() => embedded.close()),
    };
  }

  async function requireSafeLogin(client: SqlClient): Promise<void> {
    if (backend.embedded) return;
    const result = await client.query(
      "SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,pg_has_role(session_user,'hostline_auth_broker','MEMBER') AS broker_member, pg_has_role(session_user,'hostline_privacy','MEMBER') AS privacy_member, EXISTS (SELECT FROM pg_class c WHERE c.relname IN ('restaurants','calls','inbox','voice_calls','phone_policies','phone_handoffs','receipts','audit_events','outbox','jobs','auth_identities','auth_membership_routes','auth_sessions','auth_login_attempts','auth_tenant_access','auth_memberships','auth_operator_events','privacy_policies','privacy_holds','privacy_decisions','recovery_checkpoints') AND pg_has_role(session_user,c.relowner,'MEMBER')) AS owns_tables FROM pg_roles WHERE rolname=session_user",
    );
    const row = result.rows[0];
    if (
      !row ||
      row['rolsuper'] !== false ||
      row['rolbypassrls'] !== false ||
      row['rolcreaterole'] !== false ||
      row['rolcreatedb'] !== false ||
      row['rolreplication'] !== false ||
      row['broker_member'] !== false ||
      row['privacy_member'] !== false ||
      row['owns_tables'] !== false
    )
      throw new PersistenceError(
        'UNSAFE_DATABASE_ROLE',
        503,
        'The database login must have only restricted runtime privileges.',
      );
  }

  async function readiness(
    component: 'api' | 'worker' = 'api',
  ): Promise<{ ready: true; migrationVersion: number }> {
    return backend.run(async (client) => {
      await requireSafeLogin(client);
      await client.query('BEGIN');
      try {
        await client.query(
          component === 'worker'
            ? 'SET LOCAL ROLE hostline_worker'
            : 'SET LOCAL ROLE hostline_auth',
        );
        const result = await client.query('SELECT max(version) AS version FROM schema_migrations');
        if (result.rows[0]?.['version'] !== 5)
          throw new PersistenceError(
            'SCHEMA_UNAVAILABLE',
            503,
            'The database schema is not ready.',
          );
        for (const role of component === 'worker'
          ? (['hostline_app', 'hostline_worker'] as const)
          : (['hostline_app', 'hostline_auth'] as const)) {
          await client.query(
            role === 'hostline_app'
              ? 'SET LOCAL ROLE hostline_app'
              : role === 'hostline_worker'
                ? 'SET LOCAL ROLE hostline_worker'
                : 'SET LOCAL ROLE hostline_auth',
          );
          await requireSafeRuntimeRoles(client);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        safeDatabaseError(error);
      }
      return { ready: true, migrationVersion: 5 };
    });
  }

  async function transact<T>(
    role: 'hostline_app' | 'hostline_worker' | 'hostline_auth',
    tenantId: string | null,
    work: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return backend.run(async (client) => {
      await requireSafeLogin(client);
      await client.query('BEGIN');
      let inApplicationWork = false;
      try {
        // Only fixed literals may be interpolated; never accept caller role names.
        await client.query(
          role === 'hostline_app'
            ? 'SET LOCAL ROLE hostline_app'
            : role === 'hostline_worker'
              ? 'SET LOCAL ROLE hostline_worker'
              : 'SET LOCAL ROLE hostline_auth',
        );
        await client.query("SET LOCAL statement_timeout = '5000ms'");
        await client.query("SET LOCAL lock_timeout = '2000ms'");
        await client.query("SELECT set_config('hostline.tenant_id', $1, true)", [tenantId ?? '']);
        await requireSafeRuntimeRoles(client);
        inApplicationWork = true;
        const result = await work(client);
        inApplicationWork = false;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        if (inApplicationWork) throw error;
        safeDatabaseError(error);
      }
    });
  }

  async function withTenant<T>(
    tenantId: string,
    work: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    const validatedId = idSchema.parse(tenantId);
    return transact('hostline_app', validatedId, async (client) => {
      const tx = new Transaction(client, validatedId);
      try {
        return await work(tx);
      } finally {
        tx.finish();
      }
    });
  }

  const auth = createAuthPersistence(
    async (work) => {
      try {
        return await transact('hostline_auth', null, work);
      } catch (error) {
        safeDatabaseError(error);
      }
    },
    () =>
      new PersistenceError(
        'AUTH_CAPACITY_UNAVAILABLE',
        503,
        'Sign-in is temporarily unavailable. Try again later.',
      ),
  );

  async function withAuthenticatedTenant<T>(
    binding: AuthSessionBinding,
    work: (tx: TenantTransaction, session: AuthSession) => Promise<T>,
  ): Promise<T> {
    return transact('hostline_auth', null, async (client) => {
      let session: AuthSession | null;
      try {
        session = await readAuthSession(client, binding);
      } catch (error) {
        safeDatabaseError(error);
      }
      if (!session) throw new PersistenceError('UNAUTHENTICATED', 401, 'Sign in to continue.');
      await client.query('SET LOCAL ROLE hostline_app');
      await requireSafeRuntimeRoles(client);
      await client.query("SELECT set_config('hostline.tenant_id',$1,true)", [session.tenantId]);
      const tx = new Transaction(client, session.tenantId);
      try {
        return await work(tx, session);
      } finally {
        tx.finish();
      }
    });
  }

  async function seedDemo(): Promise<void> {
    if (!backend.embedded)
      throw new PersistenceError(
        'DEMO_REQUIRES_EMBEDDED',
        503,
        'Demo fixtures can only be provisioned into the embedded demo database.',
      );
    for (const seed of demoData()) {
      // Only the embedded synthetic demo provisions registry entries. PostgreSQL
      // tenant provisioning is an explicit operator step with migration identity.
      await backend.run((client) =>
        client.query('INSERT INTO tenant_registry(id) VALUES ($1) ON CONFLICT DO NOTHING', [
          seed.restaurant.id,
        ]),
      );
      await withTenant(seed.restaurant.id, async (tx) => {
        const client = new TransactionClient(tx);
        await client.insertSeedRestaurant(seed.restaurant);
        await tx.lockVoiceAdmission();
        await tx.getPhonePolicy();
        for (const call of seed.calls) if (!(await tx.getCall(call.id))) await tx.insertCall(call);
        for (const item of seed.inbox)
          if (!(await tx.getInbox(item.id))) await tx.insertInbox(item);
      });
      // Only the offline synthetic seed identity may initialize tenant state;
      // runtime app/auth roles cannot insert access rows or memberships.
      await backend.run(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL ROLE hostline_auth_broker');
          await client.query("SELECT set_config('hostline.tenant_id',$1,true)", [
            seed.restaurant.id,
          ]);
          await client.query(
            'INSERT INTO auth_tenant_access(tenant_id,version,enabled,workspace_name) VALUES($1,1,true,$2) ON CONFLICT DO NOTHING',
            [seed.restaurant.id, seed.restaurant.name],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          safeDatabaseError(error);
        }
      });
    }
  }

  async function processJobs(limit = 25): Promise<number> {
    const boundedLimit = z.number().int().min(1).max(100).parse(limit);
    const discovered = await transact('hostline_worker', null, (client) =>
      client.query('SELECT * FROM discover_work($1)', [boundedLimit]),
    );
    const work = discovered.rows.map((row) => workSchema.parse(row));
    let completed = 0;
    for (const item of work) {
      const didComplete = await withTenant(item.tenant_id, async (tx) => {
        if (item.work_kind === 'fulfillment') {
          const inbox = await tx.getInbox(item.resource_id);
          if (!inbox) return false;
          const expired = expireFulfillment(inbox, new Date());
          if (!expired) return false;
          await tx.saveInbox(expired, inbox.version);
          await tx.audit('system:worker', 'fulfillment.lease_expired', inbox.id);
          await tx.enqueue('inbox.updated', inbox.id);
          return true;
        }
        const client = new TransactionClient(tx);
        return client.completeInternalJob(item.resource_id);
      });
      if (didComplete) completed += 1;
    }
    return completed;
  }

  return {
    auth,
    withAuthenticatedTenant,
    withTenant,
    seedDemo,
    processJobs,
    close: () => backend.close(),
    readiness,
    readRecoveryCheckpoint: (installationId) =>
      transact('hostline_app', null, (client) => readRecoveryCheckpoint(client, installationId)),
  };
}

// Internal helpers deliberately stay outside the public transaction interface.
// Runtime APIs cannot issue arbitrary SQL through TenantTransaction.
class TransactionClient {
  private readonly transaction: Transaction;
  constructor(tx: TenantTransaction) {
    if (!(tx instanceof Transaction))
      throw new PersistenceError('INVALID_TRANSACTION', 500, 'Invalid database operation.');
    this.transaction = tx;
  }
  async insertSeedRestaurant(value: Restaurant): Promise<void> {
    const restaurant = restaurantSchema.parse(value);
    await this.transaction.query(
      'INSERT INTO restaurants(tenant_id,version,document) VALUES ($1,$2,$3::jsonb) ON CONFLICT (tenant_id) DO NOTHING',
      [this.transaction.tenantId, restaurant.version, JSON.stringify(restaurant)],
    );
  }
  async completeInternalJob(id: string): Promise<boolean> {
    const event = (
      await this.transaction.query(
        'SELECT o.kind FROM jobs j JOIN outbox o ON (o.tenant_id=j.tenant_id AND o.id=j.outbox_id) WHERE j.tenant_id=$1 AND j.id=$2',
        [this.transaction.tenantId, id],
      )
    ).rows[0];
    if (!event) return false;
    const kind = actionSchema.parse(event['kind']);
    if (!['inbox.created', 'inbox.updated', 'restaurant.updated'].includes(kind)) {
      // Future external-effect jobs cannot silently pass through this internal
      // event handler. They need their own reviewed, idempotent implementation.
      const quarantined = await this.transaction.query(
        "UPDATE jobs SET state='quarantined',lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND (state='pending' OR (state='leased' AND lease_expires_at<=now()))",
        [this.transaction.tenantId, id],
      );
      if (quarantined.rowCount === 1)
        await this.transaction.audit('system:worker', 'job.unsupported_kind', id);
      return false;
    }
    const token = randomUUID();
    const claimed = await this.transaction.query(
      `UPDATE jobs SET state='leased', attempts=attempts+1, lease_token=$3, lease_expires_at=now()+interval '30 seconds'
      WHERE tenant_id=$1 AND id=$2 AND attempts<5 AND
      ((state='pending' AND next_run_at<=now()) OR (state='leased' AND lease_expires_at<=now()))
      RETURNING id,lease_token,attempts`,
      [this.transaction.tenantId, id, token],
    );
    const row = claimed.rows[0];
    if (!row) {
      await this.transaction.query(
        `UPDATE jobs SET state='quarantined',lease_token=NULL,lease_expires_at=NULL
        WHERE tenant_id=$1 AND id=$2 AND attempts>=5 AND (state='pending' OR (state='leased' AND lease_expires_at<=now()))`,
        [this.transaction.tenantId, id],
      );
      return false;
    }
    const job = jobSchema.parse(row);
    // These jobs acknowledge internal outbox events only: no external delivery,
    // reservation, notification, or promise to guests occurs in this worker.
    const completed = await this.transaction.query(
      `UPDATE jobs SET state='complete',completed_at=now(),lease_token=NULL,lease_expires_at=NULL
      WHERE tenant_id=$1 AND id=$2 AND state='leased' AND lease_token=$3 AND lease_expires_at>now()`,
      [this.transaction.tenantId, job.id, job.lease_token],
    );
    return completed.rowCount === 1;
  }
}
