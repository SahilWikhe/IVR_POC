import twilio from 'twilio';
import { z } from 'zod';

const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const originSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  });
const plainText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) =>
      Array.from(value).every((character) => {
        const point = character.codePointAt(0) ?? 0;
        return (
          point === 9 ||
          point === 10 ||
          point === 13 ||
          (point >= 0x20 && point <= 0xd7ff) ||
          (point >= 0xe000 && point <= 0xfffd) ||
          (point >= 0x10000 && point <= 0x10ffff)
        );
      }),
    );

const readbackSchema = z
  .object({
    publicUrl: originSchema,
    confirmationToken: tokenSchema,
    readback: plainText(2000),
  })
  .strict();
const transferSchema = z
  .object({
    publicUrl: originSchema,
    transferToken: tokenSchema,
    destination: z.string().regex(/^\+[1-9]\d{7,14}$/),
    staffLabel: plainText(160),
    remainingSeconds: z.number().int().min(25).max(600),
  })
  .strict();

export class TelephonyInputError extends Error {
  constructor() {
    super('Invalid server-authored call-control input.');
    this.name = 'TelephonyInputError';
  }
}

function serialize(response: InstanceType<typeof twilio.twiml.VoiceResponse>): string {
  const xml = response.toString();
  // Bound the escaped document, not only its unescaped source text.
  if (xml.length > 4000) throw new TelephonyInputError();
  return xml;
}

/** The API supplies the immutable canonical readback and a server-issued bound token. */
export function buildReadbackTwiml(input: {
  publicUrl: string;
  confirmationToken: string;
  readback: string;
}): string {
  const parsed = readbackSchema.safeParse(input);
  if (!parsed.success) throw new TelephonyInputError();
  const { publicUrl, confirmationToken, readback } = parsed.data;
  const response = new twilio.twiml.VoiceResponse();
  // Outside Gather: recognition cannot interrupt or affirm a partly played readback.
  response.say({ language: 'en-US' }, readback);
  response
    .gather({
      action: `${new URL(publicUrl).origin}/twilio/confirmation/${confirmationToken}`,
      method: 'POST',
      input: ['speech'],
      timeout: 5,
      speechTimeout: 'auto',
      maxSpeechTime: 5,
      hints: 'yes, no',
      language: 'en-US',
      actionOnEmptyResult: true,
    })
    .say(
      { language: 'en-US' },
      'Say yes to save this unconfirmed request for staff review, or say no to cancel. This does not book a table.',
    );
  // Defensive fallthrough, never a write. HTTP action failures still need a
  // separately configured provider-hosted failure URL.
  response.say(
    { language: 'en-US' },
    'I could not confirm that your request was saved. Please contact the restaurant directly.',
  );
  response.hangup();
  return serialize(response);
}

/** Destination must already be authorized from current restaurant configuration. */
export function buildTransferTwiml(input: {
  publicUrl: string;
  transferToken: string;
  destination: string;
  staffLabel: string;
  remainingSeconds: number;
}): string {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) throw new TelephonyInputError();
  const { publicUrl, transferToken, destination, remainingSeconds } = parsed.data;
  const origin = new URL(publicUrl).origin;
  const response = new twilio.twiml.VoiceResponse();
  // Reserve 8 seconds for this fixed short announcement, 5 seconds for
  // provider ring-time variance, and 2 seconds for control/fallback overhead.
  // A caller-selected label must not lengthen the spoken announcement.
  const reservedSeconds = 15;
  const timeout = Math.min(20, remainingSeconds - reservedSeconds - 5);
  const timeLimit = remainingSeconds - reservedSeconds - timeout;
  response.say({ language: 'en-US' }, 'I will try restaurant staff now. Please hold.');
  response
    .dial({
      action: `${origin}/twilio/transfer-result/${transferToken}`,
      method: 'POST',
      answerOnBridge: true,
      timeout,
      timeLimit,
    })
    .number(
      {
        statusCallback: `${origin}/twilio/transfer-status/${transferToken}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      },
      destination,
    );
  response.say(
    { language: 'en-US' },
    'The transfer has ended. Please contact the restaurant directly if you still need help.',
  );
  response.hangup();
  return serialize(response);
}
