import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { z } from 'zod';
import { postgresConnectionConfig } from './postgres.js';
import {
  PrivacyOperationError,
  readRecoveryCheckpoint,
  type PrivacyOperatorPersistence,
  type PrivacySqlClient,
} from './privacy.js';

export interface PrivacyPersistenceOptions {
  url?: string;
  dataDir?: string;
  caFile?: string;
}

/** Dedicated operator identity; embedded use requires the application stopped. */
export async function createPrivacyPersistence(
  options: PrivacyPersistenceOptions,
): Promise<PrivacyOperatorPersistence> {
  if (Boolean(options.url) === Boolean(options.dataDir))
    throw new PrivacyOperationError('DATABASE_SELECTION');
  let run: <T>(work: (client: PrivacySqlClient) => Promise<T>) => Promise<T>;
  let close: () => Promise<void>;
  let embedded = false;
  if (options.url) {
    const pool = new pg.Pool({
      ...(await postgresConnectionConfig({
        url: options.url,
        ...(options.caFile ? { caFile: options.caFile } : {}),
      })),
      max: 2,
      connectionTimeoutMillis: 5000,
    });
    run = async (work) => {
      const connection = await pool.connect();
      try {
        return await work({
          query: async (text, values) => {
            const result = await connection.query<Record<string, unknown>>(text, values);
            return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
          },
        });
      } finally {
        connection.release();
      }
    };
    close = () => pool.end();
  } else {
    const directory = options.dataDir;
    if (!directory) throw new PrivacyOperationError('DATABASE_SELECTION');
    try {
      await access(join(directory, 'PG_VERSION'));
    } catch {
      throw new PrivacyOperationError('MIGRATIONS_REQUIRED');
    }
    const database = new PGlite(directory);
    await database.waitReady;
    embedded = true;
    let tail = Promise.resolve();
    run = async (work) => {
      const predecessor = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await predecessor;
      try {
        return await work({
          query: async (text, values) => {
            const result = await database.query<Record<string, unknown>>(text, values);
            return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
          },
        });
      } finally {
        release();
      }
    };
    close = async () => {
      await tail;
      await database.close();
    };
  }
  let closed = false;
  async function transaction<T>(
    tenantId: string | null,
    work: (client: PrivacySqlClient) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new PrivacyOperationError('PERSISTENCE_CLOSED');
    try {
      return await run(async (client) => {
        await client.query('BEGIN');
        try {
          if (!embedded) {
            const row = (
              await client.query(
                "SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,pg_has_role(session_user,'hostline_privacy','MEMBER') AS privacy_member,pg_has_role(session_user,'hostline_app','MEMBER') AS app_member,pg_has_role(session_user,'hostline_worker','MEMBER') AS worker_member,pg_has_role(session_user,'hostline_auth_broker','MEMBER') AS broker_member,EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON(n.oid=c.relnamespace) WHERE n.nspname='public' AND c.relkind='r' AND pg_has_role(session_user,c.relowner,'MEMBER')) AS owns_tables FROM pg_roles WHERE rolname=session_user",
              )
            ).rows[0];
            const safe = z
              .object({
                rolsuper: z.literal(false),
                rolbypassrls: z.literal(false),
                rolcreaterole: z.literal(false),
                rolcreatedb: z.literal(false),
                rolreplication: z.literal(false),
                privacy_member: z.literal(true),
                app_member: z.literal(false),
                worker_member: z.literal(false),
                broker_member: z.literal(false),
                owns_tables: z.literal(false),
              })
              .safeParse(row);
            if (!safe.success) throw new PrivacyOperationError('UNSAFE_PRIVACY_IDENTITY');
          }
          const assumed = (
            await client.query(
              "SELECT rolsuper,rolbypassrls,rolcanlogin,rolcreaterole,rolcreatedb,rolreplication,pg_has_role('hostline_privacy','hostline_app','MEMBER') AS app_member,pg_has_role('hostline_privacy','hostline_worker','MEMBER') AS worker_member,pg_has_role('hostline_privacy','hostline_auth_broker','MEMBER') AS broker_member,EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON(n.oid=c.relnamespace) WHERE n.nspname='public' AND c.relkind='r' AND pg_has_role('hostline_privacy',c.relowner,'MEMBER')) AS owns_tables FROM pg_roles WHERE rolname='hostline_privacy'",
            )
          ).rows[0];
          const roleSafe = z
            .object({
              rolsuper: z.literal(false),
              rolbypassrls: z.literal(false),
              rolcanlogin: z.literal(false),
              rolcreaterole: z.literal(false),
              rolcreatedb: z.literal(false),
              rolreplication: z.literal(false),
              app_member: z.literal(false),
              worker_member: z.literal(false),
              broker_member: z.literal(false),
              owns_tables: z.literal(false),
            })
            .safeParse(assumed);
          if (!roleSafe.success) throw new PrivacyOperationError('UNSAFE_PRIVACY_ROLE');
          await client.query('SET LOCAL ROLE hostline_privacy');
          await client.query("SET LOCAL statement_timeout='5000ms'");
          await client.query("SET LOCAL lock_timeout='2000ms'");
          await client.query("SELECT set_config('hostline.tenant_id',$1,true)", [tenantId ?? '']);
          const migration = (
            await client.query('SELECT max(version) AS version FROM schema_migrations')
          ).rows[0];
          if (Number(migration?.version) !== 5)
            throw new PrivacyOperationError('MIGRATIONS_REQUIRED');
          let active = true;
          const scoped: PrivacySqlClient = {
            query: (text, values) => {
              if (!active) return Promise.reject(new PrivacyOperationError('TRANSACTION_ENDED'));
              return client.query(text, values);
            },
          };
          let result: T;
          try {
            result = await work(scoped);
          } finally {
            active = false;
          }
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof PrivacyOperationError) throw error;
      throw new PrivacyOperationError('PERSISTENCE_UNAVAILABLE');
    }
  }
  const persistence: PrivacyOperatorPersistence = {
    withTenant: (tenantId, work) => transaction(z.uuid().parse(tenantId), work),
    withControl: (work) => transaction(null, work),
    readCheckpoint: (installationId) =>
      transaction(null, (client) => readRecoveryCheckpoint(client, installationId)),
    close: async () => {
      if (closed) return;
      closed = true;
      await close();
    },
  };
  try {
    await persistence.withControl(async () => undefined);
  } catch (error) {
    await persistence.close();
    throw error;
  }
  return persistence;
}
