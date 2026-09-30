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
  restaurantSchema,
  voiceCallRecordSchema,
  type CallSession,
  type CallSummary,
  type InboxItem,
  type Restaurant,
  type VoiceCallRecord,
} from '@hostline/contracts';
import { expireFulfillment } from '@hostline/domain';
import { demoData } from './seed.js';

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
  saveRestaurant(value: Restaurant, expectedVersion: number): Promise<void>;
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
  insertVoiceCall(call: VoiceCallRecord): Promise<void>;
  saveVoiceCall(call: VoiceCallRecord, expectedVersion: number): Promise<void>;
  countActiveVoiceCalls(now: Date): Promise<number>;
  lockVoiceAdmission(): Promise<void>;
  getReceipt(key: string): Promise<{ fingerprint: string; result: unknown } | null>;
  putReceipt(key: string, fingerprint: string, result: unknown): Promise<void>;
  audit(actorId: string, action: string, resourceId: string): Promise<void>;
  enqueue(kind: string, resourceId: string): Promise<void>;
}
export interface Database {
  close(): Promise<void>;
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
  async getReceipt(key: string): Promise<{ fingerprint: string; result: unknown } | null> {
    const row = (
      await this.query(
        'SELECT fingerprint,result FROM receipts WHERE tenant_id=$1 AND idempotency_key=$2',
        [this.tenantId, keySchema.parse(key)],
      )
    ).rows[0];
    return row ? receiptSchema.parse(row) : null;
  }
  async putReceipt(key: string, fingerprint: string, result: unknown): Promise<void> {
    await this.query(
      'INSERT INTO receipts (tenant_id,idempotency_key,fingerprint,result) VALUES ($1,$2,$3,$4::jsonb)',
      [
        this.tenantId,
        keySchema.parse(key),
        keySchema.parse(fingerprint),
        JSON.stringify(jsonValueSchema.parse(result)),
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

export async function migrate(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
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

export async function createDatabase(
  options: { url?: string; dataDir?: string } = {},
): Promise<Database> {
  let backend: Backend;
  if (options.url) {
    const pool = new pg.Pool({
      connectionString: options.url,
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

  async function transact<T>(
    role: 'hostline_app' | 'hostline_worker',
    tenantId: string | null,
    work: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return backend.run(async (client) => {
      await client.query('BEGIN');
      let inApplicationWork = false;
      try {
        // Only fixed literals may be interpolated; never accept caller role names.
        await client.query(
          role === 'hostline_app'
            ? 'SET LOCAL ROLE hostline_app'
            : 'SET LOCAL ROLE hostline_worker',
        );
        await client.query("SET LOCAL statement_timeout = '5000ms'");
        await client.query("SET LOCAL lock_timeout = '2000ms'");
        await client.query("SELECT set_config('hostline.tenant_id', $1, true)", [tenantId ?? '']);
        const safety = await client.query(
          "SELECT rolsuper, rolbypassrls, EXISTS (SELECT FROM pg_class WHERE relname IN ('restaurants','calls','inbox','voice_calls','receipts','audit_events','outbox','jobs') AND relowner = pg_roles.oid) AS owns_tables FROM pg_roles WHERE rolname = current_user",
        );
        if (
          safety.rows[0]?.rolsuper !== false ||
          safety.rows[0]?.rolbypassrls !== false ||
          safety.rows[0]?.owns_tables !== false
        )
          throw new PersistenceError(
            'UNSAFE_DATABASE_ROLE',
            503,
            'The database runtime role must enforce tenant isolation.',
          );
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
        for (const call of seed.calls) if (!(await tx.getCall(call.id))) await tx.insertCall(call);
        for (const item of seed.inbox)
          if (!(await tx.getInbox(item.id))) await tx.insertInbox(item);
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

  return { withTenant, seedDemo, processJobs, close: () => backend.close() };
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
