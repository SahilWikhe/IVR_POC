import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  callSessionSchema,
  handoffSchema,
  inboxItemSchema,
  voiceCallRecordSchema,
  type CallSession,
} from '@hostline/contracts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCounter = counter.refine((value) => value > 0);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const terminalTwiml = '<Response><Hangup/></Response>';
export const privacyLimits = Object.freeze({
  batchCalls: 25,
  receiptsPerCall: 200,
  authorityTimeoutMs: 3000,
  replaySources: 16,
});

export const retentionPolicySchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false), version: positiveCounter, policyId: uuid }).strict(),
  z
    .object({
      enabled: z.literal(true),
      version: positiveCounter,
      policyId: uuid,
      approvalId: uuid,
      closedAfterDays: z.number().int().min(1).max(3650),
    })
    .strict(),
]);
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export const recoveryBindingSchema = z
  .object({ installationId: uuid, epoch: uuid, databaseResourceId: z.string().min(1).max(200) })
  .strict();
export type RecoveryBinding = z.infer<typeof recoveryBindingSchema>;
export const recoveryCheckpointSchema = recoveryBindingSchema.extend({
  securityVersion: positiveCounter,
  appliedThroughSequence: counter,
});
export type RecoveryCheckpoint = z.infer<typeof recoveryCheckpointSchema>;
export const recoveryManifestSchema = recoveryBindingSchema
  .extend({
    securityVersion: positiveCounter,
    securityReauthorized: z.boolean(),
    coverageComplete: z.boolean(),
    coverageStartSequence: positiveCounter,
    throughSequence: counter,
    replaySources: z
      .array(z.object({ epoch: uuid, databaseResourceId: z.string().min(1).max(200) }).strict())
      .min(1)
      .max(privacyLimits.replaySources),
  })
  .refine((value) => value.coverageStartSequence <= value.throughSequence + 1)
  .refine((value) =>
    value.replaySources.some(
      (source) =>
        source.epoch === value.epoch && source.databaseResourceId === value.databaseResourceId,
    ),
  )
  .refine(
    (value) =>
      new Set(value.replaySources.map((source) => `${source.epoch}:${source.databaseResourceId}`))
        .size === value.replaySources.length,
  );
export type RecoveryManifest = z.infer<typeof recoveryManifestSchema>;
export const deletionDecisionSchema = recoveryBindingSchema.extend({
  schemaVersion: z.literal(1),
  kind: z.literal('MINIMIZE_CALLER_CONTENT'),
  eventId: uuid,
  tenantId: uuid,
  callId: uuid,
  policyId: uuid,
  policyVersion: positiveCounter,
  cutoffAt: instant,
  decidedAt: instant,
});
export type DeletionDecision = z.infer<typeof deletionDecisionSchema>;
export const deletionAcknowledgmentSchema = z
  .object({ eventId: uuid, sequence: positiveCounter, decisionDigest: digest })
  .strict();
export type DeletionAcknowledgment = z.infer<typeof deletionAcknowledgmentSchema>;
const journalEntrySchema = z
  .object({ sequence: positiveCounter, decision: deletionDecisionSchema, decisionDigest: digest })
  .strict();
export const deletionPageSchema = z
  .object({
    installationId: uuid,
    epoch: uuid,
    afterSequence: counter,
    throughSequence: counter,
    entries: z.array(journalEntrySchema).max(privacyLimits.batchCalls),
    hasMore: z.boolean(),
  })
  .strict();
export type DeletionPage = z.infer<typeof deletionPageSchema>;

/** Implemented by an independent authenticated control plane, never a DB flag. */
export interface RecoveryAuthority {
  getManifest(input: { installationId: string }, signal?: AbortSignal): Promise<unknown>;
  appendDeletion(decision: DeletionDecision, signal?: AbortSignal): Promise<unknown>;
  readDeletions(
    input: { installationId: string; epoch: string; afterSequence: number; limit: number },
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export interface PrivacySqlClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}
/** Each callback owns a real transaction under the separate privacy role. */
export interface PrivacyPersistence {
  withTenant<T>(tenantId: string, work: (client: PrivacySqlClient) => Promise<T>): Promise<T>;
  readCheckpoint(installationId: string): Promise<RecoveryCheckpoint | null>;
}
export interface PrivacyOperatorPersistence extends PrivacyPersistence {
  withControl<T>(work: (client: PrivacySqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export class PrivacyOperationError extends Error {
  constructor(public readonly code: string) {
    super('The privacy/recovery operation could not complete safely.');
    this.name = 'PrivacyOperationError';
  }
}
function fail(code: string): never {
  throw new PrivacyOperationError(code);
}

export function deletionDecisionDigest(input: DeletionDecision): string {
  const value = deletionDecisionSchema.parse(input);
  return createHash('sha256')
    .update(
      JSON.stringify([
        value.schemaVersion,
        value.kind,
        value.installationId,
        value.epoch,
        value.databaseResourceId,
        value.eventId,
        value.tenantId,
        value.callId,
        value.policyId,
        value.policyVersion,
        value.cutoffAt,
        value.decidedAt,
      ]),
    )
    .digest('hex');
}
async function authorityCall<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new PrivacyOperationError('AUTHORITY_UNAVAILABLE'));
        }, privacyLimits.authorityTimeoutMs);
        timeout.unref();
      }),
    ]);
  } catch {
    return fail('AUTHORITY_UNAVAILABLE');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function sameBinding(a: RecoveryBinding, b: RecoveryBinding): boolean {
  return (
    a.installationId === b.installationId &&
    a.epoch === b.epoch &&
    a.databaseResourceId === b.databaseResourceId
  );
}
export async function readRecoveryManifest(
  authority: RecoveryAuthority,
  installationId: string,
): Promise<RecoveryManifest> {
  const id = uuid.parse(installationId);
  const manifest = recoveryManifestSchema.parse(
    await authorityCall((signal) => authority.getManifest({ installationId: id }, signal)),
  );
  if (manifest.installationId !== id) fail('BINDING_MISMATCH');
  return manifest;
}
export type RecoveryReadiness =
  | { ready: true; manifest: RecoveryManifest }
  | {
      ready: false;
      reason:
        | 'UNCONFIGURED'
        | 'AUTHORITY_UNAVAILABLE'
        | 'BINDING_MISMATCH'
        | 'SECURITY_UNVERIFIED'
        | 'JOURNAL_INCOMPLETE'
        | 'REPLAY_PENDING';
    };

export async function inspectRecoveryReadiness(input: {
  binding: RecoveryBinding;
  checkpoint: RecoveryCheckpoint | null;
  authority?: RecoveryAuthority;
}): Promise<RecoveryReadiness> {
  const binding = recoveryBindingSchema.parse(input.binding);
  const authority = input.authority;
  if (!authority) return { ready: false, reason: 'UNCONFIGURED' };
  let manifest: RecoveryManifest;
  try {
    manifest = await readRecoveryManifest(authority, binding.installationId);
  } catch {
    return { ready: false, reason: 'AUTHORITY_UNAVAILABLE' };
  }
  const checkpoint = input.checkpoint ? recoveryCheckpointSchema.safeParse(input.checkpoint) : null;
  if (
    !sameBinding(binding, manifest) ||
    !checkpoint?.success ||
    !sameBinding(binding, checkpoint.data)
  )
    return { ready: false, reason: 'BINDING_MISMATCH' };
  if (
    !manifest.securityReauthorized ||
    checkpoint.data.securityVersion !== manifest.securityVersion
  )
    return { ready: false, reason: 'SECURITY_UNVERIFIED' };
  if (
    !manifest.coverageComplete ||
    manifest.coverageStartSequence > checkpoint.data.appliedThroughSequence + 1 ||
    checkpoint.data.appliedThroughSequence > manifest.throughSequence
  )
    return { ready: false, reason: 'JOURNAL_INCOMPLETE' };
  if (checkpoint.data.appliedThroughSequence !== manifest.throughSequence)
    return { ready: false, reason: 'REPLAY_PENDING' };
  return { ready: true, manifest };
}

export async function readRecoveryCheckpoint(
  client: PrivacySqlClient,
  installationId: string,
): Promise<RecoveryCheckpoint | null> {
  const result = await client.query(
    'SELECT installation_id,epoch,database_resource_id,security_version,applied_through_sequence FROM recovery_checkpoints WHERE installation_id=$1',
    [uuid.parse(installationId)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return recoveryCheckpointSchema.parse({
    installationId: row.installation_id,
    epoch: row.epoch,
    databaseResourceId: row.database_resource_id,
    securityVersion: Number(row.security_version),
    appliedThroughSequence: Number(row.applied_through_sequence),
  });
}

export async function saveRetentionPolicy(
  client: PrivacySqlClient,
  tenantId: string,
  input: RetentionPolicy,
  expectedVersion: number | null,
): Promise<void> {
  const tenant = uuid.parse(tenantId),
    policy = retentionPolicySchema.parse(input);
  await client.query('SELECT lock_privacy_tenant($1)', [tenant]);
  if (expectedVersion === null) {
    if (policy.version !== 1) fail('POLICY_CONFLICT');
    const result = await client.query(
      'INSERT INTO privacy_policies(tenant_id,version,document) VALUES($1,$2,$3::jsonb) ON CONFLICT(tenant_id) DO NOTHING',
      [tenant, policy.version, JSON.stringify(policy)],
    );
    if (result.rowCount !== 1) fail('POLICY_CONFLICT');
  } else {
    positiveCounter.parse(expectedVersion);
    if (policy.version !== expectedVersion + 1) fail('POLICY_CONFLICT');
    const result = await client.query(
      'UPDATE privacy_policies SET version=$2,document=$3::jsonb WHERE tenant_id=$1 AND version=$4',
      [tenant, policy.version, JSON.stringify(policy), expectedVersion],
    );
    if (result.rowCount !== 1) fail('POLICY_CONFLICT');
  }
}

async function readPolicy(
  client: PrivacySqlClient,
  tenantId: string,
): Promise<RetentionPolicy | null> {
  const row = (
    await client.query('SELECT document FROM privacy_policies WHERE tenant_id=$1 FOR UPDATE', [
      tenantId,
    ])
  ).rows[0];
  return row ? retentionPolicySchema.parse(row.document) : null;
}
interface Bundle {
  call: CallSession;
  voice: z.infer<typeof voiceCallRecordSchema> | null;
  inbox: z.infer<typeof inboxItemSchema>[];
  handoff: z.infer<typeof handoffSchema> | null;
  receipts: { key: string; fingerprint: string; result: unknown }[];
}
async function loadBundle(
  client: PrivacySqlClient,
  tenantId: string,
  callId: string,
): Promise<Bundle | null> {
  const row = (
    await client.query(
      'SELECT CASE WHEN octet_length(document::text)<=262144 THEN document ELSE NULL END AS document FROM calls WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [tenantId, callId],
    )
  ).rows[0];
  if (!row) return null;
  const call = callSessionSchema.strict().safeParse(row.document);
  if (!call.success) fail('UNKNOWN_CONTENT');
  const voiceRow = (
    await client.query('SELECT document FROM voice_calls WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      tenantId,
      callId,
    ])
  ).rows[0];
  const voice = voiceRow ? voiceCallRecordSchema.safeParse(voiceRow.document) : null;
  if (voice && !voice.success) fail('UNKNOWN_CONTENT');
  const inboxRows = (
    await client.query(
      'SELECT document FROM inbox WHERE tenant_id=$1 AND call_id=$2 ORDER BY id LIMIT 11 FOR UPDATE',
      [tenantId, callId],
    )
  ).rows;
  if (inboxRows.length > 10) fail('UNKNOWN_CONTENT');
  const inbox = inboxRows.map((item) => inboxItemSchema.strict().parse(item.document));
  const handoffRow = (
    await client.query(
      'SELECT document FROM phone_handoffs WHERE tenant_id=$1 AND call_id=$2 FOR UPDATE',
      [tenantId, callId],
    )
  ).rows[0];
  const handoff = handoffRow ? handoffSchema.parse(handoffRow.document) : null;
  const receiptRows = (
    await client.query(
      'SELECT idempotency_key,fingerprint,CASE WHEN octet_length(result::text)<=65536 THEN result ELSE NULL END AS result FROM receipts WHERE tenant_id=$1 AND resource_call_id=$2 ORDER BY idempotency_key LIMIT 201 FOR UPDATE',
      [tenantId, callId],
    )
  ).rows;
  if (receiptRows.length > privacyLimits.receiptsPerCall) fail('UNKNOWN_RECEIPT');
  const receipts = receiptRows.map((item) => ({
    key: z.string().min(1).max(250).parse(item.idempotency_key),
    fingerprint: z.string().min(1).max(250).parse(item.fingerprint),
    result: item.result,
  }));
  return { call: call.data, voice: voice?.success ? voice.data : null, inbox, handoff, receipts };
}
function closedEligible(bundle: Bundle, cutoffAt: string): boolean {
  const cutoff = Date.parse(cutoffAt);
  if (
    bundle.call.status === 'active' ||
    Date.parse(bundle.call.updatedAt) > cutoff ||
    bundle.inbox.some((item) => item.state !== 'CLOSED' || Date.parse(item.updatedAt) > cutoff)
  )
    return false;
  if (bundle.call.inboxItemId && !bundle.inbox.some((item) => item.id === bundle.call.inboxItemId))
    return false;
  if (bundle.call.mode === 'voice' && !bundle.voice) return false;
  if (
    bundle.voice &&
    (bundle.voice.state !== 'ENDED' ||
      !bundle.voice.endedAt ||
      Date.parse(bundle.voice.endedAt) > cutoff ||
      (bundle.voice.controlState !== null && bundle.voice.controlState !== 'COMPLETED'))
  )
    return false;
  return !bundle.handoff || Date.parse(bundle.handoff.createdAt) <= cutoff;
}
function minimizeCall(call: CallSession): CallSession {
  return {
    ...call,
    version: call.version + 1,
    draft: {},
    messages: [],
    proposal: null,
    outcome: null,
  };
}
function minimizeReceipt(
  key: string,
  result: unknown,
  call: CallSession,
  tenantId: string,
): unknown {
  if (key.startsWith(`turn:${call.id}:`) || key.startsWith(`confirm:${call.id}:`)) {
    const original = callSessionSchema.strict().safeParse(result);
    if (!original.success || original.data.id !== call.id) fail('UNKNOWN_RECEIPT');
    return {
      ...minimizeCall(original.data),
      status: call.status,
      phase: 'complete',
      inboxItemId: call.inboxItemId,
    };
  }
  if (key.startsWith(`voice:tool:${call.id}:`)) {
    const parsed = z
      .object({
        controlId: uuid,
        twiml: z.string().max(20_000),
        readbackText: z.string().max(3000).optional(),
      })
      .strict()
      .safeParse(result);
    if (!parsed.success) fail('UNKNOWN_RECEIPT');
    return { controlId: parsed.data.controlId, twiml: terminalTwiml };
  }
  if (/^voice:(?:confirmation|transfer-result):[a-f0-9]{64}$/.test(key)) {
    const parsed = z
      .object({ tenantId: uuid, twiml: z.string().max(20_000), outcome: z.string().nullable() })
      .strict()
      .safeParse(result);
    if (!parsed.success || parsed.data.tenantId !== tenantId) fail('UNKNOWN_RECEIPT');
    return { ...parsed.data, twiml: terminalTwiml, outcome: null };
  }
  if (/^voice:transfer-grant:[a-f0-9]{64}$/.test(key)) {
    const parsed = z
      .object({ providerCallSid: z.string().regex(/^CA[a-fA-F0-9]{32}$/), controlId: uuid })
      .strict()
      .safeParse(result);
    if (!parsed.success) fail('UNKNOWN_RECEIPT');
    return parsed.data;
  }
  return fail('UNKNOWN_RECEIPT');
}

export async function planPrivacyBatch(
  client: PrivacySqlClient,
  input: { tenantId: string; binding: RecoveryBinding; now: Date; limit?: number },
): Promise<DeletionDecision[]> {
  const tenantId = uuid.parse(input.tenantId),
    binding = recoveryBindingSchema.parse(input.binding);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(privacyLimits.batchCalls)
    .parse(input.limit ?? privacyLimits.batchCalls);
  if (!Number.isFinite(input.now.getTime())) fail('INVALID_TIME');
  await client.query('SELECT lock_privacy_tenant($1)', [tenantId]);
  const policy = await readPolicy(client, tenantId);
  if (!policy?.enabled) return [];
  // Old generic receipts may contain caller data but lack safe resource linkage.
  if (
    (
      await client.query(
        'SELECT 1 FROM receipts WHERE tenant_id=$1 AND resource_call_id IS NULL LIMIT 1',
        [tenantId],
      )
    ).rows.length
  )
    fail('LEGACY_RECEIPTS');
  const cutoffAt = new Date(
    input.now.getTime() - policy.closedAfterDays * 86_400_000,
  ).toISOString();
  const candidates = (
    await client.query(
      `SELECT c.id FROM calls c LEFT JOIN privacy_decisions d ON(d.tenant_id=c.tenant_id AND d.call_id=c.id) WHERE c.tenant_id=$1 AND c.document->>'status'<>'active' AND (c.document->>'updatedAt')::timestamptz<=$2 AND d.completed_at IS NULL AND d.admitted_at IS NULL AND NOT EXISTS(SELECT FROM privacy_holds h WHERE h.tenant_id=c.tenant_id AND h.call_id=c.id AND h.expires_at>$3) ORDER BY c.created_at,c.id LIMIT $4`,
      [tenantId, cutoffAt, input.now.toISOString(), limit],
    )
  ).rows;
  const decisions: DeletionDecision[] = [];
  for (const candidate of candidates) {
    const callId = uuid.parse(candidate.id),
      bundle = await loadBundle(client, tenantId, callId);
    if (!bundle || !closedEligible(bundle, cutoffAt)) continue;
    // Validate receipt support before a deletion decision reaches independent storage.
    for (const receipt of bundle.receipts)
      minimizeReceipt(receipt.key, receipt.result, bundle.call, tenantId);
    const prior = (
      await client.query(
        'SELECT document,admitted_at FROM privacy_decisions WHERE tenant_id=$1 AND call_id=$2 FOR UPDATE',
        [tenantId, callId],
      )
    ).rows[0];
    const previous = prior ? deletionDecisionSchema.parse(prior.document) : null;
    const compatible =
      previous &&
      sameBinding(binding, previous) &&
      previous.policyId === policy.policyId &&
      previous.policyVersion === policy.version;
    if (prior?.admitted_at && !compatible) fail('DECISION_BINDING_CHANGED');
    const decision =
      compatible && previous
        ? previous
        : deletionDecisionSchema.parse({
            ...binding,
            schemaVersion: 1,
            kind: 'MINIMIZE_CALLER_CONTENT',
            eventId: randomUUID(),
            tenantId,
            callId,
            policyId: policy.policyId,
            policyVersion: policy.version,
            cutoffAt,
            decidedAt: input.now.toISOString(),
          });
    if (
      !sameBinding(binding, decision) ||
      decision.policyId !== policy.policyId ||
      decision.policyVersion !== policy.version
    )
      fail('DECISION_BINDING_CHANGED');
    if (!prior)
      await client.query(
        'INSERT INTO privacy_decisions(tenant_id,call_id,event_id,document) VALUES($1,$2,$3,$4::jsonb)',
        [tenantId, callId, decision.eventId, JSON.stringify(decision)],
      );
    else if (!compatible) {
      const updated = await client.query(
        'UPDATE privacy_decisions SET event_id=$3,document=$4::jsonb WHERE tenant_id=$1 AND call_id=$2 AND admitted_at IS NULL',
        [tenantId, callId, decision.eventId, JSON.stringify(decision)],
      );
      if (updated.rowCount !== 1) fail('DECISION_BINDING_CHANGED');
    }
    decisions.push(decision);
  }
  return decisions;
}

export async function admitPrivacyDecision(
  client: PrivacySqlClient,
  input: { decision: DeletionDecision; binding: RecoveryBinding; now: Date },
): Promise<boolean> {
  const decision = deletionDecisionSchema.parse(input.decision),
    binding = recoveryBindingSchema.parse(input.binding);
  if (!sameBinding(decision, binding) || !Number.isFinite(input.now.getTime()))
    fail('DECISION_BINDING_CHANGED');
  await client.query('SELECT lock_privacy_tenant($1)', [decision.tenantId]);
  const row = (
    await client.query(
      'SELECT document,admitted_at FROM privacy_decisions WHERE tenant_id=$1 AND call_id=$2 FOR UPDATE',
      [decision.tenantId, decision.callId],
    )
  ).rows[0];
  if (
    !row ||
    deletionDecisionDigest(deletionDecisionSchema.parse(row.document)) !==
      deletionDecisionDigest(decision)
  )
    fail('DECISION_BINDING_CHANGED');
  if (row.admitted_at) return true;
  const policy = await readPolicy(client, decision.tenantId);
  if (
    !policy?.enabled ||
    policy.policyId !== decision.policyId ||
    policy.version !== decision.policyVersion
  )
    return false;
  if (
    (
      await client.query(
        'SELECT 1 FROM privacy_holds WHERE tenant_id=$1 AND call_id=$2 AND expires_at>$3',
        [decision.tenantId, decision.callId, input.now.toISOString()],
      )
    ).rows.length
  )
    return false;
  const bundle = await loadBundle(client, decision.tenantId, decision.callId);
  if (!bundle || !closedEligible(bundle, decision.cutoffAt)) return false;
  for (const receipt of bundle.receipts)
    minimizeReceipt(receipt.key, receipt.result, bundle.call, decision.tenantId);
  await client.query(
    'UPDATE privacy_decisions SET admitted_at=$3,admitted_policy_version=$4 WHERE tenant_id=$1 AND call_id=$2 AND admitted_at IS NULL',
    [decision.tenantId, decision.callId, input.now.toISOString(), policy.version],
  );
  return true;
}

export async function applyPrivacyDecision(
  client: PrivacySqlClient,
  input: {
    decision: DeletionDecision;
    acknowledgment: DeletionAcknowledgment;
    now: Date;
    mode: 'scheduled' | 'restore';
    binding: RecoveryBinding;
    replaySources?: RecoveryManifest['replaySources'];
  },
): Promise<'minimized' | 'held' | 'absent'> {
  const mode = z.enum(['scheduled', 'restore']).parse(input.mode),
    binding = recoveryBindingSchema.parse(input.binding);
  const decision = deletionDecisionSchema.parse(input.decision),
    ack = deletionAcknowledgmentSchema.parse(input.acknowledgment);
  if (
    decision.installationId !== binding.installationId ||
    (mode === 'scheduled'
      ? !sameBinding(binding, decision)
      : !input.replaySources?.some(
          (source) =>
            source.epoch === decision.epoch &&
            source.databaseResourceId === decision.databaseResourceId,
        ))
  )
    fail('DECISION_BINDING_CHANGED');
  if (ack.eventId !== decision.eventId || ack.decisionDigest !== deletionDecisionDigest(decision))
    fail('JOURNAL_ACK_MISMATCH');
  if (!Number.isFinite(input.now.getTime())) fail('INVALID_TIME');
  await client.query('SELECT lock_privacy_tenant($1)', [decision.tenantId]);
  if (
    (
      await client.query(
        'SELECT 1 FROM receipts WHERE tenant_id=$1 AND resource_call_id IS NULL LIMIT 1',
        [decision.tenantId],
      )
    ).rows.length
  )
    fail('LEGACY_RECEIPTS');
  const bundle = await loadBundle(client, decision.tenantId, decision.callId);
  if (!bundle) return 'absent';
  const prior = (
    await client.query(
      'SELECT document,admitted_at,admitted_policy_version,completed_at FROM privacy_decisions WHERE tenant_id=$1 AND call_id=$2 FOR UPDATE',
      [decision.tenantId, decision.callId],
    )
  ).rows[0];
  if (
    prior &&
    deletionDecisionDigest(deletionDecisionSchema.parse(prior.document)) !== ack.decisionDigest
  )
    fail('DECISION_BINDING_CHANGED');
  if (mode === 'scheduled') {
    if (!prior?.admitted_at) return 'held';
    // Admission is irrevocable. Policy/holds configured afterward stop new
    // admission but cannot revoke an already authorized journal decision.
    if (prior.completed_at) return 'minimized';
    if (!closedEligible(bundle, decision.cutoffAt)) fail('RESOURCE_CHANGED_AFTER_ADMISSION');
  }
  const receipts = bundle.receipts.map((receipt) => ({
    ...receipt,
    result: minimizeReceipt(receipt.key, receipt.result, bundle.call, decision.tenantId),
  }));
  const call = minimizeCall(bundle.call);
  await client.query(
    'UPDATE calls SET version=$3,document=$4::jsonb WHERE tenant_id=$1 AND id=$2',
    [decision.tenantId, decision.callId, call.version, JSON.stringify(call)],
  );
  for (const item of bundle.inbox) {
    const redacted = {
      ...item,
      version: item.version + 1,
      name: '',
      callbackNumber: '',
      reservation: null,
      message: null,
      bookingEvidence: null,
      guestNoticeNote: null,
      assignedTo: null,
    };
    await client.query(
      'UPDATE inbox SET version=$3,document=$4::jsonb WHERE tenant_id=$1 AND id=$2',
      [decision.tenantId, item.id, redacted.version, JSON.stringify(redacted)],
    );
  }
  if (bundle.voice) {
    const redacted = {
      ...bundle.voice,
      version: bundle.voice.version + 1,
      entryTwiml: terminalTwiml,
      controlTwiml: null,
      transferDestination: null,
      outcome: null,
    };
    await client.query(
      'UPDATE voice_calls SET version=$3,document=$4::jsonb WHERE tenant_id=$1 AND id=$2',
      [decision.tenantId, decision.callId, redacted.version, JSON.stringify(redacted)],
    );
  }
  if (bundle.handoff) {
    const redacted = { ...bundle.handoff, reason: 'other', summary: '' };
    await client.query(
      "UPDATE phone_handoffs SET reason='other',summary='',document=$3::jsonb WHERE tenant_id=$1 AND call_id=$2",
      [decision.tenantId, decision.callId, JSON.stringify(redacted)],
    );
  }
  for (const receipt of receipts)
    await client.query(
      'UPDATE receipts SET result=$3::jsonb WHERE tenant_id=$1 AND idempotency_key=$2',
      [decision.tenantId, receipt.key, JSON.stringify(receipt.result)],
    );
  await client.query(
    'INSERT INTO privacy_decisions(tenant_id,call_id,event_id,document,admitted_at,admitted_policy_version,journal_sequence,completed_at) VALUES($1,$2,$3,$4::jsonb,$6,$7,$5,$6) ON CONFLICT(tenant_id,call_id) DO UPDATE SET admitted_at=coalesce(privacy_decisions.admitted_at,EXCLUDED.admitted_at),admitted_policy_version=coalesce(privacy_decisions.admitted_policy_version,EXCLUDED.admitted_policy_version),journal_sequence=EXCLUDED.journal_sequence,completed_at=EXCLUDED.completed_at',
    [
      decision.tenantId,
      decision.callId,
      decision.eventId,
      JSON.stringify(decision),
      ack.sequence,
      input.now.toISOString(),
      decision.policyVersion,
    ],
  );
  return 'minimized';
}

export async function runPrivacyBatch(input: {
  persistence: PrivacyPersistence;
  binding: RecoveryBinding;
  authority?: RecoveryAuthority;
  tenantId: string;
  now: Date;
  limit?: number;
}): Promise<{
  planned: number;
  minimized: number;
  held: number;
  unavailable: number;
  needsReplay: boolean;
}> {
  const tenantId = uuid.parse(input.tenantId),
    binding = recoveryBindingSchema.parse(input.binding);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(privacyLimits.batchCalls)
    .parse(input.limit ?? privacyLimits.batchCalls);
  const initial = await input.persistence.withTenant(tenantId, async (client) => ({
    policy: await readPolicy(client, tenantId),
    pending: (
      await client.query(
        'SELECT document FROM privacy_decisions WHERE tenant_id=$1 AND admitted_at IS NOT NULL AND completed_at IS NULL ORDER BY admitted_at LIMIT $2',
        [tenantId, limit],
      )
    ).rows.map((row) => deletionDecisionSchema.parse(row.document)),
  }));
  const summary = { planned: 0, minimized: 0, held: 0, unavailable: 0, needsReplay: false };
  if (!initial.policy?.enabled && !initial.pending.length) return summary;
  const ready = await inspectRecoveryReadiness({
    binding,
    checkpoint: await input.persistence.readCheckpoint(binding.installationId),
    ...(input.authority ? { authority: input.authority } : {}),
  });
  const authority = input.authority;
  if (!ready.ready || !authority) fail('RECOVERY_QUARANTINED');
  const pending = initial.pending;
  if (pending.some((decision) => !sameBinding(decision, binding))) fail('DECISION_BINDING_CHANGED');
  const planned =
    initial.policy?.enabled && pending.length < limit
      ? await input.persistence.withTenant(tenantId, (client) =>
          planPrivacyBatch(client, {
            tenantId,
            binding,
            now: input.now,
            limit: limit - pending.length,
          }),
        )
      : [];
  const decisions = [...pending, ...planned];
  summary.planned = decisions.length;
  for (const decision of decisions) {
    try {
      const admitted = await input.persistence.withTenant(tenantId, (client) =>
        admitPrivacyDecision(client, { decision, binding, now: input.now }),
      );
      if (!admitted) {
        summary.held++;
        continue;
      }
      const acknowledgment = deletionAcknowledgmentSchema.parse(
        await authorityCall((signal) => authority.appendDeletion(decision, signal)),
      );
      const result = await input.persistence.withTenant(tenantId, (client) =>
        applyPrivacyDecision(client, {
          decision,
          acknowledgment,
          binding,
          now: input.now,
          mode: 'scheduled',
        }),
      );
      if (result === 'minimized') summary.minimized++;
      else summary.held++;
    } catch {
      summary.unavailable++;
    }
  }
  const after = await inspectRecoveryReadiness({
    binding,
    checkpoint: await input.persistence.readCheckpoint(binding.installationId),
    authority,
  });
  summary.needsReplay = !after.ready;
  return summary;
}

export async function readRecoveryDeletionPage(
  authority: RecoveryAuthority,
  input: { installationId: string; epoch: string; afterSequence: number; limit?: number },
): Promise<DeletionPage> {
  const installationId = uuid.parse(input.installationId),
    epoch = uuid.parse(input.epoch),
    afterSequence = counter.parse(input.afterSequence),
    limit = z
      .number()
      .int()
      .min(1)
      .max(privacyLimits.batchCalls)
      .parse(input.limit ?? privacyLimits.batchCalls);
  const page = deletionPageSchema.parse(
    await authorityCall((signal) =>
      authority.readDeletions({ installationId, epoch, afterSequence, limit }, signal),
    ),
  );
  if (
    page.installationId !== installationId ||
    page.epoch !== epoch ||
    page.afterSequence !== afterSequence ||
    page.entries.length > limit ||
    page.throughSequence < afterSequence
  )
    fail('JOURNAL_PAGE_MISMATCH');
  const manifest = await readRecoveryManifest(authority, installationId);
  if (
    manifest.epoch !== epoch ||
    !manifest.coverageComplete ||
    !manifest.securityReauthorized ||
    manifest.coverageStartSequence > afterSequence + 1 ||
    page.throughSequence > manifest.throughSequence
  )
    fail('RECOVERY_QUARANTINED');
  for (let index = 0; index < page.entries.length; index++) {
    const entry = page.entries[index];
    if (
      !entry ||
      entry.sequence !== afterSequence + index + 1 ||
      entry.sequence > page.throughSequence ||
      entry.decision.installationId !== installationId ||
      !manifest.replaySources.some(
        (source) =>
          source.epoch === entry.decision.epoch &&
          source.databaseResourceId === entry.decision.databaseResourceId,
      ) ||
      deletionDecisionDigest(entry.decision) !== entry.decisionDigest
    )
      fail('JOURNAL_GAP');
  }
  if (
    page.hasMore !== afterSequence + page.entries.length < page.throughSequence ||
    (!page.entries.length && page.hasMore)
  )
    fail('JOURNAL_GAP');
  return page;
}

/** Explicit operator replay. Partial completion remains quarantined. */
export async function replayRecoveryJournal(input: {
  persistence: PrivacyOperatorPersistence;
  authority: RecoveryAuthority;
  binding: RecoveryBinding;
  now: Date;
  mode: 'scheduled' | 'restore';
  maxPages?: number;
}): Promise<{
  replayed: number;
  throughSequence: number;
  complete: boolean;
  checkpoint: RecoveryCheckpoint;
}> {
  const binding = recoveryBindingSchema.parse(input.binding),
    mode = z.enum(['scheduled', 'restore']).parse(input.mode),
    maxPages = z
      .number()
      .int()
      .min(1)
      .max(20)
      .parse(input.maxPages ?? 4);
  let checkpoint = await input.persistence.readCheckpoint(binding.installationId);
  let manifest = await readRecoveryManifest(input.authority, binding.installationId);
  if (
    !sameBinding(binding, manifest) ||
    !manifest.securityReauthorized ||
    !manifest.coverageComplete
  )
    fail('RECOVERY_QUARANTINED');
  const matches =
    checkpoint &&
    sameBinding(binding, checkpoint) &&
    checkpoint.securityVersion === manifest.securityVersion;
  if (mode === 'scheduled' && !matches) fail('RECOVERY_QUARANTINED');
  let cursor = matches && checkpoint ? checkpoint.appliedThroughSequence : 0;
  if (cursor > manifest.throughSequence || manifest.coverageStartSequence > cursor + 1)
    fail('JOURNAL_GAP');
  let replayed = 0;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const page = await readRecoveryDeletionPage(input.authority, {
      installationId: binding.installationId,
      epoch: binding.epoch,
      afterSequence: cursor,
    });
    for (const entry of page.entries) {
      const result = await input.persistence.withTenant(entry.decision.tenantId, (client) =>
        applyPrivacyDecision(client, {
          decision: entry.decision,
          acknowledgment: {
            eventId: entry.decision.eventId,
            sequence: entry.sequence,
            decisionDigest: entry.decisionDigest,
          },
          binding,
          replaySources: manifest.replaySources,
          now: input.now,
          mode,
        }),
      );
      if (result === 'held') fail('JOURNAL_REPLAY_HELD');
      cursor = entry.sequence;
      replayed++;
    }
    const current = await readRecoveryManifest(input.authority, binding.installationId);
    if (
      !sameBinding(binding, current) ||
      !current.securityReauthorized ||
      !current.coverageComplete ||
      current.securityVersion !== manifest.securityVersion ||
      cursor > current.throughSequence ||
      current.coverageStartSequence > cursor + 1
    )
      fail('RECOVERY_QUARANTINED');
    const next: RecoveryCheckpoint = {
      ...binding,
      securityVersion: current.securityVersion,
      appliedThroughSequence: cursor,
    };
    await input.persistence.withControl(async (client) => {
      if (checkpoint) {
        const result = await client.query(
          'UPDATE recovery_checkpoints SET epoch=$2,database_resource_id=$3,security_version=$4,applied_through_sequence=$5,updated_at=$6 WHERE installation_id=$1 AND epoch=$7 AND database_resource_id=$8 AND security_version=$9 AND applied_through_sequence=$10',
          [
            binding.installationId,
            binding.epoch,
            binding.databaseResourceId,
            current.securityVersion,
            cursor,
            input.now.toISOString(),
            checkpoint.epoch,
            checkpoint.databaseResourceId,
            checkpoint.securityVersion,
            checkpoint.appliedThroughSequence,
          ],
        );
        if (result.rowCount !== 1) fail('CHECKPOINT_CONFLICT');
      } else {
        const result = await client.query(
          'INSERT INTO recovery_checkpoints(installation_id,epoch,database_resource_id,security_version,applied_through_sequence,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(installation_id) DO NOTHING',
          [
            binding.installationId,
            binding.epoch,
            binding.databaseResourceId,
            current.securityVersion,
            cursor,
            input.now.toISOString(),
          ],
        );
        if (result.rowCount !== 1) fail('CHECKPOINT_CONFLICT');
      }
    });
    checkpoint = next;
    manifest = current;
    if (cursor === current.throughSequence)
      return { replayed, throughSequence: cursor, complete: true, checkpoint: next };
  }
  if (!checkpoint) fail('CHECKPOINT_CONFLICT');
  return { replayed, throughSequence: cursor, complete: false, checkpoint };
}
