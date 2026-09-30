import { describe, expect, it } from 'vitest';
import type { Actor, CallSession, InboxItem, Restaurant } from '@hostline/contracts';
import {
  advanceConversation,
  confirmSimulation,
  createSimulationSession,
  DomainError,
  expireFulfillment,
  resolveRelativeDate,
  resolveReservation,
  transitionInbox,
} from '@hostline/domain';

const now = new Date('2026-09-30T16:00:00.000Z');
const restaurant: Restaurant = {
  id: '11111111-1111-4111-8111-111111111111',
  version: 1,
  updatedAt: now.toISOString(),
  name: 'Synthetic Harbor',
  timezone: 'America/New_York',
  address: '1 Test Avenue',
  publicPhone: '+12125550142',
  greeting: 'Thanks for calling Synthetic Harbor. I am the AI receptionist.',
  followUpMessage: 'Staff will review your request and use your callback number to follow up.',
  maxPartySize: 12,
  maxRequestDays: 365,
  hours: Array.from({ length: 7 }, (_, day) => ({
    day,
    closed: false,
    open: '11:00',
    close: '23:00',
  })),
  holidayClosures: [],
  faqs: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      question: 'Is parking available?',
      answer: 'Metered street parking is available.',
      keywords: ['parking'],
    },
  ],
  menu: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Tomato soup',
      description: 'Tomatoes and basil',
      priceCents: 900,
      category: 'Starters',
      available: true,
    },
  ],
  transferEnabled: false,
  transferLabel: 'Host stand',
  transferNumber: '',
};
const staff: Actor = { userId: 'staff-a', tenantId: restaurant.id, role: 'staff' };
const input = {
  date: '2026-10-01',
  time: '19:00',
  partySize: 4,
  name: 'Test Guest',
  callbackNumber: '+12125550143',
  notes: '',
};

function proposalCall(at = now, setting = restaurant): CallSession {
  let call = createSimulationSession(setting, at);
  for (const text of ['table for four tomorrow at 7 pm', 'Test Guest', '+12125550143'])
    call = advanceConversation(call, text, setting, at);
  expect(call.phase).toBe('awaiting_confirmation');
  return call;
}
function requestItem(): InboxItem {
  const call = proposalCall();
  if (!call.proposal) throw new Error('Expected fixture proposal');
  return confirmSimulation(call, call.proposal.id, restaurant, now).item;
}
function action(
  item: InboxItem,
  command: Parameters<typeof transitionInbox>[1]['action'],
  actor = staff,
  at = now,
  evidence?: string,
): InboxItem {
  return transitionInbox(
    item,
    { action: command, expectedVersion: item.version, ...(evidence ? { evidence } : {}) },
    actor,
    at,
  );
}

describe('restaurant calendar validation', () => {
  it('uses the utterance date in the restaurant timezone, including midnight', () => {
    expect(
      resolveRelativeDate('tomorrow', new Date('2026-10-01T03:59:59Z'), restaurant.timezone),
    ).toBe('2026-10-01');
    expect(
      resolveRelativeDate('tomorrow', new Date('2026-10-01T04:00:00Z'), restaurant.timezone),
    ).toBe('2026-10-02');
    expect(
      resolveRelativeDate('tomorrow', new Date('2026-12-31T20:00:00Z'), restaurant.timezone),
    ).toBe('2027-01-01');
  });
  it('rejects ambiguous next-week language and impossible dates', () => {
    expect(() => resolveRelativeDate('next Friday', now, restaurant.timezone)).toThrow(
      'exact date',
    );
    expect(() => resolveRelativeDate('2026-02-30', now, restaurant.timezone)).toThrow(DomainError);
    expect(() => resolveReservation({ ...input, date: '2026-02-30' }, restaurant, now)).toThrow(
      DomainError,
    );
  });
  it('rejects skipped and repeated local times instead of selecting a DST offset', () => {
    const reference = new Date('2026-01-01T12:00:00Z');
    expect(() =>
      resolveReservation({ ...input, date: '2026-03-08', time: '02:30' }, restaurant, reference),
    ).toThrow('clock change');
    expect(() =>
      resolveReservation({ ...input, date: '2026-11-01', time: '01:30' }, restaurant, reference),
    ).toThrow('clock change');
  });
  it('enforces holidays, closed weekdays, party policy and the request horizon', () => {
    expect(() =>
      resolveReservation(input, { ...restaurant, holidayClosures: [input.date] }, now),
    ).toThrow('closed');
    expect(() =>
      resolveReservation(
        input,
        { ...restaurant, hours: restaurant.hours.map((h) => ({ ...h, closed: true })) },
        now,
      ),
    ).toThrow('closed');
    expect(() => resolveReservation({ ...input, partySize: 13 }, restaurant, now)).toThrow(
      'larger than 12',
    );
    expect(() =>
      resolveReservation(
        { ...input, date: '2026-10-03' },
        { ...restaurant, maxRequestDays: 2 },
        now,
      ),
    ).toThrow('2 days');
    expect(() => resolveReservation({ ...input, date: '2026-09-29' }, restaurant, now)).toThrow(
      'future',
    );
  });
  it('supports overnight service and excludes the exact closing time and holiday spillovers', () => {
    const night = {
      ...restaurant,
      hours: restaurant.hours.map((h) => ({ ...h, open: '18:00', close: '02:00' })),
    };
    expect(resolveReservation({ ...input, time: '01:00' }, night, now).startsAt).toBe(
      '2026-10-01T05:00:00Z',
    );
    expect(() => resolveReservation({ ...input, time: '02:00' }, night, now)).toThrow('closed');
    expect(() =>
      resolveReservation(
        { ...input, time: '01:00' },
        { ...night, holidayClosures: ['2026-09-30'] },
        now,
      ),
    ).toThrow('closed');
    expect(() =>
      resolveReservation(
        { ...input, time: '01:00' },
        { ...night, holidayClosures: ['2026-10-01'] },
        now,
      ),
    ).toThrow('closed');
  });
});

describe('scripted conversation and explicit confirmation', () => {
  it('collects natural fragments and saves a request only after exact confirmation', () => {
    const call = proposalCall();
    expect(call.mode).toBe('simulation');
    expect(call.messages[0]?.text).toContain('scripted simulation');
    expect(call.proposal?.reservation).toMatchObject({
      date: '2026-10-01',
      time: '19:00',
      partySize: 4,
    });
    expect(call.inboxItemId).toBeNull();
    const yes = advanceConversation(call, 'yes', restaurant, now);
    expect(yes.inboxItemId).toBeNull();
    expect(yes.proposal?.id).toBe(call.proposal?.id);
    if (!yes.proposal) throw new Error('Expected proposal');
    const saved = confirmSimulation(yes, yes.proposal.id, restaurant, now);
    expect(saved.item).toMatchObject({
      state: 'PENDING_STAFF_REVIEW',
      bookingEvidence: null,
      guestNotice: 'PENDING',
    });
    expect(saved.call.messages.at(-1)?.text).toContain('table is not confirmed');
    expect(() => confirmSimulation(saved.call, yes.proposal?.id ?? '', restaurant, now)).toThrow(
      'no longer',
    );
  });
  it('preserves the date utterance through a midnight crossing and rebases only a correction', () => {
    const before = new Date('2026-10-01T03:59:50Z');
    const after = new Date('2026-10-01T04:00:10Z');
    let call = advanceConversation(
      createSimulationSession(restaurant, before),
      'table for 4 tomorrow at 7 pm',
      restaurant,
      before,
    );
    call = advanceConversation(call, 'Test Guest', restaurant, after);
    call = advanceConversation(call, '+12125550143', restaurant, after);
    expect(call.proposal?.reservation?.date).toBe('2026-10-01');
    expect(call.proposal?.reservation?.referenceAt).toBe(before.toISOString());
    const originalProposalId = call.proposal?.id;
    call = advanceConversation(call, 'actually tomorrow at 8 pm', restaurant, after);
    expect(call.proposal?.id).not.toBe(originalProposalId);
    expect(call.proposal?.reservation).toMatchObject({
      date: '2026-10-02',
      time: '20:00',
      referenceAt: after.toISOString(),
    });
    expect(() => confirmSimulation(call, originalProposalId ?? '', restaurant, after)).toThrow(
      'no longer',
    );
  });
  it('binds proposals to call, restaurant, config, exact fields and expiry', () => {
    const call = proposalCall();
    if (!call.proposal?.reservation) throw new Error('Expected proposal');
    expect(() =>
      confirmSimulation(call, call.proposal?.id ?? '', { ...restaurant, version: 2 }, now),
    ).toThrow('settings changed');
    expect(() =>
      confirmSimulation(
        call,
        call.proposal?.id ?? '',
        restaurant,
        new Date(now.getTime() + 5 * 60_000),
      ),
    ).toThrow('expired');
    expect(() =>
      confirmSimulation(
        { ...call, id: '55555555-5555-4555-8555-555555555555' },
        call.proposal?.id ?? '',
        restaurant,
        now,
      ),
    ).toThrow('do not match');
    expect(() =>
      confirmSimulation(
        call,
        call.proposal?.id ?? '',
        { ...restaurant, id: '55555555-5555-4555-8555-555555555555' },
        now,
      ),
    ).toThrow('do not match');
    const changed = {
      ...call,
      proposal: { ...call.proposal, reservation: { ...call.proposal.reservation, partySize: 8 } },
    };
    expect(() => confirmSimulation(changed, changed.proposal.id, restaurant, now)).toThrow(
      'do not match',
    );
  });
  it('clears cancelled proposals and cannot interpret a name as a date correction', () => {
    let call = createSimulationSession(restaurant, now);
    call = advanceConversation(call, 'table for four tomorrow at 7 pm', restaurant, now);
    call = advanceConversation(call, 'Friday Tomorrow', restaurant, now);
    call = advanceConversation(call, '+12125550143', restaurant, now);
    expect(call.proposal?.reservation?.date).toBe('2026-10-01');
    expect(advanceConversation(call, 'cancel', restaurant, now)).toMatchObject({
      phase: 'idle',
      proposal: null,
      draft: {},
    });
  });
  it('clarifies missing time, invalid phone and unsupported party size', () => {
    let call = advanceConversation(
      createSimulationSession(restaurant, now),
      'book for 4 tomorrow at seven',
      restaurant,
      now,
    );
    expect(call.phase).toBe('reservation_time');
    call = advanceConversation(call, '7 pm', restaurant, now);
    call = advanceConversation(call, 'Test Guest', restaurant, now);
    call = advanceConversation(call, '2125550143', restaurant, now);
    expect(call.phase).toBe('reservation_phone');
    expect(call.proposal).toBeNull();
    const oversized = advanceConversation(
      createSimulationSession(restaurant, now),
      'table for 20 tomorrow',
      restaurant,
      now,
    );
    expect(oversized.phase).toBe('reservation_party');
    expect(oversized.proposal).toBeNull();
  });
  it('saves bounded messages only after readback and confirmation', () => {
    let call = createSimulationSession(restaurant, now);
    for (const text of [
      'leave a message',
      'Please call about our community dinner.',
      'Test Guest',
      '+12125550143',
    ])
      call = advanceConversation(call, text, restaurant, now);
    if (!call.proposal) throw new Error('Expected proposal');
    expect(confirmSimulation(call, call.proposal.id, restaurant, now).item).toMatchObject({
      kind: 'message',
      message: 'Please call about our community dinner.',
      state: 'PENDING_STAFF_REVIEW',
    });
  });
  it('uses approved FAQs, prices and holiday hours and escalates allergies', () => {
    const fresh = createSimulationSession(restaurant, now);
    expect(
      advanceConversation(fresh, 'What about parking?', restaurant, now).messages.at(-1)?.text,
    ).toBe('Metered street parking is available.');
    expect(
      advanceConversation(fresh, 'What is on the menu?', restaurant, now).messages.at(-1)?.text,
    ).toContain('$9.00');
    expect(
      advanceConversation(
        fresh,
        'Are you open tomorrow?',
        { ...restaurant, holidayClosures: ['2026-10-01'] },
        now,
      ).messages.at(-1)?.text,
    ).toContain('closed');
    const allergy = advanceConversation(
      fresh,
      'Is it safe for my peanut allergy?',
      restaurant,
      now,
    );
    expect(allergy.messages.at(-1)?.text).toContain('cannot guarantee');
    expect(allergy.phase).toBe('message_text');
    const transfer = advanceConversation(
      fresh,
      'a human please',
      { ...restaurant, transferEnabled: true, transferNumber: '+12125550144' },
      now,
    );
    expect(transfer.status).toBe('transferred');
    expect(transfer.messages.at(-1)?.text).toContain('no phone call was placed');
  });
  it('ends at a bounded message limit', () => {
    let call = createSimulationSession(restaurant, now);
    for (let turns = 0; turns < 60 && call.status === 'active'; turns++)
      call = advanceConversation(call, 'hello', restaurant, now);
    expect(call.messages.length).toBeLessThanOrEqual(80);
    expect(call.status).toBe('ended');
    expect(() => advanceConversation(call, 'hello', restaurant, now)).toThrow('ended');
  });
});

describe('staff workflow and fulfillment uncertainty', () => {
  it('requires roles, versions and exclusive active assignments', () => {
    const item = requestItem();
    expect(() => action(item, 'CLAIM', { ...staff, role: 'viewer' })).toThrow('cannot change');
    const claimed = action(item, 'CLAIM');
    expect(() =>
      transitionInbox(claimed, { action: 'CLAIM', expectedVersion: item.version }, staff, now),
    ).toThrow('changed');
    expect(() => action(claimed, 'CLAIM', { ...staff, userId: 'staff-b' })).toThrow(
      'Another staff',
    );
    expect(() => action(claimed, 'START_FULFILLMENT', { ...staff, userId: 'staff-b' })).toThrow(
      'Claim',
    );
    expect(() =>
      action(claimed, 'START_FULFILLMENT', staff, new Date(now.getTime() + 600_000)),
    ).toThrow('Claim');
  });
  it('releases expired review claims but keeps expired fulfillment on a reconciliation hold', () => {
    const claimed = action(requestItem(), 'CLAIM');
    const expiredAt = new Date(now.getTime() + 600_000);
    expect(expireFulfillment(claimed, now)).toBeNull();
    expect(expireFulfillment(claimed, expiredAt)).toMatchObject({
      state: 'ACKNOWLEDGED',
      assignedTo: null,
      leaseExpiresAt: null,
    });
    const started = action(claimed, 'START_FULFILLMENT');
    const expired = expireFulfillment(started, expiredAt);
    if (!expired) throw new Error('Expected expired lease');
    expect(expired).toMatchObject({ state: 'NEEDS_RECONCILIATION', assignedTo: staff.userId });
    expect(() => action(expired, 'CLAIM')).toThrow('not available');
    expect(() => action(expired, 'DECLINE')).toThrow('not available');
    expect(() => action(expired, 'START_FULFILLMENT')).toThrow('not available');
    expect(() => action(expired, 'RECONCILE_NOT_BOOKED')).toThrow('evidence');
    expect(
      action(
        expired,
        'RECONCILE_NOT_BOOKED',
        staff,
        expiredAt,
        'Staff checked the reservation book: no booking exists.',
      ),
    ).toMatchObject({ state: 'ACKNOWLEDGED', assignedTo: null });
  });
  it('keeps staff-reported booking evidence separate from guest communication', () => {
    let item = action(action(requestItem(), 'CLAIM'), 'START_FULFILLMENT');
    expect(() => action(item, 'RECORD_BOOKING')).toThrow('evidence');
    item = action(item, 'RECORD_BOOKING', staff, now, 'Synthetic booking reference TEST-123.');
    expect(item).toMatchObject({
      state: 'BOOKED_AWAITING_GUEST_NOTICE',
      evidenceSource: 'STAFF_REPORTED',
      guestNotice: 'PENDING',
    });
    expect(() => action(item, 'CLOSE')).toThrow('communication');
    item = transitionInbox(
      item,
      {
        action: 'RECORD_GUEST_NOTICE',
        expectedVersion: item.version,
        noticeNote: 'Staff reports speaking with the test guest.',
      },
      staff,
      now,
    );
    expect(action(item, 'CLOSE').state).toBe('CLOSED');
  });
  it('does not allow changing booking fields through a staff transition', () => {
    const item = action(requestItem(), 'CLAIM');
    const inputWithUnexpectedFields = {
      expectedVersion: item.version,
      action: 'START_FULFILLMENT' as const,
      reservation: { ...input, time: '20:00' },
    };
    expect(() => transitionInbox(item, inputWithUnexpectedFields, staff, now)).toThrow(
      'required action details',
    );
  });
});
