import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  identityAccessReferenceSchema,
  identityAccessSnapshotSchema,
  provisionIdentityAccessSchema,
  restaurantOperatorReferenceSchema,
  restaurantOperatorSnapshotSchema,
  provisionRestaurantSchema,
  type RestaurantOperatorReference,
  type RestaurantOperatorSnapshot,
  type ProvisionRestaurant,
  type IdentityAccessReference,
  type IdentityAccessSnapshot,
  type ProvisionIdentityAccess,
} from '@hostline/contracts';
import { postgresConnectionConfig } from './postgres.js';
import type { IdentitySqlClient } from './identity.js';

export interface IdentityOperatorOptions {
  url?: string;
  dataDir?: string;
  caFile?: string;
}

/** Explicit offline/migration-identity operation; never called by API startup. */
async function operatorTransaction<T>(
  options: IdentityOperatorOptions,
  work: (client: IdentitySqlClient) => Promise<T>,
  authority: 'auth' | 'migration' = 'auth',
): Promise<T> {
  if (Boolean(options.url) === Boolean(options.dataDir))
    throw new Error('Select exactly one migration URL or an offline embedded database directory.');
  let close: () => Promise<void>;
  let client: IdentitySqlClient;
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
      throw new Error('Identity operator could not connect to its database.');
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
    // Do not create an empty database or run migrations as an incidental access edit.
    const directory = options.dataDir;
    if (!directory) throw new Error('An offline database directory is required.');
    await access(directory);
    const embedded = new PGlite(directory);
    await embedded.waitReady;
    close = () => embedded.close();
    client = {
      query: async (text, values) => {
        const result = await embedded.query<Record<string, unknown>>(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
    };
  }
  try {
    await client.query('BEGIN');
    if (authority === 'auth') await client.query('SET LOCAL ROLE hostline_auth_broker');
    else {
      const privilege = (
        await client.query(
          "SELECT pg_has_role(session_user,relowner,'MEMBER') AS migration_owner FROM pg_class WHERE oid='public.restaurants'::regclass",
        )
      ).rows[0];
      if (privilege?.['migration_owner'] !== true)
        throw new IdentityProvisioningError(
          'OPERATOR_UNAVAILABLE',
          'Restaurant provisioning requires the dedicated migration identity.',
        );
    }
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query("SET LOCAL lock_timeout='2000ms'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof IdentityProvisioningError) throw error;
    throw new IdentityProvisioningError(
      'OPERATOR_UNAVAILABLE',
      'The identity operation could not complete. Check the migration identity and try again.',
    );
  } finally {
    await close();
  }
}
export class IdentityProvisioningError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityProvisioningError';
  }
}
async function snapshot(
  client: IdentitySqlClient,
  ref: IdentityAccessReference,
): Promise<IdentityAccessSnapshot> {
  const identity =
    (
      await client.query(
        'SELECT id,version,display_name AS "displayName",enabled FROM auth_identities WHERE issuer=$1 AND subject=$2',
        [ref.issuer, ref.subject],
      )
    ).rows[0] ?? null;
  await client.query("SELECT set_config('hostline.tenant_id',$1,true)", [ref.tenantId]);
  const tenant =
    (
      await client.query(
        'SELECT version,enabled,workspace_name AS "workspaceName" FROM auth_tenant_access WHERE tenant_id=$1',
        [ref.tenantId],
      )
    ).rows[0] ?? null;
  const membership = identity
    ? ((
        await client.query(
          'SELECT version,role,enabled FROM auth_memberships WHERE tenant_id=$1 AND identity_id=$2',
          [ref.tenantId, identity['id']],
        )
      ).rows[0] ?? null)
    : null;
  return identityAccessSnapshotSchema.parse({ identity, tenant, membership });
}
export function inspectIdentityAccess(
  options: IdentityOperatorOptions,
  input: IdentityAccessReference,
): Promise<IdentityAccessSnapshot> {
  const ref = identityAccessReferenceSchema.parse(input);
  return operatorTransaction(options, (client) => snapshot(client, ref));
}
export async function provisionIdentityAccess(
  options: IdentityOperatorOptions,
  input: ProvisionIdentityAccess,
): Promise<IdentityAccessSnapshot> {
  const value = provisionIdentityAccessSchema.parse(input);
  return operatorTransaction(options, async (client) => {
    // Serialize first creation by verified issuer/subject before choosing its ID.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('auth_subject:'||$1||':'||$2,0))",
      [value.issuer, value.subject],
    );
    const priorIdentity = (
      await client.query('SELECT id FROM auth_identities WHERE issuer=$1 AND subject=$2', [
        value.issuer,
        value.subject,
      ])
    ).rows[0];
    const identityId = priorIdentity?.['id'] ?? randomUUID();
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('auth_identity:'||$1,0))", [
      identityId,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('auth_tenant:'||$1,0))", [
      value.tenantId,
    ]);
    const old = await snapshot(client, value);
    if (
      (old.identity?.version ?? null) !== value.expectedIdentityVersion ||
      (old.membership?.version ?? null) !== value.expectedMembershipVersion ||
      (old.tenant?.version ?? null) !== value.expectedTenantVersion
    ) {
      throw new IdentityProvisioningError(
        'CONFLICT',
        'Access changed. Inspect the current versions and retry the intended update.',
      );
    }
    const identityVersion = (old.identity?.version ?? 0) + 1;
    const tenantVersion = (old.tenant?.version ?? 0) + 1;
    const membershipVersion = (old.membership?.version ?? 0) + 1;
    await client.query(
      'INSERT INTO auth_identities(id,issuer,subject,display_name,version,enabled) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(issuer,subject) DO UPDATE SET display_name=excluded.display_name,version=excluded.version,enabled=excluded.enabled',
      [
        identityId,
        value.issuer,
        value.subject,
        value.displayName,
        identityVersion,
        value.identityEnabled,
      ],
    );
    await client.query(
      'INSERT INTO auth_tenant_access(tenant_id,version,enabled,workspace_name) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,workspace_name=excluded.workspace_name',
      [value.tenantId, tenantVersion, value.tenantEnabled, value.workspaceName],
    );
    await client.query(
      'INSERT INTO auth_memberships(tenant_id,identity_id,version,enabled,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,identity_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,role=excluded.role',
      [value.tenantId, identityId, membershipVersion, value.membershipEnabled, value.role],
    );
    await client.query(
      'INSERT INTO auth_membership_routes(identity_id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [identityId, value.tenantId],
    );
    await client.query(
      'INSERT INTO auth_operator_events(tenant_id,id,identity_id,identity_version,membership_version,tenant_version) VALUES($1,$2,$3,$4,$5,$6)',
      [value.tenantId, randomUUID(), identityId, identityVersion, membershipVersion, tenantVersion],
    );
    return snapshot(client, value);
  });
}

async function restaurantSnapshot(
  client: IdentitySqlClient,
  ref: RestaurantOperatorReference,
  lock: boolean = false,
): Promise<RestaurantOperatorSnapshot> {
  await client.query("SELECT set_config('hostline.tenant_id',$1,true)", [ref.tenantId]);
  const restaurant =
    (
      await client.query(
        lock
          ? 'SELECT document FROM restaurants WHERE tenant_id=$1 FOR UPDATE'
          : 'SELECT document FROM restaurants WHERE tenant_id=$1',
        [ref.tenantId],
      )
    ).rows[0]?.['document'] ?? null;
  const tenantAccess =
    (
      await client.query(
        lock
          ? 'SELECT version,enabled,workspace_name AS "workspaceName" FROM auth_tenant_access WHERE tenant_id=$1 FOR UPDATE'
          : 'SELECT version,enabled,workspace_name AS "workspaceName" FROM auth_tenant_access WHERE tenant_id=$1',
        [ref.tenantId],
      )
    ).rows[0] ?? null;
  return restaurantOperatorSnapshotSchema.parse({ restaurant, tenantAccess });
}
export function inspectRestaurant(
  options: IdentityOperatorOptions,
  input: RestaurantOperatorReference,
): Promise<RestaurantOperatorSnapshot> {
  const ref = restaurantOperatorReferenceSchema.parse(input);
  return operatorTransaction(options, (client) => restaurantSnapshot(client, ref), 'migration');
}
/** Creates only a restaurant/configuration and its explicitly selected access status. */
export function provisionRestaurant(
  options: IdentityOperatorOptions,
  input: ProvisionRestaurant,
): Promise<RestaurantOperatorSnapshot> {
  const value = provisionRestaurantSchema.parse(input);
  return operatorTransaction(
    options,
    async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('auth_tenant:'||$1,0))", [
        value.restaurant.id,
      ]);
      const old = await restaurantSnapshot(client, { tenantId: value.restaurant.id }, true);
      if (
        (old.restaurant?.version ?? null) !== value.expectedRestaurantVersion ||
        (old.tenantAccess?.version ?? null) !== value.expectedTenantVersion ||
        value.restaurant.version !== (value.expectedRestaurantVersion ?? 0) + 1
      )
        throw new IdentityProvisioningError(
          'CONFLICT',
          'Restaurant access changed. Inspect the current versions and retry the intended update.',
        );
      await client.query('INSERT INTO tenant_registry(id) VALUES($1) ON CONFLICT DO NOTHING', [
        value.restaurant.id,
      ]);
      await client.query(
        'INSERT INTO restaurants(tenant_id,version,document) VALUES($1,$2,$3::jsonb) ON CONFLICT(tenant_id) DO UPDATE SET version=excluded.version,document=excluded.document',
        [value.restaurant.id, value.restaurant.version, JSON.stringify(value.restaurant)],
      );
      const tenantVersion = (old.tenantAccess?.version ?? 0) + 1;
      await client.query(
        'INSERT INTO auth_tenant_access(tenant_id,version,enabled,workspace_name) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,workspace_name=excluded.workspace_name',
        [value.restaurant.id, tenantVersion, value.tenantEnabled, value.restaurant.name],
      );
      await client.query(
        "INSERT INTO auth_operator_events(tenant_id,id,action,tenant_version,restaurant_version) VALUES($1,$2,'restaurant.provisioned',$3,$4)",
        [value.restaurant.id, randomUUID(), tenantVersion, value.restaurant.version],
      );
      return restaurantSnapshot(client, { tenantId: value.restaurant.id });
    },
    'migration',
  );
}
