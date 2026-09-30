import { randomUUID } from 'node:crypto';
import {
  voiceProposalInputSchema,
  type CallSession,
  type InboxItem,
  type Proposal,
  type Restaurant,
  type VoiceProposalInput,
} from '@hostline/contracts';
import { confirmSimulation, createSimulationSession, proposalDigest } from './conversation.js';
import { DomainError } from './errors.js';
import { resolveRelativeDate, resolveReservation } from './time.js';

const proposalLifetimeMs = 5 * 60_000;

export function createVoiceSession(restaurant: Restaurant, now: Date): CallSession {
  return { ...createSimulationSession(restaurant, now), mode: 'voice', messages: [], draft: {} };
}

function assertVoiceCall(call: CallSession): void {
  if (call.mode !== 'voice')
    throw new DomainError(
      'INVALID_CALL_MODE',
      'This action requires an authenticated phone call.',
      409,
    );
  if (call.status !== 'active' || call.inboxItemId !== null || call.phase === 'complete')
    throw new DomainError('CALL_ENDED', 'This phone call is no longer accepting actions.', 409);
}

/** Build a proposal only; the provider's separate deterministic confirmation saves it. */
export function prepareVoiceProposal(
  call: CallSession,
  restaurant: Restaurant,
  input: VoiceProposalInput,
  referenceAt: Date,
  now: Date,
): CallSession {
  assertVoiceCall(call);
  const parsed = voiceProposalInputSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError('INVALID_VOICE_PROPOSAL', 'Please provide the complete request details.');
  if (
    !Number.isFinite(referenceAt.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    referenceAt.getTime() > now.getTime() ||
    referenceAt.getTime() < Date.parse(call.createdAt)
  )
    throw new DomainError('INVALID_UTTERANCE_REFERENCE', 'Please repeat the requested date.', 409);

  const proposal: Omit<Proposal, 'digest'> = {
    id: randomUUID(),
    kind: parsed.data.kind,
    reservation: null,
    message: null,
    readback: '',
    configVersion: restaurant.version,
    referenceAt: referenceAt.toISOString(),
    expiresAt: new Date(now.getTime() + proposalLifetimeMs).toISOString(),
  };
  if (parsed.data.kind === 'reservation') {
    const { dateExpression, ...details } = parsed.data.reservation;
    const date = resolveRelativeDate(dateExpression, referenceAt, restaurant.timezone);
    const reservation = resolveReservation({ ...details, date }, restaurant, referenceAt);
    if (Date.parse(reservation.startsAt) <= now.getTime())
      throw new DomainError(
        'PAST_RESERVATION',
        'That requested time has passed. Please choose a future date and time.',
      );
    proposal.reservation = reservation;
    proposal.readback = `Please review your reservation request: ${reservation.partySize} people on ${reservation.date} at ${reservation.time} (${reservation.timezone}), under ${reservation.name}, callback ${reservation.callbackNumber}.${reservation.notes ? ` Special requests: ${reservation.notes}.` : ''} This is a request for staff review; your table is not confirmed.`;
  } else {
    const message = parsed.data.message;
    proposal.message = message;
    proposal.readback = `Please review this message from ${message.name}, callback ${message.callbackNumber}: “${message.message}” This will be saved to the restaurant’s staff inbox.`;
  }

  return {
    ...call,
    version: call.version + 1,
    phase: 'awaiting_confirmation',
    messages: [],
    draft: {},
    proposal: { ...proposal, digest: proposalDigest(call.id, restaurant, proposal) },
    updatedAt: now.toISOString(),
  };
}

/** Invoke only after a call-bound, verified provider confirmation callback. */
export function confirmVoiceProposal(
  call: CallSession,
  proposalId: string,
  restaurant: Restaurant,
  now: Date,
): { call: CallSession; item: InboxItem } {
  assertVoiceCall(call);
  const result = confirmSimulation(call, proposalId, restaurant, now);
  return { ...result, call: { ...result.call, messages: [], draft: {} } };
}
