import { createHash, randomUUID } from 'node:crypto';
import {
  messageInputSchema,
  phoneSchema,
  type CallSession,
  type ConversationDraft,
  type ConversationPhase,
  type InboxItem,
  type Proposal,
  type Restaurant,
} from '@hostline/contracts';
import { DomainError } from './errors.js';
import { hoursForDate, resolveRelativeDate, resolveReservation } from './time.js';

const proposalLifetime = 5 * 60 * 1000;
const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const reservationFields: Array<{
  field: keyof ConversationDraft;
  phase: ConversationPhase;
  question: string;
}> = [
  {
    field: 'date',
    phase: 'reservation_date',
    question: 'What date would you like? You can say tomorrow or use YYYY-MM-DD.',
  },
  {
    field: 'time',
    phase: 'reservation_time',
    question:
      'What time would you like? Please include AM or PM, such as 7 PM, or use 24-hour time.',
  },
  {
    field: 'partySize',
    phase: 'reservation_party',
    question: 'How many people will be in your party?',
  },
  {
    field: 'name',
    phase: 'reservation_name',
    question: 'What name should staff use for this request?',
  },
  {
    field: 'callbackNumber',
    phase: 'reservation_phone',
    question:
      'What callback number should staff use? Include the country code, such as +12125550142.',
  },
];

function append(
  call: CallSession,
  role: 'caller' | 'assistant',
  text: string,
  now: Date,
): CallSession {
  return {
    ...call,
    messages: [
      ...call.messages,
      { id: randomUUID(), role, text, createdAt: now.toISOString() },
    ].slice(-80),
  };
}

function say(call: CallSession, text: string, now: Date): CallSession {
  return append(call, 'assistant', text, now);
}

// Digest the explicitly selected canonical fields, never object insertion order supplied by a caller.
function proposalDigest(
  callId: string,
  restaurant: Restaurant,
  proposal: Omit<Proposal, 'digest'>,
): string {
  const reservation = proposal.reservation;
  const message = proposal.message;
  return createHash('sha256')
    .update(
      JSON.stringify([
        callId,
        restaurant.id,
        proposal.id,
        proposal.kind,
        proposal.configVersion,
        proposal.referenceAt,
        proposal.expiresAt,
        proposal.readback,
        reservation
          ? [
              reservation.date,
              reservation.time,
              reservation.partySize,
              reservation.name,
              reservation.callbackNumber,
              reservation.notes,
              reservation.timezone,
              reservation.startsAt,
              reservation.referenceAt,
            ]
          : null,
        message ? [message.name, message.callbackNumber, message.message] : null,
      ]),
    )
    .digest('hex');
}

function bindProposal(
  call: CallSession,
  restaurant: Restaurant,
  proposal: Omit<Proposal, 'digest'>,
  now: Date,
): CallSession {
  const bound = { ...proposal, digest: proposalDigest(call.id, restaurant, proposal) };
  return say(
    { ...call, phase: 'awaiting_confirmation', proposal: bound },
    `${bound.readback} Use Confirm to save these exact details, or tell me what to change.`,
    now,
  );
}

export function createSimulationSession(restaurant: Restaurant, now: Date): CallSession {
  const call: CallSession = {
    id: randomUUID(),
    version: 1,
    mode: 'simulation',
    status: 'active',
    phase: 'idle',
    draft: {},
    messages: [],
    proposal: null,
    outcome: null,
    inboxItemId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return say(
    call,
    `${restaurant.greeting} This is a scripted simulation of our AI receptionist. I can answer restaurant questions, collect a reservation request for staff review, or take a message.`,
    now,
  );
}

function parseTime(text: string): string | undefined {
  const full = text.match(/\b(0?[1-9]|1[0-2])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (full?.[1] && full[3]) {
    const hour = (Number(full[1]) % 12) + (/p/i.test(full[3]) ? 12 : 0);
    return `${String(hour).padStart(2, '0')}:${full[2] ?? '00'}`;
  }
  return text.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0];
}

function parseParty(text: string, phase: ConversationPhase): number | undefined {
  const source =
    phase === 'reservation_party'
      ? text.trim().toLowerCase()
      : text
          .match(
            /\b(?:party\s+of|table\s+for|for)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i,
          )?.[1]
          ?.toLowerCase();
  if (!source) return undefined;
  if (/^\d{1,2}$/.test(source)) return Number(source);
  return numberWords[source];
}

function collectReservation(
  call: CallSession,
  text: string,
  restaurant: Restaurant,
  now: Date,
): CallSession {
  const draft = { ...call.draft };
  const phase = call.phase;
  const collectingSchedule = phase !== 'reservation_name' && phase !== 'reservation_phone';
  if (
    collectingSchedule &&
    /\b(?:today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b\d{4}-\d{2}-\d{2}\b/i.test(
      text,
    )
  ) {
    try {
      draft.date = resolveRelativeDate(text, now, restaurant.timezone);
      draft.referenceAt = now.toISOString();
    } catch (error) {
      if (error instanceof DomainError)
        return say({ ...call, proposal: null, phase: 'reservation_date' }, error.message, now);
      throw error;
    }
  }
  const time = collectingSchedule ? parseTime(text) : undefined;
  if (time) draft.time = time;
  const party = collectingSchedule ? parseParty(text, phase) : undefined;
  if (party !== undefined) {
    if (party < 1 || party > restaurant.maxPartySize)
      return say(
        { ...call, draft, phase: 'reservation_party', proposal: null },
        `Please choose a party size from 1 to ${restaurant.maxPartySize}, or ask to speak with staff for a larger group.`,
        now,
      );
    draft.partySize = party;
  }
  if (phase === 'reservation_name') {
    const name = text.trim().replace(/^(?:my name is|the name is|it'?s)\s+/i, '');
    if (name.length < 2 || name.length > 100)
      return say(call, 'Please give a name between 2 and 100 characters.', now);
    draft.name = name;
  }
  if (phase === 'reservation_phone') {
    const candidate = text.trim().replace(/[()\s-]/g, '');
    const phone = phoneSchema.safeParse(candidate);
    if (!phone.success)
      return say(
        call,
        'Please include an international callback number, such as +12125550142.',
        now,
      );
    draft.callbackNumber = phone.data;
  }
  const missing = reservationFields.find(({ field }) => draft[field] === undefined);
  if (missing)
    return say({ ...call, draft, phase: missing.phase, proposal: null }, missing.question, now);
  if (
    !draft.date ||
    !draft.time ||
    !draft.partySize ||
    !draft.name ||
    !draft.callbackNumber ||
    !draft.referenceAt
  )
    throw new DomainError('INVALID_DRAFT', 'Please start the request again.');
  try {
    const reservation = resolveReservation(
      {
        date: draft.date,
        time: draft.time,
        partySize: draft.partySize,
        name: draft.name,
        callbackNumber: draft.callbackNumber,
        notes: '',
      },
      restaurant,
      new Date(draft.referenceAt),
    );
    if (Date.parse(reservation.startsAt) <= now.getTime())
      throw new DomainError(
        'PAST_RESERVATION',
        'That time has now passed. Please choose a future date and time.',
      );
    const readback = `Please review your reservation request: ${reservation.partySize} people on ${reservation.date} at ${reservation.time} (${reservation.timezone}), under ${reservation.name}, callback ${reservation.callbackNumber}. This is a request for staff review; your table is not confirmed.`;
    return bindProposal(
      { ...call, draft },
      restaurant,
      {
        id: randomUUID(),
        kind: 'reservation',
        reservation,
        message: null,
        readback,
        expiresAt: new Date(now.getTime() + proposalLifetime).toISOString(),
        configVersion: restaurant.version,
        referenceAt: draft.referenceAt,
      },
      now,
    );
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const revised = { ...draft };
    delete revised.date;
    delete revised.time;
    delete revised.referenceAt;
    return say(
      { ...call, draft: revised, proposal: null, phase: 'reservation_date' },
      `${error.message} What date and time would you prefer?`,
      now,
    );
  }
}

function collectMessage(
  call: CallSession,
  text: string,
  restaurant: Restaurant,
  now: Date,
): CallSession {
  const draft = { ...call.draft };
  if (call.phase === 'message_text') {
    if (text.trim().length < 3)
      return say(call, 'Please give a little more detail for staff.', now);
    draft.message = text.trim();
    return say(
      { ...call, draft, phase: 'message_name' },
      'What name should staff use for this message?',
      now,
    );
  }
  if (call.phase === 'message_name') {
    if (text.trim().length < 2 || text.trim().length > 100)
      return say(call, 'Please give a name between 2 and 100 characters.', now);
    draft.name = text.trim();
    return say(
      { ...call, draft, phase: 'message_phone' },
      'What callback number should staff use? Include the country code, such as +12125550142.',
      now,
    );
  }
  const parsed = messageInputSchema.safeParse({
    name: draft.name,
    callbackNumber: text.trim().replace(/[()\s-]/g, ''),
    message: draft.message,
  });
  if (!parsed.success)
    return say(call, 'Please include an international callback number, such as +12125550142.', now);
  draft.callbackNumber = parsed.data.callbackNumber;
  const readback = `Please review this message from ${parsed.data.name}, callback ${parsed.data.callbackNumber}: “${parsed.data.message}” This will be saved to the restaurant’s staff inbox.`;
  return bindProposal(
    { ...call, draft },
    restaurant,
    {
      id: randomUUID(),
      kind: 'message',
      reservation: null,
      message: parsed.data,
      readback,
      configVersion: restaurant.version,
      referenceAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + proposalLifetime).toISOString(),
    },
    now,
  );
}

function staffHandoff(
  call: CallSession,
  restaurant: Restaurant,
  now: Date,
  allergy: boolean,
): CallSession {
  const prefix = allergy
    ? 'Staff need to answer allergy and cross-contamination questions. I cannot guarantee that a meal is safe. '
    : '';
  if (
    restaurant.transferEnabled &&
    restaurant.transferNumber &&
    restaurant.transferNumber !== restaurant.publicPhone
  ) {
    return say(
      {
        ...call,
        draft: {},
        proposal: null,
        status: 'transferred',
        phase: 'complete',
        outcome: 'Simulated staff handoff',
      },
      `${prefix}In a live call, I would try connecting you to ${restaurant.transferLabel}. This simulation ends here; no phone call was placed.`,
      now,
    );
  }
  return say(
    { ...call, draft: {}, proposal: null, phase: 'message_text' },
    `${prefix}A staff transfer is unavailable here. I can save a message for the restaurant. What would you like staff to know?`,
    now,
  );
}

export function advanceConversation(
  original: CallSession,
  text: string,
  restaurant: Restaurant,
  now: Date,
): CallSession {
  if (original.status !== 'active')
    throw new DomainError(
      'CALL_ENDED',
      'This simulated call has ended. Start a new call to continue.',
      409,
    );
  if (!text.trim() || text.length > 1500)
    throw new DomainError('INVALID_TURN', 'Please enter between 1 and 1500 characters.');
  let call = append(
    { ...original, version: original.version + 1, updatedAt: now.toISOString() },
    'caller',
    text.trim(),
    now,
  );
  if (original.messages.length >= 78)
    return say(
      {
        ...call,
        status: 'ended',
        phase: 'complete',
        draft: {},
        proposal: null,
        outcome: 'Simulation turn limit reached',
      },
      'This simulation has reached its conversation limit. Start a new call to continue.',
      now,
    );
  if (/\b(?:allerg(?:y|ies|ic|en)|cross[- ]contamination|celiac)\b/i.test(text))
    return staffHandoff(call, restaurant, now, true);
  if (
    /\b(?:human|real person|speak (?:to|with) (?:someone|staff|a person|the manager)|transfer|talk (?:to|with) (?:someone|staff|a person|the manager))\b/i.test(
      text,
    )
  )
    return staffHandoff(call, restaurant, now, false);
  if (
    /\b(?:check|look up|lookup|change|cancel)\b.*\b(?:my|existing)\s+(?:reservation|booking)\b/i.test(
      text,
    )
  )
    return staffHandoff(
      say(call, 'Staff need to look up or change existing reservations.', now),
      restaurant,
      now,
      false,
    );
  if (
    /^\s*(?:cancel|never\s?mind|start over|stop)(?:\s+(?:this|the request|request))?[.!]?\s*$/i.test(
      text,
    )
  )
    return say(
      { ...call, phase: 'idle', draft: {}, proposal: null },
      'I have cleared the unsaved details. How else can I help?',
      now,
    );
  if (call.phase === 'awaiting_confirmation') {
    if (/^\s*(?:yes|confirm|correct|that'?s right|okay|ok)[.!]?\s*$/i.test(text))
      return say(
        call,
        'Please use the Confirm button to save the exact details shown. Nothing has been saved yet.',
        now,
      );
    const kind = call.proposal?.kind;
    call = { ...call, proposal: null };
    if (kind === 'message')
      return say(
        { ...call, phase: 'message_text', draft: {} },
        'The previous message was not saved. Please give the complete revised message.',
        now,
      );
    if (/\bname\b/i.test(text)) {
      const draft = { ...call.draft };
      delete draft.name;
      return say(
        { ...call, draft, phase: 'reservation_name' },
        'What name should I use instead?',
        now,
      );
    }
    if (/\b(?:phone|number|callback)\b/i.test(text)) {
      const draft = { ...call.draft };
      delete draft.callbackNumber;
      return say(
        { ...call, draft, phase: 'reservation_phone' },
        'What international callback number should I use instead?',
        now,
      );
    }
    if (
      !parseTime(text) &&
      parseParty(text, 'idle') === undefined &&
      !/\b(?:today|tomorrow|tonight|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b\d{4}-\d{2}-\d{2}\b/i.test(
        text,
      )
    ) {
      const draft = { ...call.draft };
      delete draft.date;
      delete draft.time;
      delete draft.referenceAt;
      return say(
        { ...call, draft, phase: 'reservation_date' },
        'The previous details are no longer ready to save. Please give the date and time you would like, or say cancel.',
        now,
      );
    }
    return collectReservation({ ...call, phase: 'reservation_date' }, text, restaurant, now);
  }
  if (call.phase.startsWith('message_')) return collectMessage(call, text, restaurant, now);
  if (call.phase.startsWith('reservation_')) return collectReservation(call, text, restaurant, now);
  if (/\b(?:message|call me back|callback)\b/i.test(text))
    return say(
      { ...call, phase: 'message_text', draft: {} },
      'What would you like staff to know? Please do not include payment details, passwords, or sensitive identifiers.',
      now,
    );
  if (/\b(?:reserv(?:e|ation)|book|table|party of)\b/i.test(text)) {
    call = say(
      { ...call, draft: {} },
      'I can collect a reservation request for staff review. A request does not confirm a table.',
      now,
    );
    return collectReservation({ ...call, phase: 'reservation_date' }, text, restaurant, now);
  }
  if (/\b(?:hours|open|close|closing)\b/i.test(text)) {
    try {
      return say(
        call,
        hoursForDate(
          restaurant,
          resolveRelativeDate(
            /\b(?:today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b\d{4}-\d{2}-\d{2}\b/i.test(
              text,
            )
              ? text
              : 'today',
            now,
            restaurant.timezone,
          ),
        ),
        now,
      );
    } catch (error) {
      if (error instanceof DomainError) return say(call, error.message, now);
      throw error;
    }
  }
  if (/\b(?:address|location|where are you)\b/i.test(text))
    return say(call, `You can find us at ${restaurant.address}.`, now);
  const matchingMenu = restaurant.menu.filter(
    (item) => item.available && text.toLowerCase().includes(item.name.toLowerCase()),
  );
  if (matchingMenu.length || /\b(?:menu|food|eat|dishes|prices)\b/i.test(text)) {
    const menu = (
      matchingMenu.length ? matchingMenu : restaurant.menu.filter((item) => item.available)
    ).slice(0, 6);
    return say(
      call,
      menu.length
        ? menu
            .map(
              (item) =>
                `${item.name}: ${item.description}${item.description ? ' — ' : ''}$${(item.priceCents / 100).toFixed(2)}.`,
            )
            .join(' ')
        : 'I do not have approved menu details here. Staff can help, or I can take a message.',
      now,
    );
  }
  const faq = restaurant.faqs.find(
    (item) =>
      item.question.toLowerCase() === text.toLowerCase() ||
      item.keywords.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase())),
  );
  return say(
    call,
    faq?.answer ??
      'I can help with hours, location, menu questions, reservation requests, messages, or a staff handoff. What would you like to do?',
    now,
  );
}

export function confirmSimulation(
  call: CallSession,
  proposalId: string,
  restaurant: Restaurant,
  now: Date,
): { call: CallSession; item: InboxItem } {
  const proposal = call.proposal;
  if (
    call.status !== 'active' ||
    call.phase !== 'awaiting_confirmation' ||
    !proposal ||
    proposal.id !== proposalId ||
    call.inboxItemId !== null
  )
    throw new DomainError(
      'INVALID_CONFIRMATION',
      'This request is no longer awaiting confirmation. Review the current details.',
      409,
    );
  if (proposal.configVersion !== restaurant.version)
    throw new DomainError(
      'CONFIG_CHANGED',
      'Restaurant settings changed. Please review and confirm the details again.',
      409,
    );
  if (Date.parse(proposal.expiresAt) <= now.getTime())
    throw new DomainError(
      'CONFIRMATION_EXPIRED',
      'The confirmation has expired. Please review and confirm the details again.',
      409,
    );
  if (proposalDigest(call.id, restaurant, proposal) !== proposal.digest)
    throw new DomainError(
      'CONFIRMATION_MISMATCH',
      'The confirmed details do not match this request. Please start again.',
      409,
    );
  if (proposal.kind === 'reservation' && (!proposal.reservation || proposal.message !== null))
    throw new DomainError('INVALID_CONFIRMATION', 'Please start the request again.', 409);
  if (proposal.kind === 'message' && (!proposal.message || proposal.reservation !== null))
    throw new DomainError('INVALID_CONFIRMATION', 'Please start the message again.', 409);
  if (proposal.reservation) {
    const details = proposal.reservation;
    const current = resolveReservation(
      {
        date: details.date,
        time: details.time,
        partySize: details.partySize,
        name: details.name,
        callbackNumber: details.callbackNumber,
        notes: details.notes,
      },
      restaurant,
      new Date(details.referenceAt),
    );
    if (current.startsAt !== details.startsAt || current.timezone !== details.timezone)
      throw new DomainError(
        'CONFIRMATION_MISMATCH',
        'Please review the requested time again.',
        409,
      );
    if (Date.parse(details.startsAt) <= now.getTime())
      throw new DomainError(
        'PAST_RESERVATION',
        'The requested time has passed. Please choose a future time.',
      );
  }
  const details = proposal.reservation ?? proposal.message;
  if (!details)
    throw new DomainError('INVALID_CONFIRMATION', 'Please start the request again.', 409);
  const item: InboxItem = {
    id: randomUUID(),
    callId: call.id,
    kind: proposal.kind,
    state: 'PENDING_STAFF_REVIEW',
    version: 1,
    name: details.name,
    callbackNumber: details.callbackNumber,
    reservation: proposal.reservation,
    message: proposal.message?.message ?? null,
    assignedTo: null,
    leaseExpiresAt: null,
    bookingEvidence: null,
    evidenceSource: null,
    guestNotice: 'PENDING',
    guestNoticeNote: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const saved: CallSession = {
    ...call,
    version: call.version + 1,
    status: proposal.kind === 'reservation' ? 'request_saved' : 'message_saved',
    phase: 'complete',
    proposal: null,
    draft: {},
    inboxItemId: item.id,
    outcome:
      proposal.kind === 'reservation'
        ? 'Reservation request saved for staff review'
        : 'Message saved for staff review',
    updatedAt: now.toISOString(),
  };
  return {
    call: say(
      saved,
      proposal.kind === 'reservation'
        ? `Your reservation request was saved in the staff inbox. Your table is not confirmed. ${restaurant.followUpMessage}`
        : `Your message was saved in the staff inbox. ${restaurant.followUpMessage}`,
      now,
    ),
    item,
  };
}
