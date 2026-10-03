import { z } from 'zod';

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
export const providerCallSidSchema = z.string().regex(/^CA[a-fA-F0-9]{32}$/);
export const providerAccountSidSchema = z.string().regex(/^AC[a-fA-F0-9]{32}$/);
export const providerStreamSidSchema = z.string().regex(/^MZ[a-fA-F0-9]{32}$/);

export const voiceCallStateSchema = z.enum([
  'WAITING_FOR_STREAM',
  'STREAMING',
  'CONTROL_PENDING',
  'AWAITING_CONFIRMATION',
  'TRANSFER_PENDING',
  'TRANSFERRING',
  'CONNECTED_TO_STAFF',
  'NEEDS_RECONCILIATION',
  'ENDED',
]);
export type VoiceCallState = z.infer<typeof voiceCallStateSchema>;
export const voiceControlKindSchema = z.enum(['readback', 'transfer']);
export type VoiceControlKind = z.infer<typeof voiceControlKindSchema>;
export const voiceControlStateSchema = z.enum([
  'PREPARED',
  'DISPATCHED',
  'ACCEPTED',
  'UNKNOWN',
  'COMPLETED',
]);
export type VoiceControlState = z.infer<typeof voiceControlStateSchema>;

// This record carries call control, never raw audio or a conversation transcript.
// Tenant scope belongs to the authenticated transaction, not a model-selected field.
export const voiceCallRecordSchema = z
  .object({
    id,
    providerCallSid: providerCallSidSchema,
    accountSid: providerAccountSidSchema,
    version: z.number().int().positive(),
    // Existing version-two records predate durable policy; their epoch is one.
    policyVersion: z.number().int().positive().optional(),
    state: voiceCallStateSchema,
    generation: id,
    leaseExpiresAt: instant,
    streamSid: providerStreamSidSchema.nullable(),
    streamGrantHash: sha256,
    streamGrantExpiresAt: instant,
    entryTwiml: z.string().max(20_000),
    // Initial announcement ownership is sealed at admission; old records use Twilio.
    openingMode: z.enum(['twilio', 'gpt_live']).optional(),
    controlId: id.nullable(),
    controlKind: voiceControlKindSchema.nullable(),
    controlState: voiceControlStateSchema.nullable(),
    controlTwiml: z.string().max(20_000).nullable(),
    // Omitted legacy records use provider speech for readback and outcomes.
    readbackMode: z.enum(['twilio', 'gpt_live']).optional(),
    confirmationGrantHash: sha256.nullable(),
    // One additional, call/proposal-bound confirmation after uncertain input.
    // Older records omit this field and have no retry authority.
    confirmationRetryGrantHash: sha256.nullable().optional(),
    confirmationExpiresAt: instant.nullable(),
    proposalId: id.nullable(),
    transferDestination: phone.nullable(),
    transferChildSid: providerCallSidSchema.nullable(),
    outcome: z.string().max(500).nullable(),
    createdAt: instant,
    updatedAt: instant,
    endedAt: instant.nullable(),
  })
  .strict();
export type VoiceCallRecord = z.infer<typeof voiceCallRecordSchema>;

// The server supplies the utterance timestamp separately. Neither tools nor callers
// can choose tenant, call identity, configuration version, or confirmation authority.
export const voiceProposalInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('reservation'),
      reservation: z
        .object({
          dateExpression: z.string().trim().min(1).max(100),
          time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
          partySize: z.number().int().min(1).max(30),
          name: z.string().trim().min(2).max(100),
          callbackNumber: phone,
          notes: z.string().trim().max(500).default(''),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('message'),
      message: z
        .object({
          name: z.string().trim().min(2).max(100),
          callbackNumber: phone,
          message: z.string().trim().min(3).max(1500),
        })
        .strict(),
    })
    .strict(),
]);
export type VoiceProposalInput = z.infer<typeof voiceProposalInputSchema>;
