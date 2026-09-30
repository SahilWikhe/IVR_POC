import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PrivacyOperatorPersistence,
  PrivacySqlClient,
  RecoveryBinding,
  RecoveryCheckpoint,
  RecoveryManifest,
} from '../packages/database/src/privacy.js';

interface OperatorCli {
  parsePrivacyArguments(args: string[]): unknown;
  readPrivacyInput(path: string): Promise<unknown>;
  executePrivacyCommand(
    command: string,
    input: unknown,
    options: {
      env: NodeJS.ProcessEnv;
      quarantined?: boolean;
      dependencies?: Record<string, unknown>;
    },
  ): Promise<{ output: Record<string, unknown>; exitCode: number }>;
}
// Importing the guarded JavaScript entry exposes its real operator boundaries;
// it does not start the command or acquire cloud/database credentials.
const entryUrl = new URL('../scripts/privacy-ops.mjs', import.meta.url);
const cli = (await import(entryUrl.href)) as OperatorCli;
const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const binding: RecoveryBinding = {
  installationId: 'd455e906-8ecb-4ac0-b53c-e6b169c1e281',
  epoch: 'a6749710-5841-40ca-a5f4-5ee23ce2b656',
  databaseResourceId: 'db-synthetic-resource',
};
const tenantId = 'dd792034-f69b-449e-b7db-bd2417c64f14';
const approvalId = 'bec0a8b6-551d-4d99-a79f-d8bbff2d31eb';
const manifest: RecoveryManifest = {
  ...binding,
  securityVersion: 1,
  securityReauthorized: true,
  coverageComplete: true,
  coverageStartSequence: 1,
  throughSequence: 0,
  replaySources: [{ epoch: binding.epoch, databaseResourceId: binding.databaseResourceId }],
};
const checkpoint: RecoveryCheckpoint = {
  ...binding,
  securityVersion: manifest.securityVersion,
  appliedThroughSequence: 0,
};
const env: NodeJS.ProcessEnv = {
  RECOVERY_INSTALLATION_ID: binding.installationId,
  RECOVERY_EPOCH: binding.epoch,
  RECOVERY_DATABASE_RESOURCE_ID: binding.databaseResourceId,
  RECOVERY_TABLE_NAME: 'synthetic-recovery-authority',
  RECOVERY_DATABASE_INSTANCE_ID: 'synthetic-database',
  AWS_REGION: 'us-east-1',
  DATABASE_PRIVACY_URL: 'postgresql://privacy:synthetic@rds.example.test/hostline',
  DATABASE_MIGRATION_URL: 'postgresql://migration:synthetic@rds.example.test/hostline',
  DATABASE_CA_FILE: '/synthetic/rds-ca.pem',
};

function fakeOperator() {
  let activeTransaction = false;
  const calls: string[] = [];
  const client: PrivacySqlClient = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  async function transaction<T>(work: (sql: PrivacySqlClient) => Promise<T>): Promise<T> {
    calls.push('transaction');
    activeTransaction = true;
    try {
      return await work(client);
    } finally {
      activeTransaction = false;
    }
  }
  const persistence: PrivacyOperatorPersistence = {
    withTenant: (_tenantId, work) => transaction(work),
    withControl: (work) => transaction(work),
    readCheckpoint: async () => transaction(async () => checkpoint),
    close: async () => {
      calls.push('close');
    },
  };
  const verify = vi.fn(async () => {
    expect(activeTransaction).toBe(false);
    calls.push('verify');
    return true;
  });
  const create = vi.fn(async () => {
    calls.push('create');
    return persistence;
  });
  const authority = { getManifest: async () => manifest };
  return {
    calls,
    verify,
    create,
    dependencies: {
      verifyRdsDatabaseResource: verify,
      createPrivacyPersistence: create,
      createAwsRecoveryAuthority: () => authority,
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('privacy operator command boundaries', () => {
  it('rejects ambiguous arguments and unbounded or incomplete input before touching dependencies', async () => {
    expect(cli.parsePrivacyArguments(['--help'])).toEqual({ help: true });
    for (const args of [
      ['batch', '--file', 'one', '--file', 'two'],
      ['inspect', '--file', 'one', '--quarantined'],
      ['batch', '--file'],
      ['batch', '--endpoint', 'https://example.test', '--file', 'one'],
    ])
      expect(() => cli.parsePrivacyArguments(args)).toThrow();
    const fake = fakeOperator();
    for (const [command, input] of [
      ['batch', { tenantId, limit: 26 }],
      ['batch', { tenantId, limit: 1, databaseUrl: env.DATABASE_PRIVACY_URL }],
      ['replay', { maxPages: 21 }],
      ['policy', { tenantId, policy: { enabled: false, version: 1, policyId: approvalId } }],
      ['manifest', { manifest, approvalId }],
    ] as const)
      await expect(
        cli.executePrivacyCommand(command, input, { env, dependencies: fake.dependencies }),
      ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  it('reads bounded regular JSON and rejects symlinks, directories, FIFOs and oversized files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hostline-privacy-cli-'));
    temporaryDirectories.push(directory);
    const regular = join(directory, 'approved.json');
    await writeFile(regular, JSON.stringify({ tenantId }));
    expect(await cli.readPrivacyInput(regular)).toEqual({ tenantId });
    const link = join(directory, 'link.json');
    await symlink(regular, link);
    const oversized = join(directory, 'oversized.json');
    await writeFile(oversized, ' '.repeat(256 * 1024 + 1));
    const empty = join(directory, 'empty.json');
    await writeFile(empty, '');
    const subdirectory = join(directory, 'not-a-file');
    await mkdir(subdirectory);
    for (const path of [link, oversized, empty, subdirectory])
      await expect(cli.readPrivacyInput(path)).rejects.toThrow();
    if (process.platform === 'linux') {
      const fifo = join(directory, 'pipe');
      await execute('mkfifo', [fifo]);
      await expect(cli.readPrivacyInput(fifo)).rejects.toThrow();
    }
  });

  it('opens no database on failed RDS verification and closes after a later verification fails', async () => {
    const fake = fakeOperator();
    fake.verify.mockResolvedValueOnce(false);
    await expect(
      cli.executePrivacyCommand('inspect', {}, { env, dependencies: fake.dependencies }),
    ).rejects.toThrow();
    expect(fake.create).not.toHaveBeenCalled();
    fake.calls.length = 0;
    fake.verify
      .mockImplementationOnce(async () => {
        fake.calls.push('verify');
        return true;
      })
      .mockImplementationOnce(async () => {
        fake.calls.push('verify');
        return false;
      });
    await expect(
      cli.executePrivacyCommand('inspect', {}, { env, dependencies: fake.dependencies }),
    ).rejects.toThrow();
    expect(fake.calls).toEqual(['verify', 'create', 'verify', 'close']);
  });

  it('passes the approved expected policy version unchanged inside one scoped transaction', async () => {
    const fake = fakeOperator();
    const save = vi.fn(async () => undefined);
    const policy = { enabled: false, version: 4, policyId: approvalId };
    const result = await cli.executePrivacyCommand(
      'policy',
      { tenantId, expectedVersion: 3, policy },
      { env, dependencies: { ...fake.dependencies, saveRetentionPolicy: save } },
    );
    expect(save).toHaveBeenCalledWith(expect.any(Object), tenantId, policy, 3);
    expect(result.output).toEqual({ applied: true, policyVersion: 4 });
    expect(fake.calls).toEqual(['verify', 'create', 'verify', 'transaction', 'close']);
  });

  it('rechecks the actual resource outside each transaction and reports required replay', async () => {
    const fake = fakeOperator();
    const batch = vi.fn(
      async (input: { persistence: PrivacyOperatorPersistence; limit: number }) => {
        expect(input.limit).toBe(25);
        await input.persistence.withTenant(tenantId, async () => undefined);
        await input.persistence.readCheckpoint(binding.installationId);
        await input.persistence.withControl(async () => undefined);
        return { planned: 1, minimized: 1, held: 0, unavailable: 0, needsReplay: true };
      },
    );
    const result = await cli.executePrivacyCommand(
      'batch',
      { tenantId },
      { env, dependencies: { ...fake.dependencies, runPrivacyBatch: batch } },
    );
    expect(result.exitCode).toBe(2);
    expect(result.output.needsReplay).toBe(true);
    expect(fake.calls).toEqual([
      'verify',
      'create',
      'verify',
      'transaction',
      'verify',
      'transaction',
      'verify',
      'transaction',
      'close',
    ]);
  });

  it('requires explicit quarantined restore and preserves partial replay status', async () => {
    const fake = fakeOperator();
    const replay = vi.fn(async () => ({
      replayed: 25,
      throughSequence: 25,
      complete: false,
      checkpoint: { ...checkpoint, appliedThroughSequence: 25 },
    }));
    const dependencies = { ...fake.dependencies, replayRecoveryJournal: replay };
    await expect(
      cli.executePrivacyCommand('replay', { mode: 'restore' }, { env, dependencies }),
    ).rejects.toThrow();
    await expect(
      cli.executePrivacyCommand('replay', {}, { env, dependencies, quarantined: true }),
    ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
    const result = await cli.executePrivacyCommand(
      'replay',
      { mode: 'restore' },
      { env, dependencies, quarantined: true },
    );
    expect(result.exitCode).toBe(2);
    expect(result.output.complete).toBe(false);
    expect(replay).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'restore', maxPages: 4, binding }),
    );
    expect(fake.calls.at(-1)).toBe('close');
  });

  it('submits only an explicit approved manifest CAS to the fixed authority and binding', async () => {
    const fake = fakeOperator();
    const update = vi.fn(async () => undefined);
    const input = { manifest, expectedManifest: null, approvalId };
    const dependencies = { ...fake.dependencies, updateAwsRecoveryManifest: update };
    const result = await cli.executePrivacyCommand('manifest', input, { env, dependencies });
    expect(result.output).toEqual({ applied: true, securityVersion: 1 });
    expect(update).toHaveBeenCalledWith({
      ...input,
      tableName: env.RECOVERY_TABLE_NAME,
      region: env.AWS_REGION,
    });
    expect(fake.calls).toEqual([]);
    await expect(
      cli.executePrivacyCommand(
        'manifest',
        { ...input, manifest: { ...manifest, databaseResourceId: 'db-different-resource' } },
        { env, dependencies },
      ),
    ).rejects.toThrow();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('fences a restore only through the verified migration target and explicit confirmation', async () => {
    const fake = fakeOperator();
    const quarantine = vi.fn(async () => ({ quarantined: true, approvalId, sessions: 4 }));
    const input = {
      binding,
      expectedManifest: { ...manifest, securityReauthorized: false },
      confirmedInstallationId: binding.installationId,
      approvalId,
    };
    const dependencies = { ...fake.dependencies, quarantineRestoredDatabase: quarantine };
    await expect(
      cli.executePrivacyCommand('quarantine', input, { env, dependencies }),
    ).rejects.toThrow();
    await expect(
      cli.executePrivacyCommand(
        'quarantine',
        { ...input, expectedManifest: manifest },
        { env, dependencies, quarantined: true },
      ),
    ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
    const result = await cli.executePrivacyCommand('quarantine', input, {
      env,
      dependencies,
      quarantined: true,
    });
    expect(fake.verify).toHaveBeenCalledWith(
      expect.objectContaining({ databaseUrl: env.DATABASE_MIGRATION_URL, binding }),
      expect.any(AbortSignal),
    );
    expect(quarantine).toHaveBeenCalledWith(
      { url: env.DATABASE_MIGRATION_URL, caFile: env.DATABASE_CA_FILE },
      input,
      expect.any(Object),
    );
    expect(fake.create).not.toHaveBeenCalled();
    expect(result.output).toEqual({ quarantined: true, approvalId });
  });
});
