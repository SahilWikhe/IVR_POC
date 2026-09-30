import { z } from 'zod';

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const permissions = {
  voiceEnabled: z.boolean(),
  requestsEnabled: z.boolean(),
  transfersEnabled: z.boolean(),
};

// Restaurant switches can restrict the server's deployment flags. They cannot
// enable a provider connection or action that the deployment has disabled.
export const phonePolicySchema = z
  .object({
    version: z.number().int().positive(),
    ...permissions,
    updatedAt: instant,
  })
  .strict();
export type PhonePolicy = z.infer<typeof phonePolicySchema>;

export const updatePhonePolicyInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    policy: z.object(permissions).strict(),
  })
  .strict();
export type UpdatePhonePolicyInput = z.infer<typeof updatePhonePolicyInputSchema>;

// Private staff context is bounded and explicitly tied to one transfer control.
// Audio, transcripts, provider credentials, and callback grants do not belong here.
export const handoffSchema = z
  .object({
    callId: id,
    controlId: id,
    reason: z.enum(['requested_staff', 'allergy_question', 'other']),
    summary: z.string().trim().max(300),
    createdAt: instant,
  })
  .strict();
export type Handoff = z.infer<typeof handoffSchema>;
