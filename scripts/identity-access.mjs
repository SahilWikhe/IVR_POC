import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  inspectIdentityAccess,
  inspectRestaurant,
  provisionIdentityAccess,
  provisionRestaurant,
} from '../packages/database/src/identity-operator.ts';
import {
  identityAccessReferenceSchema,
  provisionIdentityAccessSchema,
  provisionRestaurantSchema,
  restaurantOperatorReferenceSchema,
} from '@hostline/contracts';

const usage =
  'Use node --import tsx scripts/identity-access.mjs <inspect|restaurant-provision|access-provision> --file <JSON file> [--offline-dir <closed synthetic database directory>]. Native operations use DATABASE_MIGRATION_URL and optional DATABASE_CA_FILE from environment secrets.';
const MAX_BYTES = 256 * 1024;

async function readInput(path) {
  // O_NOFOLLOW rejects symlinks on supported Linux execution environments.
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw new Error('invalid input');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > MAX_BYTES) throw new Error('invalid input');
    return JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'));
  } finally {
    await file.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === 'help') {
    console.log(usage);
    return;
  }
  if (!['inspect', 'restaurant-provision', 'access-provision'].includes(command))
    throw new Error('usage');
  let filePath;
  let offlineDir;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--file', '--offline-dir'].includes(flag) || !value || seen.has(flag))
      throw new Error('usage');
    seen.add(flag);
    if (flag === '--file') filePath = value;
    else offlineDir = value;
  }
  if (!filePath) throw new Error('usage');
  const migrationUrl = process.env['DATABASE_MIGRATION_URL'];
  if (offlineDir && migrationUrl)
    throw new Error('Choose exactly one offline directory or migration URL.');
  if (!offlineDir && !migrationUrl)
    throw new Error('DATABASE_MIGRATION_URL is required for a native operator connection.');
  const caFile = process.env['DATABASE_CA_FILE'];
  const options = offlineDir
    ? { dataDir: offlineDir }
    : { url: migrationUrl, ...(caFile ? { caFile } : {}) };
  const raw = await readInput(filePath);
  let result;
  if (command === 'restaurant-provision')
    result = await provisionRestaurant(options, provisionRestaurantSchema.parse(raw));
  else if (command === 'access-provision')
    result = await provisionIdentityAccess(options, provisionIdentityAccessSchema.parse(raw));
  else {
    const identity = identityAccessReferenceSchema.safeParse(raw);
    result = identity.success
      ? await inspectIdentityAccess(options, identity.data)
      : await inspectRestaurant(options, restaurantOperatorReferenceSchema.parse(raw));
  }
  // Inspection returns only approved configuration/access metadata; never echo
  // input issuer/subject, credentials, tokens, caller content or SQL errors.
  if (command === 'inspect') console.log(JSON.stringify(result, null, 2));
  else
    console.log(
      JSON.stringify(
        {
          applied: true,
          identityVersion: result.identity?.version ?? null,
          membershipVersion: result.membership?.version ?? null,
          tenantVersion: result.tenant?.version ?? result.tenantAccess?.version ?? null,
          restaurantVersion: result.restaurant?.version ?? null,
        },
        null,
        2,
      ),
    );
}

try {
  await main();
} catch (error) {
  if (error instanceof Error && error.message === 'usage') console.error(usage);
  else if (error && typeof error === 'object' && 'code' in error && error.code === 'CONFLICT')
    console.error(
      'The operation conflicted with a newer version. Inspect current access and retry the intended change.',
    );
  else
    console.error(
      'Identity operation failed. Check structured input, database readiness, operator permissions, and connectivity. Sensitive details are omitted.',
    );
  process.exitCode = 1;
}
