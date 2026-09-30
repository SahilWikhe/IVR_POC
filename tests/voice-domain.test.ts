import { describe, expect, it } from 'vitest';
import { callSessionSchema, voiceCallRecordSchema, type Restaurant } from '@hostline/contracts';
import {
  confirmVoiceProposal,
  createSimulationSession,
  createVoiceSession,
  prepareVoiceProposal,
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
  maxRequestDays: 90,
  hours: Array.from({ length: 7 }, (_, day) => ({
    day,
    closed: false,
    open: '11:00',
    close: '23:00',
  })),
  holidayClosures: [],
  faqs: [],
  menu: [],
  transferEnabled: false,
  transferLabel: 'Host stand',
  transferNumber: '',
};
const reservationInput = {
  kind: 'reservation' as const,
  reservation: {
    dateExpression: 'tomorrow',
    time: '19:00',
    partySize: 4,
    name: 'Synthetic Guest',
    callbackNumber: '+12125550143',
    notes: 'Accessible seating requested',
  },
};
const messageInput = {
  kind: 'message' as const,
  message: {
    name: 'Synthetic Guest',
    callbackNumber: '+12125550143',
    message: 'Please call about the community dinner.',
  },
};

function proposalCall(input = reservationInput) {
  return prepareVoiceProposal(createVoiceSession(restaurant, now), restaurant, input, now, now);
}

describe('phone proposals and deterministic confirmation', () => {
  it('stores structured requests only and binds a verbatim request-only readback', () => {
    const initial = createVoiceSession(restaurant, now);
    expect(callSessionSchema.parse(initial)).toMatchObject({
      mode: 'voice',
      phase: 'idle',
      messages: [],
      draft: {},
      proposal: null,
    });
    const call = prepareVoiceProposal(initial, restaurant, reservationInput, now, now);
    expect(call).toMatchObject({
      version: 2,
      phase: 'awaiting_confirmation',
      messages: [],
      draft: {},
      inboxItemId: null,
    });
    const proposal = call.proposal;
    if (!proposal) throw new Error('Expected proposal');
    expect(proposal.reservation).toMatchObject({
      date: '2026-10-01',
      referenceAt: now.toISOString(),
      startsAt: '2026-10-01T23:00:00Z',
    });
    expect(proposal.readback).toContain('Accessible seating requested');
    expect(proposal.readback).toContain('table is not confirmed');
    const result = confirmVoiceProposal(call, proposal.id, restaurant, now);
    expect(result.item).toMatchObject({
      callId: call.id,
      state: 'PENDING_STAFF_REVIEW',
      bookingEvidence: null,
      guestNotice: 'PENDING',
      reservation: proposal.reservation,
    });
    expect(result.call).toMatchObject({
      mode: 'voice',
      status: 'request_saved',
      phase: 'complete',
      messages: [],
      draft: {},
      proposal: null,
      inboxItemId: result.item.id,
    });
    expect(() => confirmVoiceProposal(result.call, proposal.id, restaurant, now)).toThrow(
      'no longer',
    );
  });

  it('uses the server utterance anchor across midnight and freezes the explicit date', () => {
    const before = new Date('2026-10-01T03:59:50Z');
    const after = new Date('2026-10-01T04:00:10Z');
    const initial = createVoiceSession(restaurant, before);
    const call = prepareVoiceProposal(initial, restaurant, reservationInput, before, after);
    if (!call.proposal) throw new Error('Expected proposal');
    expect(call.proposal.reservation).toMatchObject({
      date: '2026-10-01',
      referenceAt: before.toISOString(),
    });
    const result = confirmVoiceProposal(call, call.proposal.id, restaurant, after);
    expect(result.item.reservation?.date).toBe('2026-10-01');
    const changed = prepareVoiceProposal(call, restaurant, reservationInput, after, after);
    expect(changed.proposal?.reservation?.date).toBe('2026-10-02');
    expect(changed.proposal?.id).not.toBe(call.proposal.id);
    expect(() => confirmVoiceProposal(changed, call.proposal?.id ?? '', restaurant, after)).toThrow(
      'no longer awaiting',
    );
  });

  it('rejects model authority fields and invented server timestamps', () => {
    const initial = createVoiceSession(restaurant, now);
    const modelSelectedReference = { ...reservationInput, referenceAt: now.toISOString() };
    const modelSelectedTenant = {
      ...reservationInput,
      reservation: { ...reservationInput.reservation, tenantId: restaurant.id },
    };
    expect(() =>
      prepareVoiceProposal(initial, restaurant, modelSelectedReference, now, now),
    ).toThrow('complete request details');
    expect(() => prepareVoiceProposal(initial, restaurant, modelSelectedTenant, now, now)).toThrow(
      'complete request details',
    );
    for (const invalidReference of [
      new Date('invalid'),
      new Date(now.getTime() + 1),
      new Date(now.getTime() - 1),
    ])
      expect(() =>
        prepareVoiceProposal(initial, restaurant, reservationInput, invalidReference, now),
      ).toThrow('repeat the requested date');
    expect(() =>
      prepareVoiceProposal(initial, restaurant, reservationInput, now, new Date('invalid')),
    ).toThrow('repeat the requested date');
  });

  it('validates restaurant hours, party policy, horizon, exact time and callback fields', () => {
    const initial = createVoiceSession(restaurant, now);
    expect(() =>
      prepareVoiceProposal(
        initial,
        { ...restaurant, holidayClosures: ['2026-10-01'] },
        reservationInput,
        now,
        now,
      ),
    ).toThrow('closed');
    expect(() =>
      prepareVoiceProposal(
        initial,
        restaurant,
        { ...reservationInput, reservation: { ...reservationInput.reservation, partySize: 13 } },
        now,
        now,
      ),
    ).toThrow('larger than 12');
    expect(() =>
      prepareVoiceProposal(
        initial,
        restaurant,
        {
          ...reservationInput,
          reservation: { ...reservationInput.reservation, dateExpression: '2027-04-01' },
        },
        now,
        now,
      ),
    ).toThrow('90 days');
    expect(() =>
      prepareVoiceProposal(
        initial,
        restaurant,
        {
          ...reservationInput,
          reservation: { ...reservationInput.reservation, dateExpression: 'next Friday' },
        },
        now,
        now,
      ),
    ).toThrow('exact date');
    for (const patch of [{ time: '7 PM' }, { callbackNumber: '2125550143' }, { name: '' }])
      expect(() =>
        prepareVoiceProposal(
          initial,
          restaurant,
          { ...reservationInput, reservation: { ...reservationInput.reservation, ...patch } },
          now,
          now,
        ),
      ).toThrow('complete request details');
  });

  it('rejects stale configuration, expiration, altered fields/readback and call/tenant substitution', () => {
    const call = proposalCall();
    const proposal = call.proposal;
    if (!proposal?.reservation) throw new Error('Expected reservation proposal');
    expect(() =>
      confirmVoiceProposal(call, proposal.id, { ...restaurant, version: 2 }, now),
    ).toThrow('settings changed');
    expect(() =>
      confirmVoiceProposal(call, proposal.id, restaurant, new Date(proposal.expiresAt)),
    ).toThrow('expired');
    expect(() =>
      confirmVoiceProposal(
        { ...call, id: '55555555-5555-4555-8555-555555555555' },
        proposal.id,
        restaurant,
        now,
      ),
    ).toThrow('do not match');
    expect(() =>
      confirmVoiceProposal(
        call,
        proposal.id,
        { ...restaurant, id: '55555555-5555-4555-8555-555555555555' },
        now,
      ),
    ).toThrow('do not match');
    for (const changedProposal of [
      { ...proposal, readback: 'Your table is booked.' },
      { ...proposal, referenceAt: '2026-10-01T16:00:00.000Z' },
      { ...proposal, expiresAt: new Date(now.getTime() + 600_000).toISOString() },
      { ...proposal, reservation: { ...proposal.reservation, partySize: 8 } },
      { ...proposal, reservation: { ...proposal.reservation, notes: 'Changed after readback' } },
    ])
      expect(() =>
        confirmVoiceProposal({ ...call, proposal: changedProposal }, proposal.id, restaurant, now),
      ).toThrow('do not match');
  });

  it('saves a confirmed message without retaining full conversation content', () => {
    const initial = {
      ...createVoiceSession(restaurant, now),
      messages: [
        {
          id: restaurant.id,
          role: 'caller' as const,
          text: 'Synthetic conversation',
          createdAt: now.toISOString(),
        },
      ],
      draft: { message: 'Synthetic conversation' },
    };
    const call = prepareVoiceProposal(initial, restaurant, messageInput, now, now);
    if (!call.proposal) throw new Error('Expected message proposal');
    expect(call.messages).toEqual([]);
    expect(call.draft).toEqual({});
    const result = confirmVoiceProposal(call, call.proposal.id, restaurant, now);
    expect(result.item).toMatchObject({
      kind: 'message',
      name: messageInput.message.name,
      message: messageInput.message.message,
      reservation: null,
    });
    expect(result.call.messages).toEqual([]);
    expect(result.call.status).toBe('message_saved');
  });

  it('rejects simulator and ended sessions at the phone action boundary', () => {
    const simulation = createSimulationSession(restaurant, now);
    expect(() => prepareVoiceProposal(simulation, restaurant, reservationInput, now, now)).toThrow(
      'authenticated phone call',
    );
    expect(() => confirmVoiceProposal(simulation, restaurant.id, restaurant, now)).toThrow(
      'authenticated phone call',
    );
    expect(() =>
      prepareVoiceProposal(
        { ...createVoiceSession(restaurant, now), status: 'ended' },
        restaurant,
        reservationInput,
        now,
        now,
      ),
    ).toThrow('no longer accepting');
  });
});

describe('durable voice record contract', () => {
  const record = {
    id: restaurant.id,
    providerCallSid: `CA${'a'.repeat(32)}`,
    accountSid: `AC${'b'.repeat(32)}`,
    version: 1,
    state: 'WAITING_FOR_STREAM' as const,
    generation: '55555555-5555-4555-8555-555555555555',
    leaseExpiresAt: now.toISOString(),
    streamSid: null,
    streamGrantHash: 'a'.repeat(64),
    streamGrantExpiresAt: now.toISOString(),
    entryTwiml: '<Response/>',
    controlId: null,
    controlKind: null,
    controlState: null,
    controlTwiml: null,
    confirmationGrantHash: null,
    confirmationExpiresAt: null,
    proposalId: null,
    transferDestination: null,
    transferChildSid: null,
    outcome: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    endedAt: null,
  };
  it('validates provider-bound IDs and refuses tenant selection or transcript storage fields', () => {
    expect(voiceCallRecordSchema.safeParse(record).success).toBe(true);
    for (const patch of [
      { providerCallSid: 'not-a-call' },
      { accountSid: `CA${'b'.repeat(32)}` },
      { streamSid: `CA${'b'.repeat(32)}` },
      { streamGrantHash: 'short' },
      { entryTwiml: 'x'.repeat(20_001) },
      { tenantId: restaurant.id },
      { transcript: 'Synthetic caller transcript' },
      { rawAudio: 'Synthetic encoded audio' },
    ])
      expect(voiceCallRecordSchema.safeParse({ ...record, ...patch }).success).toBe(false);
  });
});
