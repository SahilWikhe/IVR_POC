import {
  DEMO_TENANTS,
  restaurantSchema,
  inboxItemSchema,
  callSessionSchema,
  type Restaurant,
  type InboxItem,
  type CallSession,
} from '@hostline/contracts';
import { resolveReservation } from '@hostline/domain';

interface DemoWorkspace {
  restaurant: Restaurant;
  calls: CallSession[];
  inbox: InboxItem[];
}

export function demoData(now = new Date()): DemoWorkspace[] {
  const stamp = now.toISOString();
  const earlier = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const nextDay = new Date(now.getTime() + 86_400_000);
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(nextDay);
  const restaurant = restaurantSchema.parse({
    id: DEMO_TENANTS.harbor,
    version: 1,
    updatedAt: stamp,
    name: 'Harbor Table',
    timezone: 'America/New_York',
    address: '42 Bay Street, Brooklyn, NY 11201',
    publicPhone: '+12125550142',
    greeting:
      "Thanks for calling Harbor Table. I'm the restaurant's AI receptionist. How can I help?",
    followUpMessage:
      'Your request is saved for our team to review. Your table is not confirmed. Please wait for the restaurant to contact you.',
    maxPartySize: 12,
    maxRequestDays: 60,
    hours: Array.from({ length: 7 }, (_, day) => ({
      day,
      closed: false,
      open: day === 0 || day === 6 ? '10:00' : '11:30',
      close: day === 5 || day === 6 ? '23:00' : '22:00',
    })),
    holidayClosures: [],
    faqs: [
      {
        id: '31000000-0000-4000-8000-000000000001',
        question: 'Where can I park?',
        answer:
          'Metered street parking is available on Bay Street. The public garage on Water Street is a five-minute walk away.',
        keywords: ['parking', 'park', 'garage'],
      },
      {
        id: '31000000-0000-4000-8000-000000000002',
        question: 'Do you have outdoor seating?',
        answer:
          'Our patio is open when weather permits. You can include a patio preference with your request; seating is subject to availability.',
        keywords: ['patio', 'outdoor', 'outside'],
      },
      {
        id: '31000000-0000-4000-8000-000000000003',
        question: 'Is the restaurant accessible?',
        answer:
          'The main entrance and dining room are step-free. Our team can help with specific accessibility questions.',
        keywords: ['wheelchair', 'accessible', 'accessibility'],
      },
      {
        id: '31000000-0000-4000-8000-000000000004',
        question: 'Do you host private events?',
        answer:
          'Our private dining room can host up to 24 guests. Leave a message for the events team to discuss dates and arrangements.',
        keywords: ['private', 'events', 'party'],
      },
    ],
    menu: [
      {
        id: '32000000-0000-4000-8000-000000000001',
        name: 'Burrata & heirloom tomatoes',
        description: 'Basil, sourdough, extra virgin olive oil',
        priceCents: 1800,
        category: 'To start',
        available: true,
      },
      {
        id: '32000000-0000-4000-8000-000000000002',
        name: 'Crispy calamari',
        description: 'Lemon, herbs, roasted pepper aioli',
        priceCents: 1700,
        category: 'To start',
        available: true,
      },
      {
        id: '32000000-0000-4000-8000-000000000003',
        name: 'Pan-roasted salmon',
        description: 'Seasonal vegetables, lemon butter',
        priceCents: 3200,
        category: 'Main plates',
        available: true,
      },
      {
        id: '32000000-0000-4000-8000-000000000004',
        name: 'Wild mushroom pappardelle',
        description: 'Fresh pasta, pecorino, thyme',
        priceCents: 2600,
        category: 'Main plates',
        available: true,
      },
      {
        id: '32000000-0000-4000-8000-000000000005',
        name: 'Harbor burger',
        description: 'Aged cheddar, caramelized onion, fries',
        priceCents: 2400,
        category: 'Main plates',
        available: true,
      },
      {
        id: '32000000-0000-4000-8000-000000000006',
        name: 'Olive oil cake',
        description: 'Seasonal berries, whipped cream',
        priceCents: 1200,
        category: 'Something sweet',
        available: true,
      },
    ],
    transferLabel: 'Host stand',
    transferNumber: '',
    transferEnabled: false,
  });

  const baseInbox = {
    version: 1,
    assignedTo: null,
    leaseExpiresAt: null,
    bookingEvidence: null,
    evidenceSource: null,
    guestNotice: 'PENDING',
    guestNoticeNote: null,
  };
  const reservation = (name: string, callbackNumber: string, partySize: number, notes = '') =>
    resolveReservation(
      {
        date: localDate,
        time: '19:00',
        partySize,
        name,
        callbackNumber,
        notes,
      },
      restaurant,
      new Date(earlier(12)),
    );
  const inbox = [
    inboxItemSchema.parse({
      ...baseInbox,
      id: '41000000-0000-4000-8000-000000000001',
      callId: '51000000-0000-4000-8000-000000000001',
      kind: 'reservation',
      state: 'PENDING_STAFF_REVIEW',
      name: 'Jordan Ellis',
      callbackNumber: '+12125550101',
      reservation: reservation('Jordan Ellis', '+12125550101', 4, 'Patio seating if available'),
      message: null,
      createdAt: earlier(12),
      updatedAt: earlier(12),
    }),
    inboxItemSchema.parse({
      ...baseInbox,
      id: '41000000-0000-4000-8000-000000000002',
      callId: '51000000-0000-4000-8000-000000000002',
      kind: 'message',
      state: 'PENDING_STAFF_REVIEW',
      name: 'Morgan Lee',
      callbackNumber: '+12125550102',
      reservation: null,
      message:
        'Interested in the private dining room for a team dinner of 18. Please call back with details.',
      createdAt: earlier(34),
      updatedAt: earlier(34),
    }),
    inboxItemSchema.parse({
      ...baseInbox,
      id: '41000000-0000-4000-8000-000000000003',
      callId: '51000000-0000-4000-8000-000000000003',
      kind: 'reservation',
      state: 'ACKNOWLEDGED',
      name: 'Alex Rivera',
      callbackNumber: '+12125550103',
      reservation: reservation('Alex Rivera', '+12125550103', 2, 'Celebrating an anniversary'),
      message: null,
      createdAt: earlier(58),
      updatedAt: earlier(25),
    }),
  ];
  const calls = inbox.map((item) =>
    callSessionSchema.parse({
      id: item.callId,
      version: 1,
      mode: 'simulation',
      status: item.kind === 'reservation' ? 'request_saved' : 'message_saved',
      phase: 'complete',
      draft: {},
      messages: [],
      proposal: null,
      outcome:
        item.kind === 'reservation'
          ? 'Reservation request saved for staff review; table not confirmed.'
          : 'Message saved for staff review.',
      inboxItemId: item.id,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }),
  );
  calls.push(
    callSessionSchema.parse({
      id: '51000000-0000-4000-8000-000000000004',
      version: 1,
      mode: 'simulation',
      status: 'ended',
      phase: 'complete',
      draft: {},
      messages: [],
      proposal: null,
      outcome: 'Answered a question about parking.',
      inboxItemId: null,
      createdAt: earlier(80),
      updatedAt: earlier(78),
    }),
  );

  const secondRestaurant = restaurantSchema.parse({
    ...restaurant,
    id: DEMO_TENANTS.juniper,
    name: 'Juniper Kitchen',
    address: '18 Garden Lane, Brooklyn, NY 11201',
    publicPhone: '+12125550143',
    greeting:
      "Thanks for calling Juniper Kitchen. I'm the restaurant's AI receptionist. How can I help?",
  });
  return [
    { restaurant, calls, inbox },
    { restaurant: secondRestaurant, calls: [], inbox: [] },
  ];
}
