import { z } from 'zod';

export const idSchema = z.uuid();
export const isoInstantSchema = z.iso.datetime({ offset: true });
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const phoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Use an international number, such as +12125550142.');
export const roleSchema = z.enum(['owner', 'staff', 'viewer']);
export type Role = z.infer<typeof roleSchema>;

export const hoursSchema = z
  .object({
    day: z.number().int().min(0).max(6),
    closed: z.boolean(),
    open: timeSchema,
    close: timeSchema,
  })
  .strict();
export const faqSchema = z
  .object({
    id: idSchema,
    question: z.string().trim().min(3).max(160),
    answer: z.string().trim().min(2).max(800),
    keywords: z.array(z.string().trim().min(2).max(40)).max(12),
  })
  .strict();
export const menuItemSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(300),
    priceCents: z.number().int().min(0).max(100000),
    category: z.string().trim().min(1).max(60),
    available: z.boolean(),
  })
  .strict();
export const restaurantSettingsSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    timezone: z
      .string()
      .min(3)
      .max(80)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Choose a valid IANA timezone.'),
    address: z.string().trim().min(3).max(240),
    publicPhone: phoneSchema,
    greeting: z.string().trim().min(10).max(500),
    followUpMessage: z.string().trim().min(10).max(500),
    maxPartySize: z.number().int().min(1).max(30),
    maxRequestDays: z.number().int().min(1).max(365),
    hours: z
      .array(hoursSchema)
      .length(7)
      .refine(
        (hours) => new Set(hours.map((h) => h.day)).size === 7,
        'Each weekday must occur once.',
      ),
    holidayClosures: z.array(dateSchema).max(100),
    faqs: z.array(faqSchema).max(50),
    menu: z.array(menuItemSchema).max(100),
    transferLabel: z.string().trim().min(2).max(60),
    transferNumber: z.union([phoneSchema, z.literal('')]),
    transferEnabled: z.boolean(),
  })
  .strict();
export type RestaurantSettings = z.infer<typeof restaurantSettingsSchema>;
export const restaurantSchema = restaurantSettingsSchema.extend({
  id: idSchema,
  version: z.number().int().positive(),
  updatedAt: isoInstantSchema,
});
export type Restaurant = z.infer<typeof restaurantSchema>;
export const settingsUpdateSchema = z
  .object({ expectedVersion: z.number().int().positive(), settings: restaurantSettingsSchema })
  .strict();

export const reservationInputSchema = z
  .object({
    date: dateSchema,
    time: timeSchema,
    partySize: z.number().int().min(1).max(30),
    name: z.string().trim().min(2).max(100),
    callbackNumber: phoneSchema,
    notes: z.string().trim().max(500).default(''),
  })
  .strict();
export type ReservationInput = z.infer<typeof reservationInputSchema>;
export const reservationDetailsSchema = reservationInputSchema.extend({
  timezone: z.string(),
  startsAt: isoInstantSchema,
  referenceAt: isoInstantSchema,
});
export type ReservationDetails = z.infer<typeof reservationDetailsSchema>;
export const messageInputSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    callbackNumber: phoneSchema,
    message: z.string().trim().min(3).max(1500),
  })
  .strict();
export type MessageInput = z.infer<typeof messageInputSchema>;
export const requestStatusSchema = z.enum([
  'PENDING_STAFF_REVIEW',
  'ACKNOWLEDGED',
  'IN_REVIEW',
  'IN_FULFILLMENT',
  'BOOKED_AWAITING_GUEST_NOTICE',
  'DECLINED_AWAITING_GUEST_NOTICE',
  'NEEDS_RECONCILIATION',
  'CLOSED',
]);
export type RequestStatus = z.infer<typeof requestStatusSchema>;
export const inboxItemSchema = z.object({
  id: idSchema,
  callId: idSchema,
  kind: z.enum(['reservation', 'message']),
  state: requestStatusSchema,
  version: z.number().int().positive(),
  name: z.string(),
  callbackNumber: z.string(),
  reservation: reservationDetailsSchema.nullable(),
  message: z.string().nullable(),
  assignedTo: z.string().nullable(),
  leaseExpiresAt: isoInstantSchema.nullable(),
  bookingEvidence: z.string().nullable(),
  evidenceSource: z.enum(['STAFF_REPORTED']).nullable(),
  guestNotice: z.enum(['PENDING', 'ATTEMPTED', 'COMMUNICATION_RECORDED']),
  guestNoticeNote: z.string().nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const inboxActionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    action: z.enum([
      'ACKNOWLEDGE',
      'CLAIM',
      'START_FULFILLMENT',
      'RECORD_BOOKING',
      'DECLINE',
      'RECONCILE_BOOKED',
      'RECONCILE_NOT_BOOKED',
      'RECORD_GUEST_NOTICE',
      'CLOSE',
    ]),
    evidence: z.string().trim().min(3).max(500).optional(),
    noticeNote: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
export type InboxAction = z.infer<typeof inboxActionSchema>;

export const conversationMessageSchema = z.object({
  id: idSchema,
  role: z.enum(['assistant', 'caller']),
  text: z.string(),
  createdAt: isoInstantSchema,
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export const proposalSchema = z.object({
  id: idSchema,
  kind: z.enum(['reservation', 'message']),
  reservation: reservationDetailsSchema.nullable(),
  message: messageInputSchema.nullable(),
  readback: z.string(),
  digest: z.string(),
  expiresAt: isoInstantSchema,
  configVersion: z.number().int().positive(),
  referenceAt: isoInstantSchema,
});
export type Proposal = z.infer<typeof proposalSchema>;
export const conversationPhaseSchema = z.enum([
  'idle',
  'reservation_date',
  'reservation_time',
  'reservation_party',
  'reservation_name',
  'reservation_phone',
  'message_text',
  'message_name',
  'message_phone',
  'awaiting_confirmation',
  'complete',
]);
export type ConversationPhase = z.infer<typeof conversationPhaseSchema>;
export const conversationDraftSchema = z.object({
  date: z.string().optional(),
  time: z.string().optional(),
  partySize: z.number().optional(),
  name: z.string().optional(),
  callbackNumber: z.string().optional(),
  message: z.string().optional(),
  referenceAt: z.string().optional(),
});
export type ConversationDraft = z.infer<typeof conversationDraftSchema>;
export const callSessionSchema = z.object({
  id: idSchema,
  version: z.number().int().positive(),
  mode: z.enum(['simulation', 'voice']),
  status: z.enum(['active', 'ended', 'transferred', 'request_saved', 'message_saved']),
  phase: conversationPhaseSchema,
  draft: conversationDraftSchema,
  messages: z.array(conversationMessageSchema),
  proposal: proposalSchema.nullable(),
  outcome: z.string().nullable(),
  inboxItemId: idSchema.nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type CallSession = z.infer<typeof callSessionSchema>;
export const callSummarySchema = callSessionSchema.pick({
  id: true,
  mode: true,
  status: true,
  outcome: true,
  createdAt: true,
  updatedAt: true,
  inboxItemId: true,
});
export type CallSummary = z.infer<typeof callSummarySchema>;
export const turnInputSchema = z
  .object({
    text: z.string().trim().min(1).max(1500),
    clientTurnId: idSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const confirmInputSchema = z
  .object({
    proposalId: idSchema,
    expectedVersion: z.number().int().positive(),
    idempotencyKey: idSchema,
  })
  .strict();
export const integrationStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(['reservations', 'voice', 'phone']),
  status: z.enum(['active', 'simulation', 'not_configured', 'access_required']),
  description: z.string(),
  capabilities: z.array(z.string()),
});
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;
export const sessionSchema = z.object({
  authenticated: z.boolean(),
  mode: z.enum(['demo', 'oidc']),
  csrfToken: z.string().nullable(),
  user: z.object({ id: z.string(), name: z.string(), role: roleSchema }).nullable(),
  workspace: z.object({ id: idSchema, name: z.string() }).nullable(),
});
export type SessionInfo = z.infer<typeof sessionSchema>;
export const bootstrapSchema = z.object({
  restaurant: restaurantSchema,
  inbox: z.array(inboxItemSchema),
  calls: z.array(callSummarySchema),
  integrations: z.array(integrationStatusSchema),
});
export type Bootstrap = z.infer<typeof bootstrapSchema>;
export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }),
});

export interface Actor {
  userId: string;
  tenantId: string;
  role: Role;
}
export const DEMO_TENANTS = {
  harbor: '11111111-1111-4111-8111-111111111111',
  juniper: '22222222-2222-4222-8222-222222222222',
} as const;

export * from './voice.js';
