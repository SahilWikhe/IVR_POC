import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { z } from 'zod';
import { validatedPostgresUrl } from './postgres.js';
import type { Database } from './index.js';
import { createAwsRecoveryAuthority } from './aws-recovery.js';
import {
  inspectRecoveryReadiness,
  recoveryBindingSchema,
  type RecoveryAuthority,
  type RecoveryBinding,
} from './privacy.js';

const environmentSchema = recoveryBindingSchema.extend({
  tableName: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  databaseInstanceId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/),
});
export type RecoveryEnvironment = z.infer<typeof environmentSchema>;
export function loadRecoveryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RecoveryEnvironment | null {
  const values = {
    installationId: env['RECOVERY_INSTALLATION_ID'],
    epoch: env['RECOVERY_EPOCH'],
    databaseResourceId: env['RECOVERY_DATABASE_RESOURCE_ID'],
    tableName: env['RECOVERY_TABLE_NAME'],
    region: env['AWS_REGION'],
    databaseInstanceId: env['RECOVERY_DATABASE_INSTANCE_ID'],
  };
  if (
    Object.entries(values)
      .filter(([key]) => key !== 'region')
      .every(([, value]) => value === undefined)
  )
    return null;
  const parsed = environmentSchema.safeParse(values);
  if (!parsed.success)
    throw new Error(
      'Recovery requires the complete documented installation, database, and AWS configuration.',
    );
  return parsed.data;
}

export async function verifyRdsDatabaseResource(
  input: {
    databaseUrl: string;
    databaseInstanceId: string;
    binding: RecoveryBinding;
    region: string;
    describe?: (command: DescribeDBInstancesCommand, signal: AbortSignal) => Promise<unknown>;
  },
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const url = validatedPostgresUrl(input.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) return false;
    if ([...url.searchParams.keys()].some((key) => !['application_name', 'sslmode'].includes(key)))
      return false;
    const sslModes = url.searchParams.getAll('sslmode');
    if (sslModes.length > 1 || (sslModes.length === 1 && sslModes[0] !== 'verify-full'))
      return false;
    const client = input.describe
      ? null
      : new RDSClient({ region: input.region, maxAttempts: 1, ignoreConfiguredEndpointUrls: true });
    const command = new DescribeDBInstancesCommand({
      DBInstanceIdentifier: input.databaseInstanceId,
    });
    const output = input.describe
      ? await input.describe(command, signal)
      : await client!.send(command, { abortSignal: signal });
    const result = z
      .object({
        DBInstances: z
          .array(
            z.object({
              DBInstanceIdentifier: z.string(),
              DbiResourceId: z.string(),
              DBInstanceStatus: z.literal('available'),
              Endpoint: z.object({ Address: z.string(), Port: z.number().int() }),
            }),
          )
          .length(1),
      })
      .safeParse(output);
    return Boolean(
      result.success &&
      result.data.DBInstances[0] &&
      result.data.DBInstances[0].DBInstanceIdentifier === input.databaseInstanceId &&
      result.data.DBInstances[0].DbiResourceId === input.binding.databaseResourceId &&
      result.data.DBInstances[0].Endpoint.Address.toLowerCase() === url.hostname.toLowerCase() &&
      result.data.DBInstances[0].Endpoint.Port === Number(url.port || '5432'),
    );
  } catch {
    return false;
  }
}

/** No environment setting can bypass the independent authority for a native runtime. */
export function createRuntimeRecoveryGuard(
  db: Pick<Database, 'readRecoveryCheckpoint'>,
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<boolean> {
  const config = loadRecoveryEnvironment(env),
    databaseUrl = env['DATABASE_URL'];
  if (!config || !databaseUrl || !env['DATABASE_CA_FILE']) return async () => false;
  const binding = recoveryBindingSchema.parse({
    installationId: config.installationId,
    epoch: config.epoch,
    databaseResourceId: config.databaseResourceId,
  });
  const authority = createAwsRecoveryAuthority({
    tableName: config.tableName,
    region: config.region,
  });
  const client = new RDSClient({
    region: config.region,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
  });
  return createRecoveryGuard({
    db,
    binding,
    authority,
    verifyDatabase: (signal) =>
      verifyRdsDatabaseResource(
        {
          databaseUrl,
          databaseInstanceId: config.databaseInstanceId,
          binding,
          region: config.region,
          describe: (command, abortSignal) => client.send(command, { abortSignal }),
        },
        signal,
      ),
  });
}

export function createRecoveryGuard(input: {
  db: Pick<Database, 'readRecoveryCheckpoint'>;
  binding: RecoveryBinding;
  authority: RecoveryAuthority;
  verifyDatabase: (signal: AbortSignal) => Promise<boolean>;
}): () => Promise<boolean> {
  const binding = recoveryBindingSchema.parse(input.binding);
  return async () => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = async () => {
        const [checkpoint, verified] = await Promise.all([
          input.db.readRecoveryCheckpoint(binding.installationId),
          input.verifyDatabase(controller.signal),
        ]);
        if (!verified) return false;
        return (await inspectRecoveryReadiness({ binding, checkpoint, authority: input.authority }))
          .ready;
      };
      return await Promise.race([
        work(),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => {
            controller.abort();
            resolve(false);
          }, 3000);
          timeout.unref();
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}
