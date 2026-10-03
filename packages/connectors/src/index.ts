import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
export {
  buildConfirmationRetryTwiml,
  buildReadbackTwiml,
  buildSilentConfirmationTwiml,
  buildTransferTwiml,
  TelephonyInputError,
} from './telephony.js';
export * from './call-status.js';
export * from './fallback.js';
import {
  isoInstantSchema,
  reservationDetailsSchema,
  type IntegrationStatus,
  type ReservationDetails,
} from '@hostline/contracts';

export type ReservationCapability =
  | 'submitRequest'
  | 'checkAvailability'
  | 'createReservation'
  | 'readReservation'
  | 'reconcileWrite';
export type CapabilityEvidence = 'SUPPORTED' | 'SIMULATED' | 'UNSUPPORTED' | 'UNKNOWN';
export interface ConnectorManifest {
  readonly provider: 'request-only' | 'deterministic-fake' | 'resy' | 'opentable';
  readonly mode: 'REQUEST_ONLY' | 'DETERMINISTIC_FAKE' | 'DISABLED';
  readonly capabilities: Readonly<Record<ReservationCapability, CapabilityEvidence>>;
}
const unavailable = {
  submitRequest: 'UNSUPPORTED',
  checkAvailability: 'UNKNOWN',
  createReservation: 'UNKNOWN',
  readReservation: 'UNKNOWN',
  reconcileWrite: 'UNKNOWN',
} as const;
export const requestOnlyManifest: ConnectorManifest = Object.freeze({
  provider: 'request-only',
  mode: 'REQUEST_ONLY',
  capabilities: Object.freeze({
    submitRequest: 'SUPPORTED',
    checkAvailability: 'UNSUPPORTED',
    createReservation: 'UNSUPPORTED',
    readReservation: 'UNSUPPORTED',
    reconcileWrite: 'UNSUPPORTED',
  }),
});
export const fakeManifest: ConnectorManifest = Object.freeze({
  provider: 'deterministic-fake',
  mode: 'DETERMINISTIC_FAKE',
  capabilities: Object.freeze({
    submitRequest: 'UNSUPPORTED',
    checkAvailability: 'SIMULATED',
    createReservation: 'SIMULATED',
    readReservation: 'SIMULATED',
    reconcileWrite: 'SIMULATED',
  }),
});
export const resyManifest: ConnectorManifest = Object.freeze({
  provider: 'resy',
  mode: 'DISABLED',
  capabilities: Object.freeze({ ...unavailable }),
});
export const openTableManifest: ConnectorManifest = Object.freeze({
  provider: 'opentable',
  mode: 'DISABLED',
  capabilities: Object.freeze({ ...unavailable }),
});

export function getIntegrationStatuses(): IntegrationStatus[] {
  return [
    {
      id: 'request-only',
      name: 'Staff reservation requests',
      category: 'reservations',
      status: 'active',
      description:
        'Saves unconfirmed requests in the staff inbox. Staff check availability and contact guests.',
      capabilities: ['submitRequest'],
    },
    {
      id: 'deterministic-fake',
      name: 'Reservation simulator',
      category: 'reservations',
      status: 'simulation',
      description:
        'Synthetic connector scenarios for development. No real tables or vendor accounts.',
      capabilities: ['checkAvailability', 'createReservation', 'reconcileWrite'],
    },
    {
      id: 'resy',
      name: 'Resy',
      category: 'reservations',
      status: 'access_required',
      description:
        'Disabled until official API access, restaurant permission, and capability verification are complete.',
      capabilities: [],
    },
    {
      id: 'opentable',
      name: 'OpenTable',
      category: 'reservations',
      status: 'access_required',
      description:
        'Disabled until official API access, restaurant permission, and capability verification are complete.',
      capabilities: [],
    },
    {
      id: 'twilio',
      name: 'Twilio',
      category: 'phone',
      status: 'not_configured',
      description: 'Phone service requires environment configuration and live-call verification.',
      capabilities: [],
    },
    {
      id: 'openai',
      name: 'OpenAI Realtime',
      category: 'voice',
      status: 'not_configured',
      description: 'Realtime voice requires environment configuration and live-call verification.',
      capabilities: [],
    },
  ];
}

export class ConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export function assertCapability(
  manifest: ConnectorManifest,
  capability: ReservationCapability,
  environment: 'simulation' | 'live',
): void {
  const evidence = manifest.capabilities[capability];
  if (
    evidence === 'SUPPORTED' &&
    manifest.mode === 'REQUEST_ONLY' &&
    capability === 'submitRequest'
  )
    return;
  if (
    evidence === 'SIMULATED' &&
    manifest.mode === 'DETERMINISTIC_FAKE' &&
    environment === 'simulation'
  )
    return;
  throw new ConnectorError(
    'UNSUPPORTED',
    'This connector capability is not enabled for this environment.',
  );
}

export type WriteResult =
  | {
      readonly kind: 'CONFIRMED';
      readonly providerReference: string;
      readonly evidence: 'SIMULATED';
    }
  | {
      readonly kind: 'REJECTED';
      readonly code:
        | 'UNSUPPORTED'
        | 'UNAVAILABLE_SLOT'
        | 'RATE_LIMITED'
        | 'NOT_AUTHORIZED'
        | 'OFFER_EXPIRED'
        | 'NOT_SENT';
      readonly provenNotCreated: true;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly kind: 'UNKNOWN';
      readonly reason: 'TIMEOUT' | 'DISCONNECTED' | 'AMBIGUOUS_RESPONSE';
    };
export type ReconciliationResult =
  | {
      readonly kind: 'CONFIRMED';
      readonly providerReference: string;
      readonly evidence: 'SIMULATED';
    }
  | { readonly kind: 'NOT_CREATED'; readonly evidenceId: string }
  | { readonly kind: 'STILL_UNKNOWN' }
  | {
      readonly kind: 'ERROR';
      readonly code: 'UNSUPPORTED' | 'NOT_AUTHORIZED';
      readonly mutationOutcome: 'UNKNOWN';
    };

// No endpoints, consumer sessions, or network clients exist in disabled adapters.
export function createDisabledAdapter(provider: 'resy' | 'opentable') {
  return Object.freeze({
    manifest: provider === 'resy' ? resyManifest : openTableManifest,
    checkAvailability: () => ({ kind: 'ERROR', code: 'UNSUPPORTED' }) as const,
    createReservation: (): WriteResult => ({
      kind: 'REJECTED',
      code: 'UNSUPPORTED',
      provenNotCreated: true,
    }),
    readReservation: () => ({ kind: 'ERROR', code: 'UNSUPPORTED' }) as const,
    reconcileWrite: (): ReconciliationResult => ({
      kind: 'ERROR',
      code: 'UNSUPPORTED',
      mutationOutcome: 'UNKNOWN',
    }),
  });
}

const prepareSchema = z
  .object({
    tenantId: z.uuid(),
    callId: z.uuid(),
    idempotencyKey: z.uuid(),
    intent: reservationDetailsSchema,
    callerWaitUntil: isoInstantSchema,
    policyExecuteBefore: isoInstantSchema,
    offerExpiresAt: isoInstantSchema.optional(),
  })
  .strict();
export type PrepareBookingInput = z.infer<typeof prepareSchema>;
export interface PreparedBooking {
  readonly id: string;
  readonly tenantId: string;
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly intent: Readonly<ReservationDetails>;
  readonly executeBefore: string;
  readonly digest: string;
}
export type OperationState =
  | 'PENDING'
  | 'EXECUTING'
  | 'EXPIRED_BEFORE_DISPATCH'
  | 'CANCELLED_BEFORE_DISPATCH'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNKNOWN';
export interface BookingOperation extends PreparedBooking {
  readonly state: OperationState;
  readonly phase: 'UNSENT' | 'ADMITTED' | 'DISPATCH_STARTED';
  readonly version: number;
  readonly attempts: number;
  readonly result: WriteResult | null;
  readonly retryNotBefore: string | null;
}

function digestBooking(booking: Omit<PreparedBooking, 'digest'>): string {
  const value = booking.intent;
  return createHash('sha256')
    .update(
      JSON.stringify([
        booking.id,
        booking.tenantId,
        booking.callId,
        booking.idempotencyKey,
        booking.executeBefore,
        value.date,
        value.time,
        value.timezone,
        value.startsAt,
        value.referenceAt,
        value.partySize,
        value.name,
        value.callbackNumber,
        value.notes,
      ]),
    )
    .digest('hex');
}

/** Prepare before caller/staff approval; the earliest deadline is part of the agreed digest. */
export function prepareBooking(input: PrepareBookingInput, now: Date): PreparedBooking {
  const parsed = prepareSchema.safeParse(input);
  if (!parsed.success)
    throw new ConnectorError(
      'INVALID_INPUT',
      'The booking intent or execution deadline is invalid.',
    );
  const value = parsed.data;
  const executeBefore = new Date(
    Math.min(
      Date.parse(value.callerWaitUntil),
      Date.parse(value.policyExecuteBefore),
      value.offerExpiresAt ? Date.parse(value.offerExpiresAt) : Infinity,
      Date.parse(value.intent.startsAt),
    ),
  ).toISOString();
  if (Date.parse(executeBefore) <= now.getTime())
    throw new ConnectorError(
      'EXECUTION_EXPIRED',
      'The agreed booking deadline has passed. Obtain fresh agreement.',
    );
  const prepared = {
    id: randomUUID(),
    tenantId: value.tenantId,
    callId: value.callId,
    idempotencyKey: value.idempotencyKey,
    intent: Object.freeze({ ...value.intent }),
    executeBefore,
  };
  return Object.freeze({ ...prepared, digest: digestBooking(prepared) });
}

function validateBoundIntent(booking: PreparedBooking): void {
  if (digestBooking(booking) !== booking.digest)
    throw new ConnectorError(
      'INTENT_CHANGED',
      'The approved booking details or deadline changed. Obtain fresh agreement.',
    );
}
export function approveBooking(
  prepared: PreparedBooking,
  approvedDigest: string,
  now: Date,
): BookingOperation {
  validateBoundIntent(prepared);
  if (prepared.digest !== approvedDigest)
    throw new ConnectorError('APPROVAL_MISMATCH', 'Approval does not match these booking details.');
  if (Date.parse(prepared.executeBefore) <= now.getTime())
    throw new ConnectorError(
      'EXECUTION_EXPIRED',
      'The agreed booking deadline has passed. Obtain fresh agreement.',
    );
  return Object.freeze({
    ...prepared,
    state: 'PENDING',
    phase: 'UNSENT',
    version: 1,
    attempts: 0,
    result: null,
    retryNotBefore: null,
  });
}

function checkVersion(operation: BookingOperation, expectedVersion: number): void {
  validateBoundIntent(operation);
  if (operation.version !== expectedVersion)
    throw new ConnectorError(
      'VERSION_CONFLICT',
      'This booking operation changed. Reload its current state.',
    );
}
function update(
  operation: BookingOperation,
  changes: Partial<
    Pick<BookingOperation, 'state' | 'phase' | 'attempts' | 'result' | 'retryNotBefore'>
  >,
): BookingOperation {
  return Object.freeze({ ...operation, ...changes, version: operation.version + 1 });
}

/** The repository must compare-and-set the version atomically with dispatch admission. */
export function admitDispatch(
  operation: BookingOperation,
  expectedVersion: number,
  now: Date,
): BookingOperation {
  checkVersion(operation, expectedVersion);
  if (operation.state !== 'PENDING' || operation.phase !== 'UNSENT')
    throw new ConnectorError('DISPATCH_BLOCKED', 'This operation cannot begin a booking.');
  if (Date.parse(operation.executeBefore) <= now.getTime())
    return update(operation, { state: 'EXPIRED_BEFORE_DISPATCH' });
  return update(operation, { state: 'EXECUTING', phase: 'ADMITTED' });
}

/** Persist before network send, rechecking after queueing or waits. A crash after this is uncertain. */
export function markDispatchStarted(
  operation: BookingOperation,
  expectedVersion: number,
  now: Date,
): BookingOperation {
  checkVersion(operation, expectedVersion);
  if (operation.state !== 'EXECUTING' || operation.phase !== 'ADMITTED')
    throw new ConnectorError('DISPATCH_BLOCKED', 'This operation is not admitted for dispatch.');
  if (Date.parse(operation.executeBefore) <= now.getTime())
    return update(operation, { state: 'EXPIRED_BEFORE_DISPATCH', phase: 'UNSENT' });
  return update(operation, { phase: 'DISPATCH_STARTED', attempts: operation.attempts + 1 });
}

export function expireBookingOperation(
  operation: BookingOperation,
  expectedVersion: number,
  now: Date,
): BookingOperation {
  checkVersion(operation, expectedVersion);
  if (
    Date.parse(operation.executeBefore) > now.getTime() ||
    !['PENDING', 'EXECUTING', 'UNKNOWN'].includes(operation.state)
  )
    return operation;
  if (operation.phase === 'DISPATCH_STARTED')
    return operation.state === 'UNKNOWN'
      ? operation
      : update(operation, {
          state: 'UNKNOWN',
          result: { kind: 'UNKNOWN', reason: 'AMBIGUOUS_RESPONSE' },
        });
  return update(operation, { state: 'EXPIRED_BEFORE_DISPATCH', phase: 'UNSENT' });
}

export function cancelBeforeDispatch(
  operation: BookingOperation,
  expectedVersion: number,
): BookingOperation {
  checkVersion(operation, expectedVersion);
  if (operation.state !== 'PENDING' || operation.phase !== 'UNSENT')
    throw new ConnectorError(
      'CANCELLATION_TOO_LATE',
      'Dispatch was admitted; check the existing operation outcome.',
    );
  return update(operation, { state: 'CANCELLED_BEFORE_DISPATCH' });
}

export function recordWriteResult(
  operation: BookingOperation,
  expectedVersion: number,
  result: WriteResult,
  now: Date,
): BookingOperation {
  checkVersion(operation, expectedVersion);
  if (operation.state !== 'EXECUTING' || operation.phase !== 'DISPATCH_STARTED')
    throw new ConnectorError(
      'INVALID_TRANSITION',
      'This operation is not awaiting a write result.',
    );
  if (result.kind === 'CONFIRMED' && !result.providerReference.trim())
    throw new ConnectorError('INVALID_RESULT', 'A confirmed result requires a verified reference.');
  const retryAfterSeconds = result.kind === 'REJECTED' ? (result.retryAfterSeconds ?? 0) : 0;
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0 || retryAfterSeconds > 86400)
    throw new ConnectorError('INVALID_RESULT', 'The retry delay is invalid.');
  return update(operation, {
    state:
      result.kind === 'CONFIRMED' ? 'SUCCEEDED' : result.kind === 'REJECTED' ? 'FAILED' : 'UNKNOWN',
    result,
    retryNotBefore: new Date(
      now.getTime() + Math.max(retryAfterSeconds * 1000, 1000 * 2 ** operation.attempts),
    ).toISOString(),
  });
}

export function recordReconciliation(
  operation: BookingOperation,
  expectedVersion: number,
  result: ReconciliationResult,
): BookingOperation {
  checkVersion(operation, expectedVersion);
  if (operation.state !== 'UNKNOWN')
    throw new ConnectorError('INVALID_TRANSITION', 'Only uncertain operations can be reconciled.');
  if (result.kind === 'CONFIRMED') {
    if (!result.providerReference.trim())
      throw new ConnectorError(
        'INVALID_RESULT',
        'A confirmed result requires a verified reference.',
      );
    return update(operation, { state: 'SUCCEEDED', result });
  }
  if (result.kind === 'NOT_CREATED') {
    if (!result.evidenceId.trim())
      throw new ConnectorError(
        'EVIDENCE_REQUIRED',
        'Evidence is required to release an uncertain booking.',
      );
    return update(operation, {
      state: 'FAILED',
      result: { kind: 'REJECTED', code: 'NOT_SENT', provenNotCreated: true },
    });
  }
  // Access failure and NOT_FOUND-style uncertainty never establish absence of a booking.
  return operation;
}

/** Only proven-not-created transient failures can retry, within the original immutable deadline. */
export function retryBooking(
  operation: BookingOperation,
  expectedVersion: number,
  now: Date,
): BookingOperation {
  checkVersion(operation, expectedVersion);
  if (
    operation.state !== 'FAILED' ||
    operation.result?.kind !== 'REJECTED' ||
    !['NOT_SENT', 'RATE_LIMITED'].includes(operation.result.code) ||
    operation.attempts >= 3
  )
    throw new ConnectorError(
      'RETRY_BLOCKED',
      'Reconcile the original outcome or obtain fresh agreement before another booking.',
    );
  if (Date.parse(operation.executeBefore) <= now.getTime())
    return update(operation, { state: 'EXPIRED_BEFORE_DISPATCH', phase: 'UNSENT' });
  if (operation.retryNotBefore && Date.parse(operation.retryNotBefore) > now.getTime())
    throw new ConnectorError(
      'RETRY_TOO_EARLY',
      'Wait for the retry delay before dispatching this operation.',
    );
  return update(operation, {
    state: 'PENDING',
    phase: 'UNSENT',
    result: null,
    retryNotBefore: null,
  });
}

export type FakeScenario =
  | 'success'
  | 'conflict'
  | 'rate_limited'
  | 'timeout_before_write'
  | 'timeout_after_write'
  | 'credential_expired'
  | 'offer_expired';

/** In-memory synthetic adapter only; intentionally has no transport, credentials, or live routing. */
export class FakeReservationConnector {
  readonly manifest = fakeManifest;
  private readonly writes = new Map<string, { digest: string; reference: string }>();
  private readonly intentDigests = new Map<string, string>();
  private readonly absent = new Set<string>();

  checkAvailability(intent: ReservationDetails, environment: 'simulation' | 'live') {
    assertCapability(this.manifest, 'checkAvailability', environment);
    const parsed = reservationDetailsSchema.safeParse(intent);
    if (!parsed.success)
      throw new ConnectorError('INVALID_INPUT', 'Provide valid synthetic reservation details.');
    return {
      kind: 'OK',
      simulation: true,
      offers: [
        {
          offerId: 'SIMULATION-OFFER',
          startsAt: parsed.data.startsAt,
          partySize: parsed.data.partySize,
          held: false,
        },
      ],
    } as const;
  }

  readReservation(tenantId: string, reference: string, environment: 'simulation' | 'live') {
    assertCapability(this.manifest, 'readReservation', environment);
    const found = [...this.writes].some(
      ([key, value]) => key.startsWith(`${tenantId}:`) && value.reference === reference,
    );
    return found
      ? ({
          kind: 'OK',
          status: 'CONFIRMED',
          providerReference: reference,
          evidence: 'SIMULATED',
        } as const)
      : ({ kind: 'ERROR', code: 'NOT_FOUND' } as const);
  }

  createReservation(
    operation: BookingOperation,
    scenario: FakeScenario,
    environment: 'simulation' | 'live',
  ): WriteResult {
    assertCapability(this.manifest, 'createReservation', environment);
    validateBoundIntent(operation);
    if (operation.state !== 'EXECUTING' || operation.phase !== 'DISPATCH_STARTED')
      throw new ConnectorError(
        'DISPATCH_BLOCKED',
        'Simulated writes require a dispatched operation.',
      );
    const key = `${operation.tenantId}:${operation.idempotencyKey}`;
    const digest = this.intentDigests.get(key);
    if (digest && digest !== operation.digest)
      throw new ConnectorError(
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key belongs to different booking details.',
      );
    this.intentDigests.set(key, operation.digest);
    const previous = this.writes.get(key);
    if (previous) {
      if (previous.digest !== operation.digest)
        throw new ConnectorError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key belongs to different booking details.',
        );
      return { kind: 'CONFIRMED', providerReference: previous.reference, evidence: 'SIMULATED' };
    }
    if (scenario === 'timeout_before_write') {
      this.absent.add(key);
      return { kind: 'REJECTED', code: 'NOT_SENT', provenNotCreated: true };
    }
    if (scenario === 'conflict') {
      this.absent.add(key);
      return { kind: 'REJECTED', code: 'UNAVAILABLE_SLOT', provenNotCreated: true };
    }
    if (scenario === 'rate_limited') {
      this.absent.add(key);
      return {
        kind: 'REJECTED',
        code: 'RATE_LIMITED',
        provenNotCreated: true,
        retryAfterSeconds: 2,
      };
    }
    if (scenario === 'credential_expired') {
      this.absent.add(key);
      return { kind: 'REJECTED', code: 'NOT_AUTHORIZED', provenNotCreated: true };
    }
    if (scenario === 'offer_expired') {
      this.absent.add(key);
      return { kind: 'REJECTED', code: 'OFFER_EXPIRED', provenNotCreated: true };
    }
    const reference = `SIMULATION-${operation.id}`;
    this.writes.set(key, { digest: operation.digest, reference });
    this.absent.delete(key);
    if (scenario === 'timeout_after_write') return { kind: 'UNKNOWN', reason: 'TIMEOUT' };
    return { kind: 'CONFIRMED', providerReference: reference, evidence: 'SIMULATED' };
  }

  reconcileWrite(
    operation: BookingOperation,
    environment: 'simulation' | 'live',
  ): ReconciliationResult {
    assertCapability(this.manifest, 'reconcileWrite', environment);
    validateBoundIntent(operation);
    const key = `${operation.tenantId}:${operation.idempotencyKey}`;
    const previous = this.writes.get(key);
    if (previous) {
      if (previous.digest !== operation.digest)
        throw new ConnectorError(
          'IDEMPOTENCY_CONFLICT',
          'This key belongs to different booking details.',
        );
      return { kind: 'CONFIRMED', providerReference: previous.reference, evidence: 'SIMULATED' };
    }
    return this.absent.has(key)
      ? { kind: 'NOT_CREATED', evidenceId: `SIMULATION-NOT-CREATED-${operation.id}` }
      : { kind: 'STILL_UNKNOWN' };
  }
}
