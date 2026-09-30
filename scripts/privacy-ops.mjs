import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createPrivacyPersistence } from '../packages/database/src/privacy-persistence.ts';
import {
  inspectRecoveryReadiness,
  privacyLimits,
  recoveryBindingSchema,
  recoveryManifestSchema,
  replayRecoveryJournal,
  retentionPolicySchema,
  runPrivacyBatch,
  saveRetentionPolicy,
} from '../packages/database/src/privacy.ts';
import {
  createAwsRecoveryAuthority,
  updateAwsRecoveryManifest,
} from '../packages/database/src/aws-recovery.ts';
import {
  loadRecoveryEnvironment,
  verifyRdsDatabaseResource,
} from '../packages/database/src/recovery-runtime.ts';
import {
  quarantineRestoredDatabase,
  restoreQuarantineInputSchema,
} from '../packages/database/src/recovery-operator.ts';

const MAX_INPUT_BYTES = 256 * 1024;
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schemas = {
  inspect: z.object({ tenantId: z.uuid().optional() }).strict(),
  policy: z
    .object({
      tenantId: z.uuid(),
      expectedVersion: version.nullable(),
      policy: retentionPolicySchema,
    })
    .strict(),
  batch: z
    .object({ tenantId: z.uuid(), limit: z.number().int().min(1).max(25).default(25) })
    .strict(),
  replay: z
    .object({
      mode: z.enum(['scheduled', 'restore']).default('scheduled'),
      maxPages: z.number().int().min(1).max(20).default(4),
    })
    .strict(),
  manifest: z
    .object({
      manifest: recoveryManifestSchema,
      expectedManifest: recoveryManifestSchema.nullable(),
      approvalId: z.uuid(),
    })
    .strict(),
  quarantine: restoreQuarantineInputSchema,
};

export const privacyUsage = `Use node --import tsx scripts/privacy-ops.mjs <inspect|policy|batch|replay|manifest|quarantine> --file <approved JSON file> [--quarantined].
inspect: {"tenantId"?:"UUID"}; returns policy/checkpoint/readiness metadata.
policy: {"tenantId":"UUID","expectedVersion":null|integer,"policy":<versioned policy>}; compare-and-set, no default retention.
batch: {"tenantId":"UUID","limit"?:1..25}; caller-content minimization only.
replay: {"mode"?:"scheduled"|"restore","maxPages"?:1..20}; restore requires --quarantined and an independently approved manifest.
manifest: {"manifest":<manifest>,"expectedManifest":null|<exact prior manifest>,"approvalId":"UUID"}; compare-and-set from a separately reviewed file. The approval UUID is a reference, not proof of authorization or completed recovery.
quarantine: {"binding":<fixed binding>,"expectedManifest":<exact externally quarantined manifest>,"confirmedInstallationId":"UUID","approvalId":"UUID"}; requires --quarantined, the old fleet stopped, and DATABASE_MIGRATION_URL. Fences restored database authority; does not authorize recovery or change the external manifest.
Database commands require DATABASE_PRIVACY_URL (quarantine uses DATABASE_MIGRATION_URL), DATABASE_CA_FILE and the complete fixed RECOVERY_* / AWS_REGION configuration. Manifest uses the fixed independent authority only. No URL or credential belongs in the JSON file. Exit 2 means replay or unavailable work remains; it does not authorize reopening access.`;

function usageError() {
  throw new Error('usage');
}

export function parsePrivacyArguments(args) {
  const [command, ...flags] = args;
  if ((command === '--help' || command === 'help') && !flags.length) return { help: true };
  if (!Object.hasOwn(schemas, command)) usageError();
  let filePath;
  let quarantined = false;
  const seen = new Set();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (seen.has(flag)) usageError();
    seen.add(flag);
    if (flag === '--quarantined' && ['replay', 'quarantine'].includes(command)) quarantined = true;
    else if (flag === '--file') {
      const value = flags[++index];
      if (!value || value.startsWith('--')) usageError();
      filePath = value;
    } else usageError();
  }
  if (!filePath) usageError();
  return { command, filePath, quarantined };
}

export async function readPrivacyInput(path) {
  // Reject links, devices, FIFOs and oversized files before reading operator data.
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INPUT_BYTES)
      throw new Error('invalid input');
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead < 1 || bytesRead > MAX_INPUT_BYTES) throw new Error('invalid input');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await file.close();
  }
}

const defaults = {
  createPrivacyPersistence,
  createAwsRecoveryAuthority,
  updateAwsRecoveryManifest,
  verifyRdsDatabaseResource,
  inspectRecoveryReadiness,
  runPrivacyBatch,
  replayRecoveryJournal,
  saveRetentionPolicy,
  quarantineRestoredDatabase,
};

/** Dependency injection supports synthetic checks without contacting an account. */
export async function executePrivacyCommand(command, raw, options = {}) {
  if (!Object.hasOwn(schemas, command)) usageError();
  const input = schemas[command].parse(raw);
  const env = options.env ?? process.env;
  const dependencies = { ...defaults, ...options.dependencies };
  if (command === 'replay' && (input.mode === 'restore') !== Boolean(options.quarantined))
    throw new Error('Restore replay requires the explicit --quarantined flag.');
  if (command === 'quarantine' && !options.quarantined)
    throw new Error('Restore fencing requires the explicit --quarantined flag.');
  const config = loadRecoveryEnvironment(env);
  if (!config) throw new Error('Complete fixed recovery configuration is required.');
  const binding = recoveryBindingSchema.parse({
    installationId: config.installationId,
    epoch: config.epoch,
    databaseResourceId: config.databaseResourceId,
  });
  const authorityOptions = { tableName: config.tableName, region: config.region };
  if (command === 'manifest') {
    if (
      input.manifest.installationId !== binding.installationId ||
      input.manifest.epoch !== binding.epoch ||
      input.manifest.databaseResourceId !== binding.databaseResourceId
    )
      throw new Error('Manifest binding must match the fixed recovery configuration.');
    await dependencies.updateAwsRecoveryManifest({ ...authorityOptions, ...input });
    return {
      output: { applied: true, securityVersion: input.manifest.securityVersion },
      exitCode: 0,
    };
  }

  if (
    command === 'quarantine' &&
    (input.binding.installationId !== binding.installationId ||
      input.binding.epoch !== binding.epoch ||
      input.binding.databaseResourceId !== binding.databaseResourceId)
  )
    throw new Error('Quarantine binding must match the fixed recovery configuration.');
  const databaseUrl =
    env[command === 'quarantine' ? 'DATABASE_MIGRATION_URL' : 'DATABASE_PRIVACY_URL'];
  const caFile = env['DATABASE_CA_FILE'];
  if (!databaseUrl || !caFile)
    throw new Error('The dedicated operator database URL and DATABASE_CA_FILE are required.');
  async function verifyDatabase() {
    const controller = new AbortController();
    let timeout;
    try {
      const verified = await Promise.race([
        dependencies.verifyRdsDatabaseResource(
          {
            databaseUrl,
            databaseInstanceId: config.databaseInstanceId,
            binding,
            region: config.region,
          },
          controller.signal,
        ),
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            controller.abort();
            resolve(false);
          }, privacyLimits.authorityTimeoutMs);
        }),
      ]);
      if (!verified) throw new Error('The actual RDS database binding could not be verified.');
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
    }
  }

  // The factory itself checks role/migration readiness, so verify before opening it.
  await verifyDatabase();
  if (command === 'quarantine') {
    const authority = dependencies.createAwsRecoveryAuthority(authorityOptions);
    await dependencies.quarantineRestoredDatabase({ url: databaseUrl, caFile }, input, authority);
    return { output: { quarantined: true, approvalId: input.approvalId }, exitCode: 0 };
  }
  const database = await dependencies.createPrivacyPersistence({ url: databaseUrl, caFile });
  // Recheck outside SQL locks before every transaction; never let external I/O
  // extend a tenant lock or turn an unverified connection into an operator target.
  const persistence = {
    withTenant: async (tenantId, work) => {
      await verifyDatabase();
      return database.withTenant(tenantId, work);
    },
    withControl: async (work) => {
      await verifyDatabase();
      return database.withControl(work);
    },
    readCheckpoint: async (installationId) => {
      await verifyDatabase();
      return database.readCheckpoint(installationId);
    },
    close: () => database.close(),
  };
  try {
    const authority = dependencies.createAwsRecoveryAuthority(authorityOptions);
    if (command === 'inspect') {
      const checkpoint = await persistence.readCheckpoint(binding.installationId);
      const readiness = await dependencies.inspectRecoveryReadiness({
        binding,
        checkpoint,
        authority,
      });
      const policy = input.tenantId
        ? await persistence.withTenant(input.tenantId, async (client) => {
            const { rows } = await client.query(
              'SELECT document FROM privacy_policies WHERE tenant_id=$1',
              [input.tenantId],
            );
            return rows[0] ? retentionPolicySchema.parse(rows[0].document) : null;
          })
        : undefined;
      return {
        output: { checkpoint, readiness, ...(input.tenantId ? { policy } : {}) },
        exitCode: 0,
      };
    }
    if (command === 'policy') {
      await persistence.withTenant(input.tenantId, (client) =>
        dependencies.saveRetentionPolicy(
          client,
          input.tenantId,
          input.policy,
          input.expectedVersion,
        ),
      );
      return { output: { applied: true, policyVersion: input.policy.version }, exitCode: 0 };
    }
    if (command === 'batch') {
      const output = await dependencies.runPrivacyBatch({
        persistence,
        binding,
        authority,
        tenantId: input.tenantId,
        limit: input.limit,
        now: new Date(),
      });
      return { output, exitCode: output.needsReplay || output.unavailable ? 2 : 0 };
    }
    const output = await dependencies.replayRecoveryJournal({
      persistence,
      binding,
      authority,
      ...input,
      now: new Date(),
    });
    return { output, exitCode: output.complete ? 0 : 2 };
  } finally {
    await persistence.close();
  }
}

async function main() {
  const args = parsePrivacyArguments(process.argv.slice(2));
  if (args.help) {
    console.log(privacyUsage);
    return;
  }
  const result = await executePrivacyCommand(args.command, await readPrivacyInput(args.filePath), {
    quarantined: args.quarantined,
  });
  // Only configuration/counters/checkpoints are emitted, never connection URLs,
  // caller content, raw SQL, credentials or dependency error details.
  console.log(JSON.stringify(result.output, null, 2));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    if (error instanceof Error && error.message === 'usage') console.error(privacyUsage);
    else if (error?.code === 'POLICY_CONFLICT' || error?.code === 'CHECKPOINT_CONFLICT')
      console.error(
        'The operation conflicted with newer evidence. Inspect and review before retrying.',
      );
    else
      console.error(
        'Privacy operation failed. Check approved input, fixed recovery binding, verified RDS identity/TLS, restricted operator permissions, and authority readiness. Sensitive details are omitted.',
      );
    process.exitCode = 1;
  }
}
