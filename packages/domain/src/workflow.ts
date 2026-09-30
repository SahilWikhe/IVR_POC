import {
  inboxActionSchema,
  type Actor,
  type InboxAction,
  type InboxItem,
} from '@hostline/contracts';
import { DomainError } from './errors.js';

const leaseMilliseconds = 10 * 60 * 1000;
function leaseIsActive(item: InboxItem, now: Date): boolean {
  return item.leaseExpiresAt !== null && Date.parse(item.leaseExpiresAt) > now.getTime();
}

export function expireFulfillment(item: InboxItem, now: Date): InboxItem | null {
  if (!item.leaseExpiresAt || leaseIsActive(item, now)) return null;
  if (item.state === 'IN_REVIEW') {
    return {
      ...item,
      state: 'ACKNOWLEDGED',
      assignedTo: null,
      leaseExpiresAt: null,
      version: item.version + 1,
      updatedAt: now.toISOString(),
    };
  }
  if (item.state === 'IN_FULFILLMENT') {
    return {
      ...item,
      state: 'NEEDS_RECONCILIATION',
      leaseExpiresAt: null,
      version: item.version + 1,
      updatedAt: now.toISOString(),
    };
  }
  return null;
}

export function transitionInbox(
  item: InboxItem,
  input: InboxAction,
  actor: Actor,
  now: Date,
): InboxItem {
  if (actor.role !== 'owner' && actor.role !== 'staff')
    throw new DomainError(
      'FORBIDDEN',
      'Your role can view the inbox but cannot change requests.',
      403,
    );
  const parsed = inboxActionSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError('INVALID_ACTION', 'Please provide the required action details.');
  const action = parsed.data;
  if (action.expectedVersion !== item.version)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This request has changed. Refresh it before trying again.',
      409,
    );
  const fail = (): never => {
    throw new DomainError(
      'INVALID_TRANSITION',
      'That action is not available for the current request state.',
      409,
    );
  };
  const requireClaim = (): void => {
    if (item.assignedTo !== actor.userId || !leaseIsActive(item, now))
      throw new DomainError(
        'CLAIM_REQUIRED',
        'Claim this request before continuing, or refresh an expired claim.',
        409,
      );
  };
  const requireReconciler = (): void => {
    if (actor.role !== 'owner' && item.assignedTo !== actor.userId)
      throw new DomainError(
        'FORBIDDEN',
        'The assigned staff member or an owner must resolve this booking hold.',
        403,
      );
  };
  const requireEvidence = (): string => {
    if (!action.evidence)
      throw new DomainError(
        'EVIDENCE_REQUIRED',
        'Record evidence from the restaurant’s reservation system before continuing.',
      );
    return action.evidence;
  };
  const next: InboxItem = { ...item, version: item.version + 1, updatedAt: now.toISOString() };
  switch (action.action) {
    case 'ACKNOWLEDGE':
      if (item.state !== 'PENDING_STAFF_REVIEW') fail();
      next.state = 'ACKNOWLEDGED';
      break;
    case 'CLAIM':
      if (!['PENDING_STAFF_REVIEW', 'ACKNOWLEDGED', 'IN_REVIEW'].includes(item.state)) fail();
      if (
        item.state === 'IN_REVIEW' &&
        item.assignedTo !== actor.userId &&
        leaseIsActive(item, now)
      )
        throw new DomainError(
          'ALREADY_CLAIMED',
          'Another staff member is reviewing this request.',
          409,
        );
      next.state = 'IN_REVIEW';
      next.assignedTo = actor.userId;
      next.leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds).toISOString();
      break;
    case 'START_FULFILLMENT':
      if (item.kind !== 'reservation' || item.state !== 'IN_REVIEW') fail();
      requireClaim();
      if (!item.reservation || Date.parse(item.reservation.startsAt) <= now.getTime())
        throw new DomainError(
          'PAST_RESERVATION',
          'This request is in the past. Contact the guest to arrange a new request.',
        );
      next.state = 'IN_FULFILLMENT';
      next.leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds).toISOString();
      break;
    case 'RECORD_BOOKING':
      if (item.state !== 'IN_FULFILLMENT' || item.kind !== 'reservation') fail();
      requireClaim();
      next.bookingEvidence = requireEvidence();
      next.evidenceSource = 'STAFF_REPORTED';
      next.state = 'BOOKED_AWAITING_GUEST_NOTICE';
      next.leaseExpiresAt = null;
      break;
    case 'DECLINE':
      if (item.state !== 'IN_REVIEW' || item.kind !== 'reservation') fail();
      requireClaim();
      next.bookingEvidence = requireEvidence();
      next.evidenceSource = 'STAFF_REPORTED';
      next.state = 'DECLINED_AWAITING_GUEST_NOTICE';
      next.leaseExpiresAt = null;
      break;
    case 'RECONCILE_BOOKED':
    case 'RECONCILE_NOT_BOOKED':
      if (item.state !== 'NEEDS_RECONCILIATION' || item.kind !== 'reservation') fail();
      requireReconciler();
      next.bookingEvidence = requireEvidence();
      next.evidenceSource = 'STAFF_REPORTED';
      next.leaseExpiresAt = null;
      if (action.action === 'RECONCILE_BOOKED') next.state = 'BOOKED_AWAITING_GUEST_NOTICE';
      else {
        next.state = 'ACKNOWLEDGED';
        next.assignedTo = null;
      }
      break;
    case 'RECORD_GUEST_NOTICE':
      if (
        !['BOOKED_AWAITING_GUEST_NOTICE', 'DECLINED_AWAITING_GUEST_NOTICE'].includes(item.state) &&
        !(item.kind === 'message' && item.state === 'IN_REVIEW')
      )
        fail();
      if (item.kind === 'message') requireClaim();
      else requireReconciler();
      if (!action.noticeNote)
        throw new DomainError(
          'NOTICE_REQUIRED',
          'Record how and when staff communicated with the guest.',
        );
      next.guestNotice = 'COMMUNICATION_RECORDED';
      next.guestNoticeNote = action.noticeNote;
      break;
    case 'CLOSE':
      if (item.guestNotice !== 'COMMUNICATION_RECORDED')
        throw new DomainError(
          'NOTICE_REQUIRED',
          'Record guest communication before closing this item.',
          409,
        );
      if (
        !['BOOKED_AWAITING_GUEST_NOTICE', 'DECLINED_AWAITING_GUEST_NOTICE'].includes(item.state) &&
        !(item.kind === 'message' && item.state === 'IN_REVIEW')
      )
        fail();
      if (item.kind === 'message') requireClaim();
      else requireReconciler();
      next.state = 'CLOSED';
      next.leaseExpiresAt = null;
      break;
  }
  return next;
}
