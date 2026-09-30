import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import {
  deletionAcknowledgmentSchema,
  deletionDecisionDigest,
  deletionDecisionSchema,
  deletionPageSchema,
  privacyLimits,
  recoveryManifestSchema,
  type DeletionDecision,
  type RecoveryAuthority,
  type RecoveryManifest,
} from './privacy.js';

const tableSchema = z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/);
const regionSchema = z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/);
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
type Command = GetCommand | PutCommand | QueryCommand | TransactWriteCommand;
export type RecoveryTransport = (command: Command, signal?: AbortSignal) => Promise<unknown>;

export class RecoveryAuthorityError extends Error {
  constructor() {
    super('The independent recovery authority is unavailable or inconsistent.');
    this.name = 'RecoveryAuthorityError';
  }
}
function reject(): never {
  throw new RecoveryAuthorityError();
}
const partition = (installationId: string) => `INSTALLATION#${z.uuid().parse(installationId)}`;
const sequenceKey = (value: number) =>
  `SEQ#${sequenceSchema.parse(value).toString().padStart(20, '0')}`;
const eventKey = (eventId: string) => `EVENT#${z.uuid().parse(eventId)}`;
const itemResult = z.object({ Item: z.record(z.string(), z.unknown()).optional() });

function transportFor(region: string): RecoveryTransport {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: regionSchema.parse(region),
      ignoreConfiguredEndpointUrls: true,
      // A transaction with an unknown result is resolved by its immutable event ID,
      // rather than automatically sending the mutation again.
      maxAttempts: 1,
    }),
    { marshallOptions: { removeUndefinedValues: false } },
  );
  return async (command, signal) => {
    const requestOptions = signal ? { abortSignal: signal } : {};
    if (command instanceof GetCommand) return client.send(command, requestOptions);
    if (command instanceof PutCommand) return client.send(command, requestOptions);
    if (command instanceof QueryCommand) return client.send(command, requestOptions);
    return client.send(command, requestOptions);
  };
}

/** Fixed-table, role-authenticated control plane. Never accepts endpoints or credentials. */
export function createAwsRecoveryAuthority(options: {
  tableName: string;
  region: string;
  transport?: RecoveryTransport;
}): RecoveryAuthority {
  const tableName = tableSchema.parse(options.tableName);
  const send = options.transport ?? transportFor(options.region);
  regionSchema.parse(options.region);
  async function getItem(PK: string, SK: string, signal?: AbortSignal) {
    const result = itemResult.parse(
      await send(
        new GetCommand({
          TableName: tableName,
          Key: { PK, SK },
          ConsistentRead: true,
        }),
        signal,
      ),
    );
    return result.Item;
  }
  async function manifest(installationId: string, signal?: AbortSignal): Promise<RecoveryManifest> {
    const item = await getItem(partition(installationId), 'MANIFEST', signal);
    const value = recoveryManifestSchema.parse(item?.document);
    if (value.installationId !== installationId) reject();
    return value;
  }
  function acknowledgment(item: Record<string, unknown> | undefined, decision: DeletionDecision) {
    if (!item) return null;
    const ack = deletionAcknowledgmentSchema.parse({
      eventId: item.eventId,
      sequence: item.sequence,
      decisionDigest: item.decisionDigest,
    });
    if (ack.eventId !== decision.eventId || ack.decisionDigest !== deletionDecisionDigest(decision))
      reject();
    return ack;
  }
  return {
    async getManifest(input, signal) {
      try {
        return await manifest(z.uuid().parse(input.installationId), signal);
      } catch {
        return reject();
      }
    },
    async appendDeletion(input, signal) {
      try {
        const decision = deletionDecisionSchema.parse(input);
        const current = await manifest(decision.installationId, signal);
        if (
          current.epoch !== decision.epoch ||
          current.databaseResourceId !== decision.databaseResourceId ||
          !current.securityReauthorized ||
          !current.coverageComplete
        )
          reject();
        const PK = partition(decision.installationId);
        const prior = acknowledgment(
          await getItem(PK, eventKey(decision.eventId), signal),
          decision,
        );
        if (prior) {
          if (prior.sequence > current.throughSequence) reject();
          return prior;
        }
        const sequence = sequenceSchema.parse(current.throughSequence + 1);
        const decisionDigest = deletionDecisionDigest(decision);
        const ack = { eventId: decision.eventId, sequence, decisionDigest };
        const next = { ...current, throughSequence: sequence };
        try {
          await send(
            new TransactWriteCommand({
              // Immutable event identity makes an unknown write safe to inspect later.
              ClientRequestToken: createHash('sha256')
                .update(JSON.stringify([decisionDigest, current, sequence]))
                .digest('hex')
                .slice(0, 36),
              TransactItems: [
                {
                  Update: {
                    TableName: tableName,
                    Key: { PK, SK: 'MANIFEST' },
                    UpdateExpression: 'SET #document = :next',
                    ConditionExpression: '#document = :current',
                    ExpressionAttributeNames: { '#document': 'document' },
                    ExpressionAttributeValues: { ':next': next, ':current': current },
                  },
                },
                {
                  Put: {
                    TableName: tableName,
                    Item: { PK, SK: eventKey(decision.eventId), ...ack },
                    ConditionExpression: 'attribute_not_exists(PK)',
                  },
                },
                {
                  Put: {
                    TableName: tableName,
                    Item: { PK, SK: sequenceKey(sequence), sequence, decision, decisionDigest },
                    ConditionExpression: 'attribute_not_exists(PK)',
                  },
                },
              ],
            }),
            signal,
          );
          return ack;
        } catch {
          // Resolve lost acknowledgments with one strong read; never repeat the send.
          const resolved = acknowledgment(
            await getItem(PK, eventKey(decision.eventId), signal),
            decision,
          );
          if (!resolved) reject();
          const latest = await manifest(decision.installationId, signal);
          if (
            latest.epoch !== decision.epoch ||
            latest.databaseResourceId !== decision.databaseResourceId ||
            latest.throughSequence < resolved.sequence ||
            !latest.coverageComplete ||
            !latest.securityReauthorized ||
            latest.securityVersion !== current.securityVersion
          )
            reject();
          return resolved;
        }
      } catch {
        return reject();
      }
    },
    async readDeletions(input, signal) {
      try {
        const parsed = z
          .object({
            installationId: z.uuid(),
            epoch: z.uuid(),
            afterSequence: sequenceSchema,
            limit: z.number().int().min(1).max(privacyLimits.batchCalls),
          })
          .strict()
          .parse(input);
        const current = await manifest(parsed.installationId, signal);
        if (
          current.epoch !== parsed.epoch ||
          parsed.afterSequence > current.throughSequence ||
          !current.coverageComplete
        )
          reject();
        let entries: unknown[] = [];
        if (parsed.afterSequence < current.throughSequence) {
          const output = z
            .object({
              Items: z
                .array(z.record(z.string(), z.unknown()))
                .max(privacyLimits.batchCalls)
                .optional(),
            })
            .parse(
              await send(
                new QueryCommand({
                  TableName: tableName,
                  KeyConditionExpression: 'PK = :partition AND SK BETWEEN :from AND :through',
                  ExpressionAttributeValues: {
                    ':partition': partition(parsed.installationId),
                    ':from': sequenceKey(parsed.afterSequence + 1),
                    ':through': sequenceKey(current.throughSequence),
                  },
                  ConsistentRead: true,
                  ScanIndexForward: true,
                  Limit: parsed.limit,
                }),
                signal,
              ),
            );
          entries = (output.Items ?? []).map((item) => ({
            sequence: item.sequence,
            decision: item.decision,
            decisionDigest: item.decisionDigest,
          }));
        }
        const page = deletionPageSchema.parse({
          installationId: parsed.installationId,
          epoch: parsed.epoch,
          afterSequence: parsed.afterSequence,
          throughSequence: current.throughSequence,
          entries,
          hasMore: parsed.afterSequence + entries.length < current.throughSequence,
        });
        for (let index = 0; index < page.entries.length; index++) {
          const entry = page.entries[index];
          if (
            !entry ||
            entry.sequence !== parsed.afterSequence + index + 1 ||
            entry.sequence > current.throughSequence ||
            entry.decision.installationId !== parsed.installationId ||
            entry.decisionDigest !== deletionDecisionDigest(entry.decision) ||
            !current.replaySources.some(
              (source) =>
                source.epoch === entry.decision.epoch &&
                source.databaseResourceId === entry.decision.databaseResourceId,
            )
          )
            reject();
        }
        if (!page.entries.length && page.hasMore) reject();
        // A page cannot authorize recovery through an epoch rotation during its read.
        const latest = await manifest(parsed.installationId, signal);
        if (
          latest.epoch !== current.epoch ||
          latest.databaseResourceId !== current.databaseResourceId ||
          latest.securityVersion !== current.securityVersion ||
          !latest.coverageComplete ||
          !latest.securityReauthorized ||
          latest.coverageStartSequence !== current.coverageStartSequence ||
          latest.throughSequence < current.throughSequence ||
          current.replaySources.some(
            (source) =>
              !latest.replaySources.some(
                (candidate) =>
                  candidate.epoch === source.epoch &&
                  candidate.databaseResourceId === source.databaseResourceId,
              ),
          )
        )
          reject();
        return page;
      } catch {
        return reject();
      }
    },
  };
}

/** Offline management identity only: CAS must preserve the installation journal. */
export async function updateAwsRecoveryManifest(options: {
  tableName: string;
  region: string;
  manifest: RecoveryManifest;
  expectedManifest: RecoveryManifest | null;
  approvalId: string;
  transport?: RecoveryTransport;
}): Promise<void> {
  try {
    const tableName = tableSchema.parse(options.tableName),
      next = recoveryManifestSchema.parse(options.manifest);
    const approvalId = z.uuid().parse(options.approvalId);
    const previous =
      options.expectedManifest === null
        ? null
        : recoveryManifestSchema.parse(options.expectedManifest);
    if (previous) {
      if (next.databaseResourceId !== previous.databaseResourceId && next.epoch === previous.epoch)
        reject();
      if (
        next.installationId !== previous.installationId ||
        next.throughSequence !== previous.throughSequence ||
        next.coverageStartSequence !== previous.coverageStartSequence ||
        next.securityVersion <= previous.securityVersion
      )
        reject();
      if (
        previous.replaySources.some(
          (source) =>
            !next.replaySources.some(
              (candidate) =>
                candidate.epoch === source.epoch &&
                candidate.databaseResourceId === source.databaseResourceId,
            ),
        )
      )
        reject();
    } else if (
      next.throughSequence !== 0 ||
      next.coverageStartSequence !== 1 ||
      next.securityVersion !== 1
    )
      reject();
    const send = options.transport ?? transportFor(options.region);
    regionSchema.parse(options.region);
    await send(
      new PutCommand({
        TableName: tableName,
        Item: { PK: partition(next.installationId), SK: 'MANIFEST', document: next, approvalId },
        ConditionExpression: previous ? '#document = :previous' : 'attribute_not_exists(PK)',
        ...(previous
          ? {
              ExpressionAttributeNames: { '#document': 'document' },
              ExpressionAttributeValues: { ':previous': previous },
            }
          : {}),
      }),
      AbortSignal.timeout(privacyLimits.authorityTimeoutMs),
    );
  } catch {
    reject();
  }
}
