import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  admitDispatch,
  approveBooking,
  assertCapability,
  cancelBeforeDispatch,
  createDisabledAdapter,
  expireBookingOperation,
  FakeReservationConnector,
  fakeManifest,
  getIntegrationStatuses,
  markDispatchStarted,
  prepareBooking,
  recordReconciliation,
  recordWriteResult,
  requestOnlyManifest,
  retryBooking,
  type BookingOperation,
  type PrepareBookingInput,
} from '@hostline/connectors';

const now = new Date('2026-09-30T16:00:00Z');
const late = new Date('2026-09-30T16:05:00Z');
function preparedInput(): PrepareBookingInput {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    callId: randomUUID(),
    idempotencyKey: randomUUID(),
    intent: {
      date: '2026-10-01',
      time: '19:00',
      partySize: 4,
      name: 'Synthetic Guest',
      callbackNumber: '+12125550143',
      notes: '',
      timezone: 'America/New_York',
      startsAt: '2026-10-01T23:00:00Z',
      referenceAt: now.toISOString(),
    },
    callerWaitUntil: '2026-09-30T16:05:00Z',
    policyExecuteBefore: '2026-09-30T16:10:00Z',
  };
}
function pending(input = preparedInput()): BookingOperation {
  const prepared = prepareBooking(input, now);
  return approveBooking(prepared, prepared.digest, now);
}
function dispatched(input = preparedInput()): BookingOperation {
  const operation = pending(input);
  const admitted = admitDispatch(operation, operation.version, now);
  return markDispatchStarted(admitted, admitted.version, now);
}

describe('connector capability boundaries', () => {
  it('advertises request submission without availability or booking claims', () => {
    expect(() => assertCapability(requestOnlyManifest, 'submitRequest', 'live')).not.toThrow();
    expect(() => assertCapability(requestOnlyManifest, 'createReservation', 'live')).toThrow(
      'not enabled',
    );
    expect(() => assertCapability(requestOnlyManifest, 'checkAvailability', 'simulation')).toThrow(
      'not enabled',
    );
    expect(() => assertCapability(fakeManifest, 'createReservation', 'live')).toThrow(
      'not enabled',
    );
    expect(() => assertCapability(fakeManifest, 'createReservation', 'simulation')).not.toThrow();
  });
  it.each(['resy', 'opentable'] as const)(
    'keeps %s disabled and preserves uncertainty during failed reconciliation',
    (provider) => {
      const adapter = createDisabledAdapter(provider);
      expect(adapter.manifest.mode).toBe('DISABLED');
      expect(adapter.manifest.capabilities.createReservation).toBe('UNKNOWN');
      expect(adapter.createReservation()).toEqual({
        kind: 'REJECTED',
        code: 'UNSUPPORTED',
        provenNotCreated: true,
      });
      expect(adapter.reconcileWrite()).toEqual({
        kind: 'ERROR',
        code: 'UNSUPPORTED',
        mutationOutcome: 'UNKNOWN',
      });
      expect(() => assertCapability(adapter.manifest, 'createReservation', 'live')).toThrow(
        'not enabled',
      );
    },
  );
  it('reports phone and voice as unconfigured and vendor access as required', () => {
    expect(
      getIntegrationStatuses()
        .filter((status) => ['phone', 'voice'].includes(status.category))
        .every((status) => status.status === 'not_configured'),
    ).toBe(true);
    expect(
      getIntegrationStatuses()
        .filter((status) => ['resy', 'opentable'].includes(status.id))
        .every((status) => status.status === 'access_required' && status.capabilities.length === 0),
    ).toBe(true);
  });
});

describe('immutable execution deadline and dispatch ledger', () => {
  it('binds the earliest caller, policy or offer deadline before approval', () => {
    const prepared = prepareBooking(
      { ...preparedInput(), offerExpiresAt: '2026-09-30T16:02:00Z' },
      now,
    );
    expect(prepared.executeBefore).toBe('2026-09-30T16:02:00.000Z');
    expect(() => approveBooking(prepared, 'some-other-digest', now)).toThrow('does not match');
    expect(() =>
      approveBooking({ ...prepared, executeBefore: '2026-09-30T17:00:00Z' }, prepared.digest, now),
    ).toThrow('deadline changed');
    expect(() => approveBooking(prepared, prepared.digest, late)).toThrow('deadline has passed');
  });
  it('expires proven-unsent queued work and rechecks after admission delays', () => {
    const operation = pending();
    expect(admitDispatch(operation, operation.version, late).state).toBe('EXPIRED_BEFORE_DISPATCH');
    const admitted = admitDispatch(operation, operation.version, now);
    expect(markDispatchStarted(admitted, admitted.version, late).state).toBe(
      'EXPIRED_BEFORE_DISPATCH',
    );
    expect(expireBookingOperation(admitted, admitted.version, late).state).toBe(
      'EXPIRED_BEFORE_DISPATCH',
    );
  });
  it('holds already-dispatched work for reconciliation after the deadline', () => {
    const operation = dispatched();
    const expired = expireBookingOperation(operation, operation.version, late);
    expect(expired.state).toBe('UNKNOWN');
    expect(expired.phase).toBe('DISPATCH_STARTED');
    expect(() => retryBooking(expired, expired.version, late)).toThrow('Reconcile');
    expect(
      recordReconciliation(expired, expired.version, createDisabledAdapter('resy').reconcileWrite())
        .state,
    ).toBe('UNKNOWN');
    expect(recordReconciliation(expired, expired.version, { kind: 'STILL_UNKNOWN' }).state).toBe(
      'UNKNOWN',
    );
  });
  it('uses optimistic version checks and forbids cancelling admitted dispatch', () => {
    const operation = pending();
    const cancelled = cancelBeforeDispatch(operation, operation.version);
    expect(() => admitDispatch(cancelled, operation.version, now)).toThrow('changed');
    expect(() => admitDispatch(cancelled, cancelled.version, now)).toThrow('cannot begin');
    const admitted = admitDispatch(operation, operation.version, now);
    expect(() => cancelBeforeDispatch(admitted, admitted.version)).toThrow('Dispatch was admitted');
  });
  it('never extends the deadline or retries unknown writes', () => {
    const operation = dispatched();
    const failed = recordWriteResult(
      operation,
      operation.version,
      { kind: 'REJECTED', code: 'NOT_SENT', provenNotCreated: true },
      now,
    );
    expect(() => retryBooking(failed, failed.version, now)).toThrow('retry delay');
    const retry = retryBooking(failed, failed.version, new Date(now.getTime() + 2_000));
    expect(retry.executeBefore).toBe(operation.executeBefore);
    expect(retry.digest).toBe(operation.digest);
    expect(retry.state).toBe('PENDING');
    expect(retryBooking(failed, failed.version, late).state).toBe('EXPIRED_BEFORE_DISPATCH');
    const unknown = recordWriteResult(
      operation,
      operation.version,
      { kind: 'UNKNOWN', reason: 'TIMEOUT' },
      now,
    );
    expect(() => retryBooking(unknown, unknown.version, now)).toThrow('Reconcile');
  });
  it('honors rate limits and caps safe retries', () => {
    let operation = dispatched();
    const rateLimited = recordWriteResult(
      operation,
      operation.version,
      { kind: 'REJECTED', code: 'RATE_LIMITED', provenNotCreated: true, retryAfterSeconds: 60 },
      now,
    );
    expect(() =>
      retryBooking(rateLimited, rateLimited.version, new Date(now.getTime() + 30_000)),
    ).toThrow('retry delay');
    const later = new Date(now.getTime() + 60_000);
    for (let iteration = 0; iteration < 3; iteration++) {
      const failure = recordWriteResult(
        operation,
        operation.version,
        { kind: 'REJECTED', code: 'NOT_SENT', provenNotCreated: true },
        now,
      );
      if (iteration === 2)
        expect(() => retryBooking(failure, failure.version, later)).toThrow('Reconcile');
      else {
        const retry = retryBooking(failure, failure.version, later);
        const admitted = admitDispatch(retry, retry.version, later);
        operation = markDispatchStarted(admitted, admitted.version, later);
      }
    }
  });
});

describe('deterministic synthetic connector conformance', () => {
  it('reconciles accepted-then-timeout without a second booking', () => {
    const connector = new FakeReservationConnector();
    const operation = dispatched();
    const result = connector.createReservation(operation, 'timeout_after_write', 'simulation');
    expect(result.kind).toBe('UNKNOWN');
    const unknown = recordWriteResult(operation, operation.version, result, now);
    const evidence = connector.reconcileWrite(unknown, 'simulation');
    const reconciled = recordReconciliation(unknown, unknown.version, evidence);
    expect(reconciled.state).toBe('SUCCEEDED');
    expect(connector.createReservation(operation, 'success', 'simulation')).toEqual(evidence);
    if (evidence.kind !== 'CONFIRMED') throw new Error('Expected synthetic reference');
    expect(evidence.providerReference).toContain('SIMULATION-');
    expect(
      connector.readReservation(operation.tenantId, evidence.providerReference, 'simulation'),
    ).toMatchObject({ status: 'CONFIRMED' });
    expect(
      connector.readReservation(
        '22222222-2222-4222-8222-222222222222',
        evidence.providerReference,
        'simulation',
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects conflicting reuse of a key, including after proven-unsent failures', () => {
    const connector = new FakeReservationConnector();
    const input = preparedInput();
    const first = dispatched(input);
    connector.createReservation(first, 'timeout_before_write', 'simulation');
    const second = dispatched({ ...input, intent: { ...input.intent, partySize: 5 } });
    expect(() => connector.createReservation(second, 'success', 'simulation')).toThrow(
      'different booking details',
    );
  });
  it.each([
    ['conflict', 'UNAVAILABLE_SLOT'],
    ['rate_limited', 'RATE_LIMITED'],
    ['timeout_before_write', 'NOT_SENT'],
    ['credential_expired', 'NOT_AUTHORIZED'],
    ['offer_expired', 'OFFER_EXPIRED'],
  ] as const)('normalizes %s with definitive no-write evidence', (scenario, code) => {
    const connector = new FakeReservationConnector();
    const operation = dispatched();
    expect(connector.createReservation(operation, scenario, 'simulation')).toMatchObject({
      kind: 'REJECTED',
      code,
      provenNotCreated: true,
    });
    expect(connector.reconcileWrite(operation, 'simulation').kind).toBe('NOT_CREATED');
  });
  it('does not infer no booking from lost simulation state and rejects live use', () => {
    const connector = new FakeReservationConnector();
    const operation = dispatched();
    expect(connector.reconcileWrite(operation, 'simulation')).toEqual({ kind: 'STILL_UNKNOWN' });
    expect(() => connector.createReservation(operation, 'success', 'live')).toThrow('not enabled');
    expect(connector.checkAvailability(operation.intent, 'simulation')).toMatchObject({
      simulation: true,
      offers: [{ held: false }],
    });
  });
});
