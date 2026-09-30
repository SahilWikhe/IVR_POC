import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import {
  createAwsRecoveryAuthority,
  RecoveryAuthorityError,
  updateAwsRecoveryManifest,
  type RecoveryTransport,
} from '../packages/database/src/aws-recovery.js';
import {
  deletionDecisionDigest,
  deletionDecisionSchema,
  privacyLimits,
  recoveryManifestSchema,
  type DeletionDecision,
  type RecoveryManifest,
} from '../packages/database/src/privacy.js';
import {
  createRecoveryGuard,
  createRuntimeRecoveryGuard,
  loadRecoveryEnvironment,
  verifyRdsDatabaseResource,
} from '../packages/database/src/recovery-runtime.js';

const tableName = 'synthetic-independent-recovery';
const region = 'us-east-1';
const installationId = randomUUID();
const epoch = randomUUID();
const databaseResourceId = 'synthetic-database-resource';
const PK = `INSTALLATION#${installationId}`;
const sequenceKey = (sequence: number) => `SEQ#${String(sequence).padStart(20, '0')}`;
const manifest = (changes: Partial<RecoveryManifest> = {}): RecoveryManifest =>
  recoveryManifestSchema.parse({
    installationId,
    epoch,
    databaseResourceId,
    securityVersion: 1,
    securityReauthorized: true,
    coverageComplete: true,
    coverageStartSequence: 1,
    throughSequence: 0,
    replaySources: [{ epoch, databaseResourceId }],
    ...changes,
  });
const decision = (changes: Partial<DeletionDecision> = {}): DeletionDecision =>
  deletionDecisionSchema.parse({
    schemaVersion: 1,
    kind: 'MINIMIZE_CALLER_CONTENT',
    installationId,
    epoch,
    databaseResourceId,
    eventId: randomUUID(),
    tenantId: randomUUID(),
    callId: randomUUID(),
    policyId: randomUUID(),
    policyVersion: 1,
    cutoffAt: '2026-09-01T00:00:00Z',
    decidedAt: '2026-09-30T12:00:00Z',
    ...changes,
  });
const eventItem = (value: DeletionDecision, sequence: number) => ({
  PK,
  SK: `EVENT#${value.eventId}`,
  eventId: value.eventId,
  sequence,
  decisionDigest: deletionDecisionDigest(value),
});
const journalItem = (value: DeletionDecision, sequence: number) => ({
  PK,
  SK: sequenceKey(sequence),
  sequence,
  decision: value,
  decisionDigest: deletionDecisionDigest(value),
});
function authority(transport: RecoveryTransport) {
  return createAwsRecoveryAuthority({ tableName, region, transport });
}
function unsupported(): never {
  throw new Error('Unexpected command in synthetic transport.');
}

describe('independent AWS recovery authority command and consistency boundaries', () => {
  it('uses one fixed table and installation-bound strongly consistent manifest read with cancellation', async () => {
    const value = manifest();
    const transport = vi.fn<RecoveryTransport>(async (command) => {
      if (!(command instanceof GetCommand)) return unsupported();
      expect(command.input).toEqual({
        TableName: tableName,
        Key: { PK, SK: 'MANIFEST' },
        ConsistentRead: true,
      });
      return { Item: { PK, SK: 'MANIFEST', document: value } };
    });
    const controller = new AbortController();
    const adapter = authority(transport);
    expect(transport).not.toHaveBeenCalled();
    expect(await adapter.getManifest({ installationId }, controller.signal)).toEqual(value);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]).toBe(controller.signal);
    expect(() =>
      createAwsRecoveryAuthority({ tableName: 'https://other-host.example', region, transport }),
    ).toThrow();
    expect(() =>
      createAwsRecoveryAuthority({ tableName, region: 'arbitrary-region', transport }),
    ).toThrow();
  });

  it('rejects absent, malformed, or foreign manifests without returning raw provider errors', async () => {
    for (const output of [
      {},
      { Item: {} },
      { Item: { document: manifest({ installationId: randomUUID() }) } },
    ]) {
      const transport = vi.fn<RecoveryTransport>(async () => output);
      await expect(authority(transport).getManifest({ installationId })).rejects.toBeInstanceOf(
        RecoveryAuthorityError,
      );
    }
    const transport = vi.fn<RecoveryTransport>(async () => {
      throw new Error('Synthetic sensitive provider detail');
    });
    await expect(authority(transport).getManifest({ installationId })).rejects.toThrow(
      'unavailable or inconsistent',
    );
    try {
      await authority(transport).getManifest({ installationId });
    } catch (error) {
      expect(String(error)).not.toContain('sensitive');
    }
  });

  it('atomically CASes the manifest and inserts immutable event and ordered journal entries in one transaction', async () => {
    const current = manifest({ throughSequence: 3 });
    const value = decision();
    const transport = vi.fn<RecoveryTransport>(async (command) => {
      if (command instanceof GetCommand)
        return command.input.Key?.SK === 'MANIFEST' ? { Item: { document: current } } : {};
      if (!(command instanceof TransactWriteCommand)) return unsupported();
      expect(command.input.ClientRequestToken).toMatch(/^[a-f0-9]{36}$/);
      expect(command.input.TransactItems).toHaveLength(3);
      const [update, event, entry] = command.input.TransactItems ?? [];
      expect(update?.Update).toEqual({
        TableName: tableName,
        Key: { PK, SK: 'MANIFEST' },
        UpdateExpression: 'SET #document = :next',
        ConditionExpression: '#document = :current',
        ExpressionAttributeNames: { '#document': 'document' },
        ExpressionAttributeValues: {
          ':current': current,
          ':next': { ...current, throughSequence: 4 },
        },
      });
      expect(event?.Put).toEqual({
        TableName: tableName,
        Item: eventItem(value, 4),
        ConditionExpression: 'attribute_not_exists(PK)',
      });
      expect(entry?.Put).toEqual({
        TableName: tableName,
        Item: journalItem(value, 4),
        ConditionExpression: 'attribute_not_exists(PK)',
      });
      return {};
    });
    expect(await authority(transport).appendDeletion(value)).toEqual({
      eventId: value.eventId,
      sequence: 4,
      decisionDigest: deletionDecisionDigest(value),
    });
    expect(
      transport.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(1);
    expect(transport.mock.calls.some(([command]) => command instanceof PutCommand)).toBe(false);
  });

  it('returns a matching immutable event once and rejects reused identities, digest collisions, or impossible sequences', async () => {
    const value = decision();
    const current = manifest({ throughSequence: 3 });
    const send = (item: Record<string, unknown>) =>
      vi.fn<RecoveryTransport>(async (command) =>
        command instanceof GetCommand
          ? { Item: command.input.Key?.SK === 'MANIFEST' ? { document: current } : item }
          : unsupported(),
      );
    const duplicate = send(eventItem(value, 2));
    expect(await authority(duplicate).appendDeletion(value)).toEqual({
      eventId: value.eventId,
      sequence: 2,
      decisionDigest: deletionDecisionDigest(value),
    });
    expect(duplicate.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(
      false,
    );
    for (const item of [
      eventItem({ ...value, callId: randomUUID() }, 2),
      { ...eventItem(value, 2), eventId: randomUUID() },
      eventItem(value, 4),
    ]) {
      await expect(authority(send(item)).appendDeletion(value)).rejects.toBeInstanceOf(
        RecoveryAuthorityError,
      );
    }
  });

  it('binds the SDK idempotency token to the exact transaction while allowing a later manifest CAS attempt', async () => {
    const value = decision();
    const tokens: string[] = [];
    for (const throughSequence of [3, 3, 4]) {
      const current = manifest({ throughSequence });
      const transport = vi.fn<RecoveryTransport>(async (command) => {
        if (command instanceof GetCommand)
          return command.input.Key?.SK === 'MANIFEST' ? { Item: { document: current } } : {};
        if (!(command instanceof TransactWriteCommand)) return unsupported();
        const token = command.input.ClientRequestToken;
        if (!token) throw new Error('Missing exact transaction token.');
        expect(token).toMatch(/^[a-f0-9]{36}$/);
        tokens.push(token);
        return {};
      });
      await authority(transport).appendDeletion(value);
    }
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it('blocks deletion append when current epoch, database, security authorization, or journal coverage is invalid', async () => {
    const value = decision();
    const otherEpoch = randomUUID();
    for (const current of [
      manifest({ epoch: otherEpoch, replaySources: [{ epoch: otherEpoch, databaseResourceId }] }),
      manifest({
        databaseResourceId: 'other-database',
        replaySources: [{ epoch, databaseResourceId: 'other-database' }],
      }),
      manifest({ securityReauthorized: false }),
      manifest({ coverageComplete: false }),
    ]) {
      const transport = vi.fn<RecoveryTransport>(async () => ({ Item: { document: current } }));
      await expect(authority(transport).appendDeletion(value)).rejects.toBeInstanceOf(
        RecoveryAuthorityError,
      );
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('resolves an unknown transaction by strong immutable-event evidence and never retries its mutation', async () => {
    const value = decision();
    let committed = false;
    const transport = vi.fn<RecoveryTransport>(async (command) => {
      if (command instanceof GetCommand) {
        if (command.input.Key?.SK === 'MANIFEST')
          return { Item: { document: manifest({ throughSequence: committed ? 1 : 0 }) } };
        return committed ? { Item: eventItem(value, 1) } : {};
      }
      if (command instanceof TransactWriteCommand) {
        committed = true;
        throw new Error('Synthetic lost acknowledgment');
      }
      return unsupported();
    });
    expect(await authority(transport).appendDeletion(value)).toEqual({
      eventId: value.eventId,
      sequence: 1,
      decisionDigest: deletionDecisionDigest(value),
    });
    expect(
      transport.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(1);
    for (const [command] of transport.mock.calls)
      if (command instanceof GetCommand) expect(command.input.ConsistentRead).toBe(true);
  });

  it('holds conflict or unknown outcomes when no committed event or a contradictory manifest proves the write', async () => {
    const value = decision();
    for (const contradictory of [false, true]) {
      let attempted = false;
      const transport = vi.fn<RecoveryTransport>(async (command) => {
        if (command instanceof GetCommand) {
          if (command.input.Key?.SK === 'MANIFEST') return { Item: { document: manifest() } };
          return attempted && contradictory ? { Item: eventItem(value, 1) } : {};
        }
        if (command instanceof TransactWriteCommand) {
          attempted = true;
          throw Object.assign(new Error('Synthetic transaction conflict'), {
            name: 'TransactionCanceledException',
          });
        }
        return unsupported();
      });
      await expect(authority(transport).appendDeletion(value)).rejects.toBeInstanceOf(
        RecoveryAuthorityError,
      );
      expect(
        transport.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
      ).toHaveLength(1);
    }
  });

  it('reads bounded contiguous journal pages in sequence order and continues from the last verified sequence', async () => {
    const values = [decision(), decision(), decision()];
    const current = manifest({ throughSequence: 3 });
    const transport = vi.fn<RecoveryTransport>(async (command) => {
      if (command instanceof GetCommand) return { Item: { document: current } };
      if (!(command instanceof QueryCommand)) return unsupported();
      expect(command.input).toMatchObject({
        TableName: tableName,
        KeyConditionExpression: 'PK = :partition AND SK BETWEEN :from AND :through',
        ConsistentRead: true,
        ScanIndexForward: true,
        Limit: 2,
      });
      const first = command.input.ExpressionAttributeValues?.[':from'] === sequenceKey(1);
      expect(command.input.ExpressionAttributeValues).toEqual({
        ':partition': PK,
        ':from': sequenceKey(first ? 1 : 3),
        ':through': sequenceKey(3),
      });
      return {
        Items: values
          .slice(first ? 0 : 2, first ? 2 : 3)
          .map((value, index) => journalItem(value, (first ? 1 : 3) + index)),
      };
    });
    const adapter = authority(transport);
    const first = await adapter.readDeletions({
      installationId,
      epoch,
      afterSequence: 0,
      limit: 2,
    });
    expect(first).toMatchObject({
      afterSequence: 0,
      throughSequence: 3,
      hasMore: true,
      entries: [{ sequence: 1 }, { sequence: 2 }],
    });
    const last = await adapter.readDeletions({ installationId, epoch, afterSequence: 2, limit: 2 });
    expect(last).toMatchObject({
      afterSequence: 2,
      throughSequence: 3,
      hasMore: false,
      entries: [{ sequence: 3 }],
    });
    expect(
      transport.mock.calls.filter(([command]) => command instanceof QueryCommand),
    ).toHaveLength(2);
  });

  it('rejects missing, gapped, unordered, tampered or foreign journal evidence', async () => {
    const a = decision(),
      b = decision();
    const current = manifest({ throughSequence: 2 });
    for (const items of [
      [],
      [journalItem(a, 2)],
      [journalItem(b, 2), journalItem(a, 1)],
      [{ ...journalItem(a, 1), decisionDigest: 'a'.repeat(64) }],
      [journalItem({ ...a, installationId: randomUUID() }, 1)],
    ]) {
      const transport = vi.fn<RecoveryTransport>(async (command) =>
        command instanceof GetCommand
          ? { Item: { document: current } }
          : command instanceof QueryCommand
            ? { Items: items }
            : unsupported(),
      );
      await expect(
        authority(transport).readDeletions({ installationId, epoch, afterSequence: 0, limit: 2 }),
      ).rejects.toBeInstanceOf(RecoveryAuthorityError);
    }
  });

  it('allows only explicitly retained replay-source bindings and rejects source deletion during page verification', async () => {
    const oldEpoch = randomUUID();
    const oldResource = 'synthetic-retired-database';
    const old = decision({ epoch: oldEpoch, databaseResourceId: oldResource });
    const current = manifest({
      throughSequence: 1,
      replaySources: [
        { epoch, databaseResourceId },
        { epoch: oldEpoch, databaseResourceId: oldResource },
      ],
    });
    const transport = vi.fn<RecoveryTransport>(async (command) =>
      command instanceof GetCommand
        ? { Item: { document: current } }
        : command instanceof QueryCommand
          ? { Items: [journalItem(old, 1)] }
          : unsupported(),
    );
    expect(
      await authority(transport).readDeletions({
        installationId,
        epoch,
        afterSequence: 0,
        limit: 1,
      }),
    ).toMatchObject({ entries: [{ sequence: 1, decision: old }] });
    const unlisted = vi.fn<RecoveryTransport>(async (command) =>
      command instanceof GetCommand
        ? { Item: { document: manifest({ throughSequence: 1 }) } }
        : command instanceof QueryCommand
          ? { Items: [journalItem(old, 1)] }
          : unsupported(),
    );
    await expect(
      authority(unlisted).readDeletions({ installationId, epoch, afterSequence: 0, limit: 1 }),
    ).rejects.toBeInstanceOf(RecoveryAuthorityError);
    let reads = 0;
    const changed = vi.fn<RecoveryTransport>(async (command) =>
      command instanceof GetCommand
        ? { Item: { document: ++reads === 1 ? current : manifest({ throughSequence: 1 }) } }
        : command instanceof QueryCommand
          ? { Items: [journalItem(old, 1)] }
          : unsupported(),
    );
    await expect(
      authority(changed).readDeletions({ installationId, epoch, afterSequence: 0, limit: 1 }),
    ).rejects.toBeInstanceOf(RecoveryAuthorityError);
  });

  it('rejects an epoch rotation, security-version change or journal rewind during its bounded read', async () => {
    const value = decision();
    const current = manifest({ throughSequence: 1 });
    const newEpoch = randomUUID();
    for (const changed of [
      manifest({
        epoch: newEpoch,
        throughSequence: 1,
        replaySources: [{ epoch: newEpoch, databaseResourceId }],
      }),
      manifest({ securityVersion: 2, throughSequence: 1 }),
      manifest(),
      manifest({ coverageComplete: false, throughSequence: 1 }),
    ]) {
      let reads = 0;
      const transport = vi.fn<RecoveryTransport>(async (command) =>
        command instanceof GetCommand
          ? { Item: { document: ++reads === 1 ? current : changed } }
          : command instanceof QueryCommand
            ? { Items: [journalItem(value, 1)] }
            : unsupported(),
      );
      await expect(
        authority(transport).readDeletions({ installationId, epoch, afterSequence: 0, limit: 1 }),
      ).rejects.toBeInstanceOf(RecoveryAuthorityError);
    }
  });

  it('does not issue an unbounded page or accept a checkpoint beyond journal coverage', async () => {
    const transport = vi.fn<RecoveryTransport>(async () => ({ Item: { document: manifest() } }));
    await expect(
      authority(transport).readDeletions({ installationId, epoch, afterSequence: 1, limit: 1 }),
    ).rejects.toBeInstanceOf(RecoveryAuthorityError);
    await expect(
      authority(transport).readDeletions({
        installationId,
        epoch,
        afterSequence: 0,
        limit: privacyLimits.batchCalls + 1,
      }),
    ).rejects.toBeInstanceOf(RecoveryAuthorityError);
    expect(transport.mock.calls.some(([command]) => command instanceof QueryCommand)).toBe(false);
  });
});

describe('offline AWS recovery manifest management CAS', () => {
  it('initializes a fresh journal only with conditional create and an explicit approval', async () => {
    const value = manifest();
    const approvalId = randomUUID();
    const transport = vi.fn<RecoveryTransport>(async (command, signal) => {
      if (!(command instanceof PutCommand)) return unsupported();
      expect(command.input).toEqual({
        TableName: tableName,
        Item: { PK, SK: 'MANIFEST', document: value, approvalId },
        ConditionExpression: 'attribute_not_exists(PK)',
      });
      expect(signal).toBeInstanceOf(AbortSignal);
      return {};
    });
    await updateAwsRecoveryManifest({
      tableName,
      region,
      manifest: value,
      expectedManifest: null,
      approvalId,
      transport,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rotates a restore epoch with a new security version while retaining all journal positions and replay sources', async () => {
    const previous = manifest({ throughSequence: 3 });
    const newEpoch = randomUUID();
    const next = manifest({
      epoch: newEpoch,
      databaseResourceId: 'synthetic-restored-database',
      securityVersion: 2,
      throughSequence: 3,
      replaySources: [
        ...previous.replaySources,
        { epoch: newEpoch, databaseResourceId: 'synthetic-restored-database' },
      ],
    });
    const approvalId = randomUUID();
    const transport = vi.fn<RecoveryTransport>(async (command) => {
      if (!(command instanceof PutCommand)) return unsupported();
      expect(command.input).toEqual({
        TableName: tableName,
        Item: { PK, SK: 'MANIFEST', document: next, approvalId },
        ConditionExpression: '#document = :previous',
        ExpressionAttributeNames: { '#document': 'document' },
        ExpressionAttributeValues: { ':previous': previous },
      });
      return {};
    });
    await updateAwsRecoveryManifest({
      tableName,
      region,
      manifest: next,
      expectedManifest: previous,
      approvalId,
      transport,
    });
  });

  it('rejects journal rewind, fabricated advancement, lost replay sources and stale security versions before any write', async () => {
    const previous = manifest({ throughSequence: 3 });
    const newEpoch = randomUUID();
    const candidates = [
      manifest({ throughSequence: 2, securityVersion: 2 }),
      manifest({ throughSequence: 4, securityVersion: 2 }),
      manifest({ throughSequence: 3, securityVersion: 1 }),
      manifest({ throughSequence: 3, coverageStartSequence: 2, securityVersion: 2 }),
      manifest({ installationId: randomUUID(), throughSequence: 3, securityVersion: 2 }),
      manifest({
        epoch: newEpoch,
        throughSequence: 3,
        securityVersion: 2,
        replaySources: [{ epoch: newEpoch, databaseResourceId }],
      }),
    ];
    for (const next of candidates) {
      const transport = vi.fn<RecoveryTransport>(async () => ({}));
      await expect(
        updateAwsRecoveryManifest({
          tableName,
          region,
          manifest: next,
          expectedManifest: previous,
          approvalId: randomUUID(),
          transport,
        }),
      ).rejects.toBeInstanceOf(RecoveryAuthorityError);
      expect(transport).not.toHaveBeenCalled();
    }
    for (const next of [manifest({ throughSequence: 1 }), manifest({ securityVersion: 2 })]) {
      const transport = vi.fn<RecoveryTransport>(async () => ({}));
      await expect(
        updateAwsRecoveryManifest({
          tableName,
          region,
          manifest: next,
          expectedManifest: null,
          approvalId: randomUUID(),
          transport,
        }),
      ).rejects.toBeInstanceOf(RecoveryAuthorityError);
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('fails closed on management CAS conflict without retrying or leaking raw provider details', async () => {
    const previous = manifest({ throughSequence: 2 });
    const transport = vi.fn<RecoveryTransport>(async () => {
      throw new Error('Synthetic sensitive management CAS detail');
    });
    await expect(
      updateAwsRecoveryManifest({
        tableName,
        region,
        manifest: { ...previous, securityVersion: 2 },
        expectedManifest: previous,
        approvalId: randomUUID(),
        transport,
      }),
    ).rejects.toThrow('unavailable or inconsistent');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('native-runtime database and independent-journal admission guard', () => {
  const databaseUrl = 'postgresql://synthetic:fixture@synthetic-db.example:5432/hostline';
  const databaseInstanceId = 'synthetic-hostline-db';
  const binding = { installationId, epoch, databaseResourceId };
  const available = {
    DBInstances: [
      {
        DBInstanceIdentifier: databaseInstanceId,
        DbiResourceId: databaseResourceId,
        DBInstanceStatus: 'available',
        Endpoint: { Address: 'synthetic-db.example', Port: 5432 },
      },
    ],
  };

  it('checks the fixed RDS instance, immutable resource, status and actual SQL endpoint before accepting the binding', async () => {
    const controller = new AbortController();
    const describe = vi.fn<
      NonNullable<Parameters<typeof verifyRdsDatabaseResource>[0]['describe']>
    >(async (command, signal) => {
      expect(command.constructor.name).toBe('DescribeDBInstancesCommand');
      expect(command.input).toEqual({ DBInstanceIdentifier: databaseInstanceId });
      expect(signal).toBe(controller.signal);
      return available;
    });
    expect(
      await verifyRdsDatabaseResource(
        { databaseUrl, databaseInstanceId, binding, region, describe },
        controller.signal,
      ),
    ).toBe(true);
    expect(describe).toHaveBeenCalledTimes(1);
    for (const output of [
      { DBInstances: [] },
      { DBInstances: [...available.DBInstances, ...available.DBInstances] },
      { DBInstances: [{ ...available.DBInstances[0], DBInstanceIdentifier: 'other-db' }] },
      { DBInstances: [{ ...available.DBInstances[0], DbiResourceId: 'other-resource' }] },
      { DBInstances: [{ ...available.DBInstances[0], DBInstanceStatus: 'creating' }] },
      {
        DBInstances: [
          { ...available.DBInstances[0], Endpoint: { Address: 'other-db.example', Port: 5432 } },
        ],
      },
      {
        DBInstances: [
          {
            ...available.DBInstances[0],
            Endpoint: { Address: 'synthetic-db.example', Port: 5433 },
          },
        ],
      },
    ]) {
      expect(
        await verifyRdsDatabaseResource(
          { databaseUrl, databaseInstanceId, binding, region, describe: async () => output },
          controller.signal,
        ),
      ).toBe(false);
    }
    expect(
      await verifyRdsDatabaseResource(
        {
          databaseUrl,
          databaseInstanceId,
          binding,
          region,
          describe: async () => {
            throw new Error('Synthetic RDS permission failure');
          },
        },
        controller.signal,
      ),
    ).toBe(false);
  });

  it('rejects query overrides that would make node-postgres connect somewhere other than the verified URL', async () => {
    for (const override of [
      'host=other-db.example',
      'port=5433',
      'hostaddr=192.0.2.1',
      'dbname=other-database',
    ]) {
      const describe = vi.fn(async () => available);
      expect(
        await verifyRdsDatabaseResource(
          {
            databaseUrl: `${databaseUrl}?${override}`,
            databaseInstanceId,
            binding,
            region,
            describe,
          },
          new AbortController().signal,
        ),
      ).toBe(false);
      expect(describe).not.toHaveBeenCalled();
    }
  });

  it('stays quarantined without complete recovery configuration and never reads DB data as a bypass', async () => {
    const db = { readRecoveryCheckpoint: vi.fn(async () => null) };
    expect(loadRecoveryEnvironment({ AWS_REGION: region })).toBeNull();
    expect(
      await createRuntimeRecoveryGuard(db, { DATABASE_URL: databaseUrl, AWS_REGION: region })(),
    ).toBe(false);
    expect(db.readRecoveryCheckpoint).not.toHaveBeenCalled();
    expect(() => loadRecoveryEnvironment({ RECOVERY_INSTALLATION_ID: installationId })).toThrow(
      'complete documented',
    );
    const environment = {
      RECOVERY_INSTALLATION_ID: installationId,
      RECOVERY_EPOCH: epoch,
      RECOVERY_DATABASE_RESOURCE_ID: databaseResourceId,
      RECOVERY_TABLE_NAME: tableName,
      RECOVERY_DATABASE_INSTANCE_ID: databaseInstanceId,
      AWS_REGION: region,
    };
    expect(loadRecoveryEnvironment(environment)).toEqual({
      ...binding,
      tableName,
      databaseInstanceId,
      region,
    });
    expect(await createRuntimeRecoveryGuard(db, environment)()).toBe(false);
    expect(
      await createRuntimeRecoveryGuard(db, { ...environment, DATABASE_URL: databaseUrl })(),
    ).toBe(false);
    expect(db.readRecoveryCheckpoint).not.toHaveBeenCalled();
  });

  it('admits only a verified resource with authorized security and fully replayed independent coverage', async () => {
    const current = manifest({ throughSequence: 3 });
    const checkpoint = { ...binding, securityVersion: 1, appliedThroughSequence: 3 };
    const getManifest = vi.fn(async () => current);
    const independent = {
      getManifest,
      appendDeletion: async () => unsupported(),
      readDeletions: async () => unsupported(),
    };
    const db = { readRecoveryCheckpoint: vi.fn(async () => checkpoint) };
    expect(
      await createRecoveryGuard({
        db,
        binding,
        authority: independent,
        verifyDatabase: async () => true,
      })(),
    ).toBe(true);
    expect(db.readRecoveryCheckpoint).toHaveBeenCalledWith(installationId);
    expect(getManifest).toHaveBeenCalledWith({ installationId }, expect.any(AbortSignal));
    getManifest.mockClear();
    expect(
      await createRecoveryGuard({
        db,
        binding,
        authority: independent,
        verifyDatabase: async () => false,
      })(),
    ).toBe(false);
    expect(getManifest).not.toHaveBeenCalled();
    for (const changed of [
      manifest({ securityReauthorized: false, throughSequence: 3 }),
      manifest({ coverageComplete: false, throughSequence: 3 }),
      manifest({ securityVersion: 2, throughSequence: 3 }),
      manifest({
        databaseResourceId: 'unbound-resource',
        throughSequence: 3,
        replaySources: [{ epoch, databaseResourceId: 'unbound-resource' }],
      }),
    ]) {
      expect(
        await createRecoveryGuard({
          db,
          binding,
          authority: { ...independent, getManifest: async () => changed },
          verifyDatabase: async () => true,
        })(),
      ).toBe(false);
    }
    for (const changed of [
      null,
      { ...checkpoint, appliedThroughSequence: 2 },
      { ...checkpoint, appliedThroughSequence: 4 },
    ]) {
      expect(
        await createRecoveryGuard({
          db: { readRecoveryCheckpoint: async () => changed },
          binding,
          authority: independent,
          verifyDatabase: async () => true,
        })(),
      ).toBe(false);
    }
  });

  it('bounds stalled resource verification and rejects provider/database failures without opening admission', async () => {
    const checkpoint = { ...binding, securityVersion: 1, appliedThroughSequence: 0 };
    const getManifest = vi.fn(async () => manifest());
    const independent = {
      getManifest,
      appendDeletion: async () => unsupported(),
      readDeletions: async () => unsupported(),
    };
    const db = { readRecoveryCheckpoint: async () => checkpoint };
    expect(
      await createRecoveryGuard({
        db,
        binding,
        authority: independent,
        verifyDatabase: async () => {
          throw new Error('Synthetic RDS failure');
        },
      })(),
    ).toBe(false);
    expect(
      await createRecoveryGuard({
        db: {
          readRecoveryCheckpoint: async () => {
            throw new Error('Synthetic database failure');
          },
        },
        binding,
        authority: independent,
        verifyDatabase: async () => true,
      })(),
    ).toBe(false);
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const guard = createRecoveryGuard({
        db,
        binding,
        authority: independent,
        verifyDatabase: async (provided) => {
          signal = provided;
          return new Promise<boolean>(() => {});
        },
      });
      const result = guard();
      await vi.advanceTimersByTimeAsync(3001);
      expect(await result).toBe(false);
      expect(signal?.aborted).toBe(true);
      expect(getManifest).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
