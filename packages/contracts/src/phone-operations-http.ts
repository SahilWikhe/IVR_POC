import { z } from 'zod';
import { inboxItemSchema, messageInputSchema, reservationDetailsSchema } from './base.js';
import { handoffSchema, phonePolicySchema } from './phone-operations.js';
import { voiceCallStateSchema, voiceControlKindSchema, voiceControlStateSchema } from './voice.js';

export const phoneCallSummarySchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    state: voiceCallStateSchema,
    controlKind: voiceControlKindSchema.nullable(),
    controlState: voiceControlStateSchema.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }).nullable(),
    outcome: z.string().max(500).nullable(),
    capacityHeld: z.boolean(),
    requiresReconciliation: z.boolean(),
  })
  .strict();
export type PhoneCallSummary = z.infer<typeof phoneCallSummarySchema>;
export const phoneOperationsSchema = z
  .object({
    policy: phonePolicySchema,
    configured: z
      .object({
        voiceEnabled: z.boolean(),
        requestsEnabled: z.boolean(),
        transfersEnabled: z.boolean(),
        reconciliationAvailable: z.boolean(),
      })
      .strict(),
    calls: z.array(phoneCallSummarySchema).max(50),
    hasMore: z.boolean(),
  })
  .strict();
export type PhoneOperations = z.infer<typeof phoneOperationsSchema>;

export const phoneCallDetailSchema = z
  .object({
    call: phoneCallSummarySchema,
    context: handoffSchema.extend({ source: z.literal('AI_UNTRUSTED') }).nullable(),
    pendingProposal: z
      .object({
        id: z.uuid(),
        kind: z.enum(['reservation', 'message']),
        readback: z.string().max(2000),
        expiresAt: z.iso.datetime({ offset: true }),
        reservation: reservationDetailsSchema.nullable(),
        message: messageInputSchema.nullable(),
      })
      .strict()
      .nullable(),
    savedItem: inboxItemSchema.nullable(),
  })
  .strict();
export type PhoneCallDetail = z.infer<typeof phoneCallDetailSchema>;
export const phoneReconcileResultSchema = z
  .object({
    call: phoneCallSummarySchema,
    result: z.enum(['ended', 'held', 'unavailable']),
    message: z.string().max(300),
  })
  .strict();
export type PhoneReconcileResult = z.infer<typeof phoneReconcileResultSchema>;
