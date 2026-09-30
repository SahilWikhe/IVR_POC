import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import twilio from 'twilio';
import { z } from 'zod';
import {
  providerAccountSidSchema,
  providerCallSidSchema,
  providerStreamSidSchema,
  voiceProposalInputSchema,
  type CallSession,
  type Restaurant,
  type PhonePolicy,
  type VoiceCallRecord,
} from '@hostline/contracts';
import {
  confirmVoiceProposal,
  createVoiceSession,
  prepareVoiceProposal,
  DomainError,
} from '@hostline/domain';
import { buildReadbackTwiml, buildTransferTwiml, TelephonyInputError } from '@hostline/connectors';
import type { AppConfig } from '@hostline/config';
import type { Database, TenantTransaction } from '@hostline/database';

class VoiceError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const binding = { providerCallSid: providerCallSidSchema, generation: z.uuid() };
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const toolId = z.string().min(1).max(128);
const callbackResultSchema = z.object({
  tenantId: z.uuid(),
  twiml: z.string(),
  outcome: z.string().nullable(),
});
const transferGrantSchema = z.object({
  providerCallSid: providerCallSidSchema,
  controlId: z.uuid(),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value: unknown) => hash(JSON.stringify(value));
const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

function hangup(
  message = 'This call has ended. Please contact the restaurant directly if you still need help.',
) {
  const response = new twilio.twiml.VoiceResponse();
  response.say({ language: 'en-US' }, message);
  response.hangup();
  return response.toString();
}
function streamTwiml(publicUrl: string, grant: string, message?: string) {
  const response = new twilio.twiml.VoiceResponse();
  if (message) response.say({ language: 'en-US' }, message);
  response
    .connect()
    .stream({ url: `${publicUrl.replace(/^https:/, 'wss:')}/twilio/media` })
    .parameter({ name: 'grant', value: grant });
  response.say(
    { language: 'en-US' },
    'The assistant is unavailable. Please contact the restaurant directly.',
  );
  response.hangup();
  return response.toString();
}
async function callFor(tx: TenantTransaction, record: VoiceCallRecord) {
  const call = await tx.getCall(record.id);
  if (!call || call.mode !== 'voice')
    throw new VoiceError('CALL_NOT_FOUND', 404, 'Phone call not found.');
  return call;
}
async function saveRecord(
  tx: TenantTransaction,
  record: VoiceCallRecord,
  patch: Partial<VoiceCallRecord>,
  now: Date,
) {
  const next = { ...record, ...patch, version: record.version + 1, updatedAt: now.toISOString() };
  await tx.saveVoiceCall(next, record.version);
  return next;
}
async function clearProposal(tx: TenantTransaction, call: CallSession, now: Date, outcome: string) {
  await tx.saveCall(
    {
      ...call,
      version: call.version + 1,
      proposal: null,
      messages: [],
      draft: {},
      phase: call.inboxItemId ? 'complete' : 'idle',
      outcome,
      updatedAt: now.toISOString(),
    },
    call.version,
  );
}
function assertGeneration(record: VoiceCallRecord, generation: string) {
  if (record.generation !== generation)
    throw new VoiceError('STALE_GENERATION', 409, 'This phone session is no longer current.');
}
function assertStreaming(record: VoiceCallRecord, generation: string, now: Date) {
  assertGeneration(record, generation);
  if (record.state !== 'STREAMING' || Date.parse(record.leaseExpiresAt) <= now.getTime())
    throw new VoiceError('CALL_NOT_ACTIVE', 409, 'This phone call is not accepting a new action.');
}
function permittedDestination(restaurant: Restaurant, config: AppConfig) {
  const destination = restaurant.transferNumber;
  if (
    !config.voice.transfersEnabled ||
    !restaurant.transferEnabled ||
    !destination ||
    destination === restaurant.publicPhone ||
    destination === config.twilioPhoneNumber
  )
    throw new VoiceError(
      'TRANSFER_UNAVAILABLE',
      403,
      'Staff transfer is unavailable for this call.',
    );
  return destination;
}
function eligibleCallback(record: VoiceCallRecord, grant: string, kind: 'readback' | 'transfer') {
  if (
    record.controlKind !== kind ||
    !record.controlId ||
    !record.confirmationGrantHash ||
    !equal(record.confirmationGrantHash, hash(grant)) ||
    !['DISPATCHED', 'ACCEPTED', 'UNKNOWN', 'COMPLETED'].includes(record.controlState ?? '')
  )
    throw new VoiceError(
      'INVALID_CALLBACK',
      403,
      'This callback is not authorized for this phone action.',
    );
}

/** Authority is the authenticated gateway plus durable call state, never model arguments. */
export async function registerVoiceActions(app: FastifyInstance, config: AppConfig, db: Database) {
  const scoped = async <T>(
    request: FastifyRequest,
    work: (tx: TenantTransaction, now: Date) => Promise<T>,
  ) => {
    if (
      !config.voiceServiceToken ||
      !config.voiceTenantId ||
      !equal(request.headers.authorization ?? '', `Bearer ${config.voiceServiceToken}`)
    )
      throw new VoiceError('UNAUTHORIZED', 401, 'Unauthorized.');
    if (!config.voice.enabled || !config.voice.publicUrl || !config.voice.accountSid)
      throw new VoiceError('VOICE_DISABLED', 403, 'Phone actions are disabled.');
    return db.withTenant(config.voiceTenantId, async (tx) => {
      // Lock restaurant admission before voice/call rows on every lifecycle path.
      await tx.lockVoiceAdmission();
      return work(tx, new Date());
    });
  };
  const boundRecord = async (tx: TenantTransaction, sid: string) => {
    const record = await tx.getVoiceCall(sid);
    if (record && record.accountSid !== config.voice.accountSid)
      throw new VoiceError('ACCOUNT_MISMATCH', 403, 'Phone account mismatch.');
    return record;
  };
  const recordFor = async (tx: TenantTransaction, sid: string) => {
    const record = await boundRecord(tx, sid);
    if (!record) throw new VoiceError('CALL_NOT_FOUND', 404, 'Phone call not found.');
    return record;
  };
  const currentPolicy = async (
    tx: TenantTransaction,
    record?: VoiceCallRecord,
  ): Promise<PhonePolicy> => {
    const policy = await tx.getPhonePolicy();
    if (!policy.voiceEnabled || (record && (record.policyVersion ?? 1) !== policy.version))
      throw new VoiceError(
        'PHONE_POLICY_REVOKED',
        403,
        'This phone session has been disabled. Please start a new call after restaurant approval.',
      );
    return policy;
  };
  const tenantId = () => z.uuid().parse(config.voiceTenantId);
  const publicUrl = () => z.url().parse(config.voice.publicUrl);
  const deadline = (record: VoiceCallRecord) =>
    Date.parse(record.createdAt) + config.voice.maxCallSeconds * 1000;
  const remaining = (record: VoiceCallRecord, now: Date) =>
    Math.floor((deadline(record) - now.getTime()) / 1000);
  const newRecord = async (tx: TenantTransaction, sid: string, now: Date, terminal = false) => {
    const call = createVoiceSession(await tx.getRestaurant(), now);
    const grant = token();
    const record: VoiceCallRecord = {
      id: call.id,
      providerCallSid: sid,
      accountSid: providerAccountSidSchema.parse(config.voice.accountSid),
      version: 1,
      policyVersion: (await tx.getPhonePolicy()).version,
      state: terminal ? 'ENDED' : 'WAITING_FOR_STREAM',
      generation: randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + config.voice.maxCallSeconds * 1000).toISOString(),
      streamSid: null,
      streamGrantHash: hash(grant),
      streamGrantExpiresAt: new Date(
        now.getTime() + Math.min(30, config.voice.maxCallSeconds) * 1000,
      ).toISOString(),
      entryTwiml: terminal
        ? hangup()
        : streamTwiml(
            publicUrl(),
            grant,
            'You are speaking with an AI restaurant assistant. Requests are subject to staff review and do not confirm a reservation.',
          ),
      controlId: null,
      controlKind: null,
      controlState: null,
      controlTwiml: null,
      confirmationGrantHash: null,
      confirmationExpiresAt: null,
      proposalId: null,
      transferDestination: null,
      transferChildSid: null,
      outcome: terminal ? 'Call ended before voice admission.' : null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      endedAt: terminal ? now.toISOString() : null,
    };
    await tx.insertCall(
      terminal ? { ...call, status: 'ended', phase: 'complete', outcome: record.outcome } : call,
    );
    await tx.insertVoiceCall(record);
    return record;
  };
  const callbackResult = (record: VoiceCallRecord, twiml: string) => ({
    tenantId: tenantId(),
    twiml,
    outcome: record.outcome,
  });
  const resume = async (
    tx: TenantTransaction,
    record: VoiceCallRecord,
    now: Date,
    outcome: string,
  ) => {
    if (record.state === 'ENDED') return callbackResult(record, hangup());
    const policy = await tx.getPhonePolicy();
    if (
      remaining(record, now) < 15 ||
      !policy.voiceEnabled ||
      (record.policyVersion ?? 1) !== policy.version
    ) {
      const next = await saveRecord(
        tx,
        record,
        { state: 'NEEDS_RECONCILIATION', controlState: 'COMPLETED', outcome },
        now,
      );
      return callbackResult(next, hangup(outcome));
    }
    const grant = token();
    const twiml = streamTwiml(publicUrl(), grant, outcome);
    const next = await saveRecord(
      tx,
      record,
      {
        state: 'WAITING_FOR_STREAM',
        generation: randomUUID(),
        streamSid: null,
        streamGrantHash: hash(grant),
        streamGrantExpiresAt: new Date(
          Math.min(now.getTime() + 30_000, deadline(record)),
        ).toISOString(),
        controlState: 'COMPLETED',
        outcome,
      },
      now,
    );
    return callbackResult(next, twiml);
  };
  const receiptResult = async (tx: TenantTransaction, key: string, input: unknown) => {
    const receipt = await tx.getReceipt(key);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint(input))
      throw new VoiceError(
        'IDEMPOTENCY_CONFLICT',
        409,
        'This callback contains different details.',
      );
    return receipt.result;
  };

  app.post('/internal/voice/admit', (request) =>
    scoped(request, async (tx, now) => {
      const input = z
        .object({ providerCallSid: providerCallSidSchema, accountSid: providerAccountSidSchema })
        .strict()
        .parse(request.body);
      if (input.accountSid !== config.voice.accountSid)
        throw new VoiceError('ACCOUNT_MISMATCH', 403, 'Phone account mismatch.');
      let record = await boundRecord(tx, input.providerCallSid);
      if (record?.state !== 'ENDED') await currentPolicy(tx, record ?? undefined);
      if (!record) {
        if ((await tx.countActiveVoiceCalls(now)) >= config.voice.maxConcurrentCalls)
          throw new VoiceError('CAPACITY_EXCEEDED', 429, 'The assistant is at capacity.');
        record = await newRecord(tx, input.providerCallSid, now);
      }
      return {
        voiceCallId: record.id,
        generation: record.generation,
        tenantId: tenantId(),
        twiml: record.state === 'ENDED' ? hangup() : record.entryTwiml,
        state: record.state,
      };
    }),
  );
  app.post('/internal/voice/redeem', (request) =>
    scoped(request, async (tx, now) => {
      const input = z
        .object({
          providerCallSid: providerCallSidSchema,
          streamSid: providerStreamSidSchema,
          streamGrant: tokenSchema,
        })
        .strict()
        .parse(request.body);
      const record = await recordFor(tx, input.providerCallSid);
      const policy = await currentPolicy(tx, record);
      if (
        record.state !== 'WAITING_FOR_STREAM' ||
        Date.parse(record.streamGrantExpiresAt) <= now.getTime() ||
        remaining(record, now) <= 0 ||
        !equal(record.streamGrantHash, hash(input.streamGrant))
      )
        throw new VoiceError('INVALID_STREAM_GRANT', 403, 'This media stream is not authorized.');
      const next = await saveRecord(
        tx,
        record,
        { state: 'STREAMING', streamSid: input.streamSid },
        now,
      );
      const restaurant = await tx.getRestaurant();
      const call = await callFor(tx, next);
      return {
        voiceCallId: next.id,
        generation: next.generation,
        expiresAt: next.leaseExpiresAt,
        tenantId: tenantId(),
        restaurant,
        configurationVersion: restaurant.version,
        outcome: next.outcome,
        actionsEnabled:
          config.voice.actionsEnabled && policy.requestsEnabled && call.inboxItemId === null,
        transfersEnabled: config.voice.transfersEnabled && policy.transfersEnabled,
      };
    }),
  );
  app.post(
    '/internal/voice/policy',
    {
      config: {
        rateLimit: { max: config.voice.maxConcurrentCalls * 90 + 60, timeWindow: '1 minute' },
      },
    },
    (request) =>
      scoped(request, async (tx, now) => {
        const input = z.object(binding).strict().parse(request.body);
        const record = await recordFor(tx, input.providerCallSid);
        const policy = await tx.getPhonePolicy();
        const restaurant = await tx.getRestaurant();
        const call = await callFor(tx, record);
        const allowed =
          policy.voiceEnabled &&
          (record.policyVersion ?? 1) === policy.version &&
          record.generation === input.generation &&
          record.state === 'STREAMING' &&
          remaining(record, now) > 0;
        return {
          allowed,
          configurationVersion: restaurant.version,
          actionsEnabled:
            allowed &&
            config.voice.actionsEnabled &&
            policy.requestsEnabled &&
            call.inboxItemId === null,
          transfersEnabled: allowed && config.voice.transfersEnabled && policy.transfersEnabled,
        };
      }),
  );
  app.post('/internal/voice/end', (request) =>
    scoped(request, async (tx, now) => {
      const input = z
        .object({
          providerCallSid: providerCallSidSchema,
          generation: z.uuid().optional(),
          reason: z.enum(['stream_closed', 'provider_terminal']),
        })
        .strict()
        .parse(request.body);
      let record = await boundRecord(tx, input.providerCallSid);
      if (!record) {
        if (input.reason !== 'provider_terminal')
          throw new VoiceError('CALL_NOT_FOUND', 404, 'Phone call not found.');
        record = await newRecord(tx, input.providerCallSid, now, true);
      }
      if (input.reason === 'stream_closed') {
        if (!input.generation)
          throw new VoiceError('MISSING_GENERATION', 400, 'A stream generation is required.');
        if (
          record.generation !== input.generation ||
          record.state === 'ENDED' ||
          (record.controlState === 'COMPLETED' && record.state === 'WAITING_FOR_STREAM')
        )
          return { state: record.state };
        if (
          record.controlId &&
          ['DISPATCHED', 'ACCEPTED', 'UNKNOWN'].includes(record.controlState ?? '')
        )
          return { state: record.state };
        const call = await callFor(tx, record);
        await clearProposal(
          tx,
          call,
          now,
          'Voice connection closed without submitting a new request.',
        );
        record = await saveRecord(
          tx,
          record,
          {
            state: 'NEEDS_RECONCILIATION',
            outcome: 'Voice connection closed; provider termination is unverified.',
          },
          now,
        );
      } else if (record.state !== 'ENDED') {
        const call = await callFor(tx, record);
        await tx.saveCall(
          {
            ...call,
            version: call.version + 1,
            status: call.inboxItemId ? call.status : 'ended',
            phase: 'complete',
            proposal: null,
            messages: [],
            draft: {},
            updatedAt: now.toISOString(),
            outcome: call.inboxItemId
              ? call.outcome
              : 'Phone call ended without submitting a new request.',
          },
          call.version,
        );
        record = await saveRecord(
          tx,
          record,
          {
            state: 'ENDED',
            endedAt: now.toISOString(),
            outcome: call.inboxItemId ? call.outcome : 'Phone call ended.',
          },
          now,
        );
      }
      return { state: record.state };
    }),
  );

  app.post('/internal/voice/propose', (request) =>
    scoped(request, async (tx, now) => {
      const input = z
        .object({
          ...binding,
          toolCallId: toolId,
          utteranceStartedAt: z.iso.datetime({ offset: true }),
          proposal: voiceProposalInputSchema,
        })
        .strict()
        .parse(request.body);
      if (!config.voice.actionsEnabled)
        throw new VoiceError('ACTIONS_DISABLED', 403, 'Phone request submission is disabled.');
      const record = await recordFor(tx, input.providerCallSid);
      const policy = await currentPolicy(tx, record);
      if (!policy.requestsEnabled)
        throw new VoiceError('ACTIONS_DISABLED', 403, 'Phone request submission is disabled.');
      assertGeneration(record, input.generation);
      const key = `voice:tool:${record.id}:${input.toolCallId}`;
      const receipt = await receiptResult(tx, key, input);
      if (receipt) return receipt;
      assertStreaming(record, input.generation, now);
      const call = await callFor(tx, record),
        restaurant = await tx.getRestaurant();
      const nextCall = prepareVoiceProposal(
        call,
        restaurant,
        input.proposal,
        new Date(input.utteranceStartedAt),
        now,
      );
      if (!nextCall.proposal)
        throw new VoiceError('INVALID_PROPOSAL', 400, 'No request was prepared.');
      const grant = token(),
        controlId = randomUUID();
      let twiml: string;
      try {
        twiml = buildReadbackTwiml({
          publicUrl: publicUrl(),
          confirmationToken: grant,
          readback: nextCall.proposal.readback,
        });
      } catch (error) {
        if (error instanceof TelephonyInputError)
          throw new VoiceError(
            'READBACK_TOO_LONG',
            400,
            'Please shorten the message or notes and try again.',
          );
        throw error;
      }
      // Allow conservative speech/readback time before replacing the live stream.
      const requiredSeconds = Math.ceil(nextCall.proposal.readback.length / 8) + 30;
      if (remaining(record, now) < requiredSeconds)
        throw new VoiceError(
          'CALL_BUDGET_EXCEEDED',
          409,
          'There is insufficient call time to confirm this request. Please contact staff.',
        );
      await tx.saveCall(nextCall, call.version);
      await saveRecord(
        tx,
        record,
        {
          state: 'CONTROL_PENDING',
          controlId,
          controlKind: 'readback',
          controlState: 'PREPARED',
          controlTwiml: twiml,
          confirmationGrantHash: hash(grant),
          confirmationExpiresAt: new Date(
            Math.min(Date.parse(nextCall.proposal.expiresAt), deadline(record)),
          ).toISOString(),
          proposalId: nextCall.proposal.id,
          transferDestination: null,
          transferChildSid: null,
        },
        now,
      );
      const result = { controlId, twiml };
      await tx.putReceipt(key, fingerprint(input), result);
      return result;
    }),
  );
  app.post('/internal/voice/transfer', (request) =>
    scoped(request, async (tx, now) => {
      const input = z
        .object({
          ...binding,
          toolCallId: toolId,
          context: z
            .object({
              reason: z
                .enum(['requested_staff', 'allergy_question', 'other'])
                .default('requested_staff'),
              summary: z.string().trim().max(300).default(''),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(request.body);
      const record = await recordFor(tx, input.providerCallSid);
      const policy = await currentPolicy(tx, record);
      if (!policy.transfersEnabled)
        throw new VoiceError('TRANSFER_UNAVAILABLE', 403, 'Staff transfer is disabled.');
      assertGeneration(record, input.generation);
      const key = `voice:tool:${record.id}:${input.toolCallId}`;
      const receipt = await receiptResult(tx, key, input);
      if (receipt) return receipt;
      assertStreaming(record, input.generation, now);
      const restaurant = await tx.getRestaurant(),
        destination = permittedDestination(restaurant, config);
      const grant = token(),
        controlId = randomUUID();
      const seconds = remaining(record, now);
      if (seconds < 25)
        throw new VoiceError(
          'CALL_BUDGET_EXCEEDED',
          409,
          'There is insufficient time to transfer. Please contact staff directly.',
        );
      const twiml = buildTransferTwiml({
        publicUrl: publicUrl(),
        transferToken: grant,
        destination,
        staffLabel: restaurant.transferLabel,
        remainingSeconds: seconds,
      });
      await saveRecord(
        tx,
        record,
        {
          state: 'TRANSFER_PENDING',
          controlId,
          controlKind: 'transfer',
          controlState: 'PREPARED',
          controlTwiml: twiml,
          confirmationGrantHash: hash(grant),
          confirmationExpiresAt: record.leaseExpiresAt,
          proposalId: null,
          transferDestination: destination,
          transferChildSid: null,
        },
        now,
      );
      await tx.putReceipt(`voice:transfer-grant:${hash(grant)}`, hash(grant), {
        providerCallSid: record.providerCallSid,
        controlId,
      });
      await tx.saveHandoff({
        callId: record.id,
        controlId,
        reason: input.context?.reason ?? 'requested_staff',
        summary: input.context?.summary ?? '',
        createdAt: now.toISOString(),
      });
      const result = { controlId, twiml };
      await tx.putReceipt(key, fingerprint(input), result);
      return result;
    }),
  );

  app.post('/internal/voice/dispatch', (request) =>
    scoped(request, async (tx, now) => {
      const input = z
        .object({ ...binding, controlId: z.uuid() })
        .strict()
        .parse(request.body);
      const record = await recordFor(tx, input.providerCallSid);
      assertGeneration(record, input.generation);
      if (record.controlId !== input.controlId)
        throw new VoiceError('CONTROL_MISMATCH', 409, 'The phone action changed.');
      if (record.controlState !== 'PREPARED')
        return { dispatch: false, twiml: null, unavailable: false };
      if (
        record.state === 'NEEDS_RECONCILIATION' ||
        record.state === 'ENDED' ||
        remaining(record, now) <= 0
      )
        throw new VoiceError('CALL_NOT_ACTIVE', 409, 'The phone action is no longer active.');
      const call = await callFor(tx, record),
        restaurant = await tx.getRestaurant();
      const abandon = async () => {
        await clearProposal(
          tx,
          call,
          now,
          'The prepared phone action changed and was not sent. Please review the details again or contact staff.',
        );
        await saveRecord(
          tx,
          record,
          {
            state: 'STREAMING',
            controlState: 'COMPLETED',
            outcome: 'The prepared phone action was not sent.',
          },
          now,
        );
        return { dispatch: false, twiml: null, unavailable: true };
      };
      const policy = await tx.getPhonePolicy();
      if (!policy.voiceEnabled || (record.policyVersion ?? 1) !== policy.version) return abandon();
      let twiml = record.controlTwiml;
      if (record.controlKind === 'readback') {
        if (
          !config.voice.actionsEnabled ||
          !policy.requestsEnabled ||
          !call.proposal ||
          call.proposal.id !== record.proposalId ||
          call.proposal.configVersion !== restaurant.version ||
          Date.parse(call.proposal.expiresAt) <= now.getTime() ||
          remaining(record, now) < Math.ceil(call.proposal.readback.length / 8) + 30
        )
          return abandon();
      } else {
        if (!policy.transfersEnabled) return abandon();
        let destination: string;
        try {
          destination = permittedDestination(restaurant, config);
        } catch (error) {
          if (error instanceof VoiceError) return abandon();
          throw error;
        }
        if (destination !== record.transferDestination || remaining(record, now) < 25)
          return abandon();
        // Extract only our sealed server-issued token, never caller/model XML.
        const grant = /\/twilio\/transfer-result\/([a-f0-9]{64})/.exec(
          record.controlTwiml ?? '',
        )?.[1];
        if (!grant)
          throw new VoiceError('CONTROL_INVALID', 409, 'The phone action is unavailable.');
        twiml = buildTransferTwiml({
          publicUrl: publicUrl(),
          transferToken: grant,
          destination: restaurant.transferNumber,
          staffLabel: restaurant.transferLabel,
          remainingSeconds: remaining(record, now),
        });
      }
      if (!twiml) throw new VoiceError('CONTROL_INVALID', 409, 'The phone action is unavailable.');
      await saveRecord(tx, record, { controlState: 'DISPATCHED', controlTwiml: twiml }, now);
      return { dispatch: true, twiml, unavailable: false };
    }),
  );
  app.post('/internal/voice/dispatched', (request) =>
    scoped(request, async (tx, now) => {
      const input = z
        .object({
          ...binding,
          controlId: z.uuid(),
          outcome: z.enum(['accepted', 'rejected', 'unknown']),
        })
        .strict()
        .parse(request.body);
      let record = await recordFor(tx, input.providerCallSid);
      // Authoritative callback may have completed the action before REST acknowledged it.
      if (record.state === 'ENDED' || record.controlState === 'COMPLETED')
        return { state: record.state };
      assertGeneration(record, input.generation);
      if (record.controlId !== input.controlId || record.controlState !== 'DISPATCHED')
        return { state: record.state };
      if (input.outcome === 'accepted')
        record = await saveRecord(
          tx,
          record,
          {
            controlState: 'ACCEPTED',
            state:
              record.controlKind === 'readback'
                ? 'AWAITING_CONFIRMATION'
                : record.state === 'CONNECTED_TO_STAFF'
                  ? 'CONNECTED_TO_STAFF'
                  : 'TRANSFERRING',
          },
          now,
        );
      else if (input.outcome === 'unknown')
        record = await saveRecord(
          tx,
          record,
          {
            controlState: 'UNKNOWN',
            state: 'NEEDS_RECONCILIATION',
            outcome: 'Phone action outcome is uncertain; automatic retry is blocked.',
          },
          now,
        );
      else {
        await clearProposal(
          tx,
          await callFor(tx, record),
          now,
          'The phone action was not sent. No new request was submitted.',
        );
        record = await saveRecord(
          tx,
          record,
          {
            state: 'STREAMING',
            controlState: 'COMPLETED',
            outcome: 'The phone action was not sent.',
          },
          now,
        );
      }
      return { state: record.state };
    }),
  );

  app.post('/internal/voice/confirmation', (request) =>
    scoped(request, async (tx, now) => {
      const parsed = z
        .object({
          providerCallSid: providerCallSidSchema,
          confirmationToken: tokenSchema,
          speechResult: z.string().max(2000).optional(),
          confidence: z.number().min(0).max(1).optional(),
        })
        .strict()
        .parse(request.body);
      const input = {
        ...parsed,
        speechResult: (parsed.speechResult ?? '')
          .trim()
          .toLowerCase()
          .replace(/[.!?]+$/, ''),
      };
      const record = await recordFor(tx, input.providerCallSid);
      eligibleCallback(record, input.confirmationToken, 'readback');
      if (record.state === 'ENDED') return callbackResult(record, hangup());
      const key = `voice:confirmation:${hash(input.confirmationToken)}`;
      const receipt = await receiptResult(tx, key, input);
      if (receipt) return callbackResultSchema.parse(receipt);
      if (record.controlState === 'COMPLETED')
        throw new VoiceError('CALLBACK_COMPLETED', 409, 'This confirmation has already completed.');
      const call = await callFor(tx, record),
        restaurant = await tx.getRestaurant();
      const policy = await tx.getPhonePolicy();
      let outcome = 'No new request was saved. You may repeat the details or ask for staff.';
      const affirmed =
        [
          'yes',
          'yes please',
          'confirm',
          'yes confirm',
          'that is correct',
          "that's correct",
        ].includes(input.speechResult) &&
        (input.confidence === undefined || input.confidence >= 0.8);
      if (
        affirmed &&
        config.voice.actionsEnabled &&
        policy.voiceEnabled &&
        policy.requestsEnabled &&
        (record.policyVersion ?? 1) === policy.version &&
        record.proposalId &&
        call.proposal?.id === record.proposalId &&
        record.confirmationExpiresAt &&
        Date.parse(record.confirmationExpiresAt) > now.getTime() &&
        remaining(record, now) > 0
      ) {
        try {
          const result = confirmVoiceProposal(call, record.proposalId, restaurant, now);
          await tx.insertInbox(result.item);
          await tx.saveCall(result.call, call.version);
          await tx.enqueue('inbox.created', result.item.id);
          await tx.audit('system:voice', 'inbox.created', result.item.id);
          outcome =
            result.item.kind === 'reservation'
              ? 'Your unconfirmed reservation request was saved for staff review. Your table is not booked.'
              : 'Your message was saved to the restaurant staff inbox.';
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          outcome =
            'The request details changed or expired. No new request was saved. Please review them again or contact staff.';
          await clearProposal(tx, call, now, outcome);
        }
      } else await clearProposal(tx, call, now, outcome);
      const result = await resume(tx, record, now, outcome);
      await tx.putReceipt(key, fingerprint(input), result);
      return result;
    }),
  );
  app.post('/internal/voice/transfer-status', (request) =>
    scoped(request, async (tx, now) => {
      const input = z
        .object({
          transferToken: tokenSchema,
          childCallSid: providerCallSidSchema,
          status: z.enum([
            'initiated',
            'ringing',
            'answered',
            'in-progress',
            'completed',
            'busy',
            'no-answer',
            'failed',
            'canceled',
          ]),
          parentCallSid: providerCallSidSchema.optional(),
        })
        .strict()
        .parse(request.body);
      const mapping = await tx.getReceipt(`voice:transfer-grant:${hash(input.transferToken)}`);
      if (!mapping) throw new VoiceError('INVALID_CALLBACK', 403, 'Unknown transfer callback.');
      const grant = transferGrantSchema.parse(mapping.result);
      const record = await recordFor(tx, grant.providerCallSid);
      eligibleCallback(record, input.transferToken, 'transfer');
      if (input.parentCallSid && input.parentCallSid !== record.providerCallSid)
        throw new VoiceError('INVALID_CALLBACK', 403, 'Transfer parent mismatch.');
      if (
        record.controlId !== grant.controlId ||
        (record.transferChildSid && record.transferChildSid !== input.childCallSid) ||
        input.childCallSid === record.providerCallSid
      )
        throw new VoiceError('INVALID_CALLBACK', 403, 'Transfer child mismatch.');
      if (record.state === 'ENDED' || record.controlState === 'COMPLETED')
        return { state: record.state };
      const connected = input.status === 'answered' || input.status === 'in-progress';
      const next = await saveRecord(
        tx,
        record,
        {
          transferChildSid: input.childCallSid,
          controlState: 'ACCEPTED',
          ...(connected
            ? {
                state: 'CONNECTED_TO_STAFF' as const,
                outcome: 'The configured staff line connected; human pickup is unverified.',
              }
            : {
                state:
                  record.state === 'CONNECTED_TO_STAFF'
                    ? ('CONNECTED_TO_STAFF' as const)
                    : ('TRANSFERRING' as const),
              }),
        },
        now,
      );
      return { state: next.state };
    }),
  );
  app.post('/internal/voice/transfer-result', (request) =>
    scoped(request, async (tx, now) => {
      const input = z
        .object({
          providerCallSid: providerCallSidSchema,
          transferToken: tokenSchema,
          dialCallSid: providerCallSidSchema.optional(),
          dialCallStatus: z.enum(['completed', 'busy', 'no-answer', 'failed', 'canceled']),
          bridged: z.boolean(),
        })
        .strict()
        .parse(request.body);
      const record = await recordFor(tx, input.providerCallSid);
      eligibleCallback(record, input.transferToken, 'transfer');
      if (record.state === 'ENDED') return callbackResult(record, hangup());
      const key = `voice:transfer-result:${hash(input.transferToken)}`;
      const receipt = await receiptResult(tx, key, input);
      if (receipt) return callbackResultSchema.parse(receipt);
      if (
        record.controlState === 'COMPLETED' ||
        (record.transferChildSid && input.dialCallSid !== record.transferChildSid) ||
        input.dialCallSid === record.providerCallSid
      )
        throw new VoiceError('INVALID_CALLBACK', 403, 'Transfer child mismatch.');
      if (input.bridged && (input.dialCallStatus !== 'completed' || !input.dialCallSid))
        throw new VoiceError('INVALID_CALLBACK', 400, 'Invalid transfer result.');
      const call = await callFor(tx, record);
      let result;
      if (input.bridged) {
        const outcome =
          'The configured staff line connected and the transfer ended. Human pickup is unverified.';
        if (!call.inboxItemId)
          await tx.saveCall(
            {
              ...call,
              version: call.version + 1,
              status: 'transferred',
              phase: 'complete',
              proposal: null,
              messages: [],
              draft: {},
              outcome,
              updatedAt: now.toISOString(),
            },
            call.version,
          );
        const next = await saveRecord(
          tx,
          record,
          {
            state: 'NEEDS_RECONCILIATION',
            controlState: 'COMPLETED',
            transferChildSid: input.dialCallSid ?? null,
            outcome,
          },
          now,
        );
        result = callbackResult(next, hangup('The transfer has ended. Thank you for calling.'));
      } else {
        const outcome =
          'I could not connect you to the staff line. You can leave a message or contact the restaurant directly.';
        await clearProposal(tx, call, now, outcome);
        result = await resume(tx, record, now, outcome);
      }
      await tx.putReceipt(key, fingerprint(input), result);
      return result;
    }),
  );
}
