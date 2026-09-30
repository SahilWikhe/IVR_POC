import twilio from 'twilio';
import { z } from 'zod';

const phoneNumberSchema = z.string().regex(/^\+[1-9]\d{7,14}$/);
const restaurantLabelSchema = z
  .string()
  .refine((value) =>
    Array.from(value).every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return (
        (point >= 0x20 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff)
      );
    }),
  )
  .trim()
  .min(1)
  .max(80);

/** Fixed limits are reviewed code, rather than caller-controlled configuration. */
export const phoneFallbackLimits = Object.freeze({
  ringSeconds: 15,
  connectedSeconds: 120,
  maximumXmlCharacters: 4000,
});

export const phoneFallbackInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('announcement'),
      restaurantLabel: restaurantLabelSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('staff'),
      restaurantLabel: restaurantLabelSchema.optional(),
      aiNumber: phoneNumberSchema,
      publicRestaurantNumber: phoneNumberSchema,
      knownPlatformNumbers: z.array(phoneNumberSchema).max(50),
      destination: phoneNumberSchema,
      independentDestinationApproved: z.literal(true),
    })
    .strict()
    .refine(
      (value) =>
        ![value.aiNumber, value.publicRestaurantNumber, ...value.knownPlatformNumbers].includes(
          value.destination,
        ),
    ),
]);

export type PhoneFallbackInput = z.infer<typeof phoneFallbackInputSchema>;

export class PhoneFallbackInputError extends Error {
  constructor() {
    super('Invalid reviewed phone-fallback configuration.');
    this.name = 'PhoneFallbackInputError';
  }
}

/**
 * Generate an offline document for independent provider hosting. Approval is an
 * operator assertion: validation cannot discover carrier forwarding or ownership.
 * This function never creates a provider client or reads credentials.
 */
export function buildPhoneFallbackTwiml(input: unknown = { mode: 'announcement' }): string {
  const parsed = phoneFallbackInputSchema.safeParse(input);
  if (!parsed.success) throw new PhoneFallbackInputError();
  const value = parsed.data;
  const response = new twilio.twiml.VoiceResponse();
  if (value.restaurantLabel)
    response.say({ language: 'en-US' }, `Thank you for calling ${value.restaurantLabel}.`);
  // An outage may follow an accepted write whose acknowledgment was lost.
  // This document has no access to durable receipts and must preserve uncertainty.
  response.say(
    { language: 'en-US' },
    'The phone assistant is temporarily unavailable. We cannot confirm whether a request or message was saved.',
  );
  if (value.mode === 'staff') {
    response.say({ language: 'en-US' }, 'I will try restaurant staff now. Please hold.');
    response
      .dial({
        answerOnBridge: true,
        timeout: phoneFallbackLimits.ringSeconds,
        timeLimit: phoneFallbackLimits.connectedSeconds,
      })
      .number(value.destination);
    // Without an action callback the same document resumes after Dial. A line
    // answering can mean voicemail; no human receipt or delivery is claimed.
    response.say(
      { language: 'en-US' },
      'The transfer has ended. If you still need help, please try again later. Goodbye.',
    );
  } else {
    response.say({ language: 'en-US' }, 'Please try again later. Goodbye.');
  }
  response.hangup();
  const xml = response.toString();
  if (xml.length > phoneFallbackLimits.maximumXmlCharacters) throw new PhoneFallbackInputError();
  return xml;
}
