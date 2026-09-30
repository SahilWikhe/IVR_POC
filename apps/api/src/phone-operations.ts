import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  phoneCallDetailSchema,
  phoneCallSummarySchema,
  phoneOperationsSchema,
  phonePolicySchema,
  phoneReconcileResultSchema,
  updatePhonePolicyInputSchema,
  type PhoneCallSummary,
  type VoiceCallRecord,
} from '@hostline/contracts';
import {
  callStatusResultSchema,
  createCallStatusReader,
  isTerminalProviderStatus,
  type CallStatusReader,
} from '@hostline/connectors';
import type { AppConfig } from '@hostline/config';
import type { Database, TenantTransaction } from '@hostline/database';
import type { AuthService } from './auth.js';
import { withStaffTenant } from './auth-transaction.js';

class PhoneOperationsError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const callParams = z.object({ id: z.uuid() }).strict();
const versionInput = z.object({ expectedVersion: z.number().int().positive() }).strict();
const pagination = z
  .object({
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();

function summary(record: VoiceCallRecord, now = new Date()): PhoneCallSummary {
  const capacityHeld = record.state !== 'ENDED';
  return phoneCallSummarySchema.parse({
    id: record.id,
    version: record.version,
    state: record.state,
    controlKind: record.controlKind,
    controlState: record.controlState,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
    outcome: record.outcome,
    capacityHeld,
    requiresReconciliation:
      capacityHeld &&
      (record.state === 'NEEDS_RECONCILIATION' ||
        record.controlState === 'UNKNOWN' ||
        Date.parse(record.leaseExpiresAt) <= now.getTime()),
  });
}

async function requiredVoiceCall(tx: TenantTransaction, id: string) {
  const record = await tx.getVoiceCallById(id);
  if (!record) throw new PhoneOperationsError('NOT_FOUND', 404, 'Phone call not found.');
  return record;
}

export async function registerPhoneOperations(
  app: FastifyInstance,
  config: AppConfig,
  db: Database,
  auth: AuthService,
  dependencies: { callStatusReader?: CallStatusReader } = {},
) {
  // Disabled voice flags can still permit read-only status reconciliation. A
  // missing secret leaves the feature unavailable and never starts SDK traffic.
  const reader =
    dependencies.callStatusReader ??
    (config.voice.accountSid && config.voice.authToken
      ? createCallStatusReader({
          accountSid: config.voice.accountSid,
          authToken: config.voice.authToken,
        })
      : undefined);
  const configured = {
    voiceEnabled: config.voice.enabled,
    requestsEnabled: config.voice.enabled && config.voice.actionsEnabled,
    transfersEnabled: config.voice.enabled && config.voice.transfersEnabled,
    reconciliationAvailable: !!reader && !!config.voice.accountSid && !!config.voiceTenantId,
  };

  app.get('/api/phone/operations', async (request) => {
    const user = auth.actor(request);
    const query = pagination.parse(request.query);
    return withStaffTenant(auth, db, config.auth.mode, request, user, async (tx) => {
      await tx.lockVoiceAdmission();
      const policy = await tx.getPhonePolicy();
      const records = await tx.listVoiceCalls({ offset: query.offset, limit: query.limit + 1 });
      return phoneOperationsSchema.parse({
        policy,
        configured: {
          ...configured,
          voiceEnabled: configured.voiceEnabled && user.tenantId === config.voiceTenantId,
          requestsEnabled: configured.requestsEnabled && user.tenantId === config.voiceTenantId,
          transfersEnabled: configured.transfersEnabled && user.tenantId === config.voiceTenantId,
          reconciliationAvailable:
            configured.reconciliationAvailable && user.tenantId === config.voiceTenantId,
        },
        calls: records.slice(0, query.limit).map((record) => summary(record)),
        hasMore: records.length > query.limit,
      });
    });
  });

  app.get('/api/phone/calls/:id', async (request) => {
    const user = auth.requireRole(request, ['owner', 'staff']);
    const { id } = callParams.parse(request.params);
    return withStaffTenant(auth, db, config.auth.mode, request, user, async (tx) => {
      await tx.lockVoiceAdmission();
      const record = await requiredVoiceCall(tx, id);
      const call = await tx.getCall(id);
      if (!call || call.mode !== 'voice')
        throw new PhoneOperationsError('NOT_FOUND', 404, 'Phone call not found.');
      const context = await tx.getHandoff(id);
      const pending = call.proposal;
      return phoneCallDetailSchema.parse({
        call: summary(record),
        context: context ? { ...context, source: 'AI_UNTRUSTED' } : null,
        pendingProposal: pending
          ? {
              id: pending.id,
              kind: pending.kind,
              readback: pending.readback,
              expiresAt: pending.expiresAt,
              reservation: pending.reservation,
              message: pending.message,
            }
          : null,
        savedItem: call.inboxItemId ? await tx.getInbox(call.inboxItemId) : null,
      });
    });
  });

  app.put('/api/phone/policy', async (request) => {
    const user = auth.requireRole(request, ['owner']);
    const input = updatePhonePolicyInputSchema.parse(request.body);
    return withStaffTenant(auth, db, config.auth.mode, request, user, async (tx) => {
      await tx.lockVoiceAdmission();
      const previous = await tx.getPhonePolicy();
      if (previous.version !== input.expectedVersion)
        throw new PhoneOperationsError(
          'VERSION_CONFLICT',
          409,
          'Phone settings changed. Refresh and try again.',
        );
      const next = phonePolicySchema.parse({
        ...input.policy,
        version: previous.version + 1,
        updatedAt: new Date().toISOString(),
      });
      await tx.savePhonePolicy(next, previous.version);
      await tx.audit(user.userId, 'phone.policy_updated', user.tenantId);
      return next;
    });
  });

  app.post('/api/phone/calls/:id/reconcile', async (request) => {
    const user = auth.requireRole(request, ['owner']);
    const { id } = callParams.parse(request.params);
    const input = versionInput.parse(request.body);
    const admitted = await withStaffTenant(
      auth,
      db,
      config.auth.mode,
      request,
      user,
      async (tx) => {
        await tx.lockVoiceAdmission();
        const record = await requiredVoiceCall(tx, id);
        if (record.state === 'ENDED') return record;
        if (record.version !== input.expectedVersion)
          throw new PhoneOperationsError(
            'VERSION_CONFLICT',
            409,
            'This call changed. Refresh before checking again.',
          );
        if (
          !configured.reconciliationAvailable ||
          user.tenantId !== config.voiceTenantId ||
          record.accountSid !== config.voice.accountSid
        )
          throw new PhoneOperationsError(
            'RECONCILIATION_UNAVAILABLE',
            409,
            'Provider status checking is unavailable for this restaurant.',
          );
        await tx.audit(user.userId, 'phone.reconciliation_requested', id);
        return record;
      },
    );
    if (admitted.state === 'ENDED')
      return phoneReconcileResultSchema.parse({
        call: summary(admitted),
        result: 'ended',
        message: 'Provider termination is already recorded. Capacity is released.',
      });

    // No database transaction spans provider I/O. The reader can only perform
    // bounded GETs; exact server-held identities never come from browser input.
    let raw: unknown;
    try {
      raw = await reader?.read({
        accountSid: admitted.accountSid,
        callSid: admitted.providerCallSid,
        includeChildren: true,
      });
    } catch {
      raw = { outcome: 'unavailable' };
    }
    const parsed = callStatusResultSchema.safeParse(raw);
    const evidence = parsed.success ? parsed.data : { outcome: 'unavailable' as const };
    const bound =
      evidence.outcome === 'known' &&
      evidence.accountSid === admitted.accountSid &&
      evidence.callSid === admitted.providerCallSid &&
      new Set(evidence.children.map((child) => child.callSid)).size === evidence.children.length &&
      evidence.children.every((child) => child.callSid !== evidence.callSid);

    return withStaffTenant(auth, db, config.auth.mode, request, user, async (tx) => {
      await tx.lockVoiceAdmission();
      const record = await requiredVoiceCall(tx, id);
      if (record.state === 'ENDED')
        return phoneReconcileResultSchema.parse({
          call: summary(record),
          result: 'ended',
          message: 'Provider termination is already recorded. Capacity is released.',
        });
      if (
        record.version !== admitted.version ||
        record.generation !== admitted.generation ||
        record.accountSid !== admitted.accountSid ||
        record.providerCallSid !== admitted.providerCallSid ||
        record.accountSid !== config.voice.accountSid ||
        user.tenantId !== config.voiceTenantId
      )
        throw new PhoneOperationsError(
          'VERSION_CONFLICT',
          409,
          'This call changed while provider status was checked. Capacity remains held.',
        );

      const complete =
        bound &&
        evidence.outcome === 'known' &&
        isTerminalProviderStatus(evidence.status) &&
        evidence.childrenComplete &&
        evidence.children.every((child) => isTerminalProviderStatus(child.status)) &&
        (!record.transferChildSid ||
          evidence.children.some((child) => child.callSid === record.transferChildSid));
      const now = new Date();
      const outcome = complete
        ? 'Provider status verified that the phone call and all listed child calls ended.'
        : bound
          ? 'Provider termination is not fully verified. Capacity remains held.'
          : 'Provider status could not be verified. Capacity remains held.';
      const next: VoiceCallRecord = {
        ...record,
        version: record.version + 1,
        updatedAt: now.toISOString(),
        ...(complete
          ? {
              state: 'ENDED',
              endedAt: now.toISOString(),
              outcome,
              streamSid: null,
              proposalId: null,
              controlState: record.controlId ? 'COMPLETED' : null,
            }
          : {}),
      };
      if (complete) {
        const call = await tx.getCall(id);
        if (!call || call.mode !== 'voice')
          throw new PhoneOperationsError('NOT_FOUND', 404, 'Phone call not found.');
        await tx.saveCall(
          {
            ...call,
            version: call.version + 1,
            status: call.inboxItemId ? call.status : 'ended',
            phase: 'complete',
            proposal: null,
            draft: {},
            messages: [],
            updatedAt: now.toISOString(),
            outcome: call.inboxItemId ? call.outcome : 'Phone call ended without a new request.',
          },
          call.version,
        );
      }
      await tx.saveVoiceCall(next, record.version);
      await tx.audit(
        user.userId,
        complete ? 'phone.reconciliation_ended' : 'phone.reconciliation_held',
        id,
      );
      return phoneReconcileResultSchema.parse({
        call: summary(next),
        result: complete ? 'ended' : bound ? 'held' : 'unavailable',
        message: outcome,
      });
    });
  });
}
