# Restaurant and identity operations

The operator tool explicitly provisions restaurant configuration and issuer/subject memberships. API startup does not create staff access, load `OIDC_MEMBERSHIPS`, or restore revoked memberships. Restaurant owners do not currently invite users or alter account access through the dashboard. Account administration stays with an accountable operator for this pilot.

The CLI is `node --import tsx scripts/identity-access.mjs`. It uses the repository's existing `tsx` loader because Node's standalone type stripping does not resolve this project's `.js` source import specifiers to TypeScript files. No Auth0 Management API credential is used by this tool. Hostline trusts only identities verified through its configured OIDC flow; an operator must obtain the exact provider subject from an authorized Auth0 account-management process.

## Database identities and migration prerequisites

Run `pnpm db:migrate` with `DATABASE_MIGRATION_URL` and a dedicated migration identity before provisioning. The migrator needs the existing protected-table ownership/constraints, `CREATEROLE` or an equivalent approved bootstrap, ownership of the target schema or appropriate grant options, and administration rights for existing fixed roles when reusing a PostgreSQL cluster. Migration 004 creates auth roles and transfers auth function ownership to the broker; a nonsuperuser migrator must be able to grant schema privileges and transfer those functions. Verify these rights explicitly on the target server.

The API/worker native runtime login may assume `hostline_app`, `hostline_worker`, and `hostline_auth`. It must be `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`, must not own protected tables directly or through inherited role membership, and must not be able to assume the migrator or `hostline_auth_broker`. Fixed runtime groups and the broker are `NOLOGIN`, nonsuperuser, non-bypass, and non-owner. The auth broker has auth-metadata privileges only and cannot read restaurant caller records. Runtime role and original login checks reject unsafe compositions. Readiness checks schema version and these role boundaries; they are not a substitute for external database/TLS recovery acceptance.

The narrow `hostline_auth` role executes auth functions and can read non-sensitive migration-version metadata. Membership and tenant-access tables enforce FORCE RLS. Authentication discovers opaque routing references, enters the corresponding tenant scope, and rechecks enabled flags and current versions before issuing or reading sessions. Runtime app code cannot provision identities, memberships, or tenant access. The scoped tenant-access read function takes a shared row lock without granting runtime access-policy updates.

Supply `DATABASE_CA_FILE` for a trusted native TLS CA bundle. The database adapter validates certificates and hostnames. Connection URLs require an explicit host and database name, and default an omitted port to 5432 instead of using `PGPORT`. Query parameters are limited to one `application_name` and one `sslmode`; endpoint, credential, `options`, duplicate, and case-variant overrides are rejected. URL flags `ssl`, `sslcert`, `sslkey`, `sslrootcert`, and `sslnegotiation` are rejected; only a single `sslmode=verify-full` is accepted and removed before explicit trusted TLS settings reach `pg`. Do not put a migration connection or certificate override into the API deployment. The API receives its separate restricted `DATABASE_URL`.

## Input and command boundaries

Commands take a regular JSON file, reject symlinks on the supported Linux environment, enforce a 256 KiB maximum, and validate strict schemas. Keep files with staff metadata and configuration in a private operator directory. Do not include client secrets, passwords, session tokens, or caller records. The tool reads its migration connection and optional CA-file path from environment secrets; it never accepts a connection URL as a CLI argument or echoes credentials.

```bash
node --import tsx scripts/identity-access.mjs inspect --file /tmp/private-ops/reference.json
node --import tsx scripts/identity-access.mjs restaurant-provision --file /tmp/private-ops/restaurant.json
node --import tsx scripts/identity-access.mjs access-provision --file /tmp/private-ops/access.json
```

`inspect` accepts either `{ "tenantId": "UUID" }` for restaurant configuration or an identity reference `{ "issuer": "https://YOUR_TENANT.auth0.com/", "subject": "EXACT_VERIFIED_SUBJECT", "tenantId": "UUID" }`. It returns approved configuration/access metadata and versions. Provisioning returns version identifiers without repeating input issuer/subject or configuration. Errors omit raw SQL and connection details. Inspect the desired database and current versions before writing; a stale version fails atomically and requires a fresh inspection.

For an embedded synthetic database, stop the API and all processes using that directory, omit `DATABASE_MIGRATION_URL`, and add `--offline-dir /absolute/path/to/database`. Embedded operator access is strictly an offline development fixture operation, not a shared-session deployment. Native operations use the migration identity. Do not open the same PGlite directory from multiple processes.

## Provision a restaurant

Prepare the complete, schema-valid restaurant object from the [contracts](../packages/contracts/src/base.ts), with reviewed business hours/timezone, approved FAQs/menu, reservation-request wording, contact settings, and safe transfer destinations. Restaurant IDs are UUIDs; new restaurant configuration starts at version 1. This operation does not provision a number, change forwarding, enable a provider, create staff users, or insert sample caller records.

The JSON input is:

```json
{
  "restaurant": "REPLACE WITH THE COMPLETE RESTAURANT OBJECT",
  "tenantEnabled": false,
  "expectedRestaurantVersion": null,
  "expectedTenantVersion": null
}
```

The string shown for `restaurant` is explanatory and is rejected by the real schema. Replace it with the complete object. For creation, both expected versions are null; for updates, supply the values from `inspect` and set `restaurant.version` to the current restaurant version plus one. `tenantEnabled` is explicit. Starting suspended lets an operator prepare configuration and memberships before allowing staff access or new phone work.

The transaction creates the opaque registry entry, approved restaurant configuration, and access policy together. It takes the tenant authorization lock and optimistic version checks. Updates preserve caller records and existing memberships. Tenant-access version advances on every applied restaurant update, invalidating older sessions even if access is reenabled. The access policy blocks new staff work and newly authorized voice work when suspended; already admitted work and verified provider outcome callbacks need their documented recovery handling.

## Provision an exact identity membership

First create/invite the intended Auth0 staff account using approved account administration. Inspect its exact stable subject and issuer. Email/name similarity is not proof that an account belongs to a restaurant. Check that the target restaurant exists and use `inspect` to obtain the current identity, membership, and tenant versions.

A first membership input has this structure:

```json
{
  "issuer": "https://YOUR_TENANT.auth0.com/",
  "subject": "EXACT_VERIFIED_SUBJECT",
  "tenantId": "10000000-0000-4000-8000-000000000001",
  "displayName": "Pilot Staff",
  "workspaceName": "Pilot Restaurant",
  "role": "staff",
  "identityEnabled": true,
  "membershipEnabled": true,
  "tenantEnabled": false,
  "expectedIdentityVersion": null,
  "expectedMembershipVersion": null,
  "expectedTenantVersion": 1
}
```

Use the actual inspected tenant version, not the example number. Expected identity/membership versions are null only when those records do not exist. Existing identities can have memberships in more than one restaurant at the storage level, but the current login flow requires exactly one active membership; a workspace selector is not implemented. Roles are `owner`, `staff`, and `viewer`. Viewer access is limited to the current application permission boundary; private caller detail access remains role restricted.

Provisioning uses issuer/subject serialization, identity-then-tenant authorization locks, composite foreign keys, and CAS checks for all three versions. It updates only explicit metadata and membership; no startup process reruns it. Every application advances identity, membership, and tenant versions conservatively, invalidating existing sessions for that identity and restaurant. Repeating an old JSON file fails rather than silently restoring a disabled account. Do not treat the command as an idempotent startup seed.

The operator audit records the original database `session_user` migration login, affected opaque IDs, applied versions, and timestamp. This identifies the database workload that performed the change. Correlate it with the restricted deployment/operator audit trail to establish which human approved a shared migration identity's action; the database username alone is not human attribution.

## Suspend, revoke, and reenable

To remove one membership, inspect current versions and apply `membershipEnabled=false`. To suspend the identity across restaurants, apply `identityEnabled=false`. To suspend all access/new work for a restaurant, apply `tenantEnabled=false`. Select the other flags deliberately because this tool writes the full approved state. Coordinate Auth0 account disablement with Hostline access suspension; no automatic Auth0 management-event synchronization is implemented.

Current-version checks cause older sessions to fail. Reenablement requires a fresh inspected version and a new login; old sessions never become valid again. Logout removes the current hashed session. Claimed login cancellation prevents a delayed callback from creating a replacement session; if issuance wins first, cancellation revokes the already issued session before a delayed cookie can restore authority.

Staff business transactions hold shared identity, tenant, membership, and session authorization locks. A revoke/suspend operation waits for an admitted transaction to finish, then prevents later work. Do not claim it cancels an already admitted action or provider update. Native PostgreSQL conformance tests cover cross-connection ordering; external provider recovery remains separate.

## Storage lifetime and recovery

Only SHA-256 hashes of random session/login locators are stored. Pending OIDC state, nonce, and PKCE verifier are AES-GCM encrypted with a separate secret and issuer/client/callback-bound associated data; claiming clears the encrypted payload. Login attempts authorize for five minutes. Sessions have eight-hour absolute and thirty-minute idle limits; validated activity refreshes idle expiry but never the absolute limit.

Expiry checks run on use. Creation prunes at most 100 expired records per operation; no independent periodic physical auth-record deletion loop is currently implemented. Storage caps are 1,000 login attempts per issuer/client, 10,000 globally, 50 sessions per identity, and 100,000 globally. These are conservative availability bounds, not a promise to physically erase every expired row at the instant its authorization expires. Handle restored credentials, sessions, tombstones, and caller deletion through the separate [privacy/recovery procedure](PRIVACY_OPERATIONS.md).

Tests verify PGlite persistence and isolation, actual signed OIDC token validation, and native PostgreSQL replica/session/lock behavior. The real Auth0 tenant, AWS identity/TLS configuration, backups, human recovery process, and production rollout require their own acceptance evidence. See [Auth0 setup](AUTH0_SETUP.md) and [implementation status](IMPLEMENTATION_STATUS.md).
