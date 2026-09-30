import twilio from 'twilio';
import RequestClient from 'twilio/lib/base/RequestClient.js';
import RestException from 'twilio/lib/base/RestException.js';
import { z } from 'zod';

export { buildReadbackTwiml, buildTransferTwiml } from '@hostline/connectors';

export type CallControlRejectionCode =
  | 'INVALID_CALL_ID'
  | 'INVALID_TWIML'
  | 'ABORTED_BEFORE_DISPATCH'
  | 'TARGET_NOT_ALLOWED'
  | 'NOT_AUTHORIZED'
  | 'CALL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'PROVIDER_REJECTED';
export type CallControlResult =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; code: CallControlRejectionCode }
  | { outcome: 'unknown' };
export type CallControlTransport = (request: {
  callSid: string;
  twiml: string;
  signal: AbortSignal;
}) => Promise<void>;
export interface CallController {
  dispatch(callSid: string, twiml: string, signal?: AbortSignal): Promise<CallControlResult>;
}

const configSchema = z
  .object({
    accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
    authToken: z.string().min(16).max(256),
    maxCallSeconds: z.number().int().min(15).max(600).optional(),
    publicUrl: z
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
      }),
  })
  .strict();
const callSidSchema = z.string().regex(/^CA[0-9a-fA-F]{32}$/);
const xmlSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => value.includes('<Response>') && value.endsWith('</Response>'));

class TargetNotAllowed extends Error {}

function sdkTransport(
  config: z.infer<typeof configSchema>,
  timeoutMs: number,
): CallControlTransport {
  return async ({ callSid, twiml, signal }) => {
    // One SDK client per dispatch gives its signal and temporary response state
    // one owner. Concurrent calls never share cancellation or HTTP interceptors.
    const httpClient = new RequestClient({
      timeout: timeoutMs,
      autoRetry: false,
      keepAlive: false,
    });
    const expectedUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls/${callSid}.json`;
    httpClient.axios.interceptors.request.use((request) => {
      if (request.url !== expectedUrl || request.method?.toLowerCase() !== 'post')
        throw new TargetNotAllowed();
      request.signal = signal;
      request.timeout = timeoutMs;
      request.maxRedirects = 0;
      request.maxContentLength = 64 * 1024;
      request.maxBodyLength = 32 * 1024;
      return request;
    });
    const client = twilio(config.accountSid, config.authToken, {
      httpClient,
      timeout: timeoutMs,
      autoRetry: false,
      edge: '',
      region: '',
      logLevel: 'error',
    });
    try {
      const acknowledgement = await client.calls(callSid).update({
        twiml,
        ...(config.maxCallSeconds === undefined ? {} : { timeLimit: config.maxCallSeconds }),
      });
      if (acknowledgement.sid !== callSid || acknowledgement.accountSid !== config.accountSid)
        throw new Error('Invalid call-control acknowledgement.');
    } finally {
      // SDK diagnostic state can contain credentials and the canonical payload;
      // do not retain it as application evidence or include it in logs.
      delete httpClient.lastRequest;
      delete httpClient.lastResponse;
      httpClient.axios.interceptors.request.clear();
    }
  };
}

function rejection(error: unknown): CallControlResult {
  if (error instanceof TargetNotAllowed) return { outcome: 'rejected', code: 'TARGET_NOT_ALLOWED' };
  if (error instanceof RestException) {
    if (error.status === 401 || error.status === 403)
      return { outcome: 'rejected', code: 'NOT_AUTHORIZED' };
    if (error.status === 404 || error.status === 410)
      return { outcome: 'rejected', code: 'CALL_UNAVAILABLE' };
    if (error.status === 429) return { outcome: 'rejected', code: 'RATE_LIMITED' };
    if ([400, 405, 415, 422].includes(error.status))
      return { outcome: 'rejected', code: 'PROVIDER_REJECTED' };
  }
  // Reset, timeout, parse failure, 5xx, and cancellation after admission cannot
  // establish whether Twilio accepted the update. The caller must reconcile.
  return { outcome: 'unknown' };
}

export function createCallController(
  config: {
    accountSid: string;
    authToken: string;
    publicUrl: string;
    maxCallSeconds?: number;
  },
  dependencies: { transport?: CallControlTransport; timeoutMs?: number } = {},
): CallController {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new Error('Invalid call-control server configuration.');
  const timeoutMs = dependencies.timeoutMs ?? 4500;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error('Invalid call-control timeout.');
  const transport = dependencies.transport ?? sdkTransport(parsed.data, timeoutMs);
  return {
    async dispatch(callSid, twiml, signal) {
      if (!callSidSchema.safeParse(callSid).success)
        return { outcome: 'rejected', code: 'INVALID_CALL_ID' };
      if (!xmlSchema.safeParse(twiml).success)
        return { outcome: 'rejected', code: 'INVALID_TWIML' };
      if (signal?.aborted) return { outcome: 'rejected', code: 'ABORTED_BEFORE_DISPATCH' };
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let removeCancellation: (() => void) | undefined;
      try {
        // An explicit deadline also bounds custom/mock transports that ignore
        // signals. It never treats racing or late provider success as safe retry.
        const cancellation = new Promise<CallControlResult>((resolve) => {
          const cancelled = () => resolve({ outcome: 'unknown' });
          controller.signal.addEventListener('abort', cancelled, { once: true });
          removeCancellation = () => controller.signal.removeEventListener('abort', cancelled);
          deadline = setTimeout(abort, timeoutMs);
        });
        let pending: Promise<CallControlResult>;
        try {
          pending = transport({ callSid, twiml, signal: controller.signal }).then(
            (): CallControlResult => ({ outcome: 'accepted' }),
            (error: unknown) => rejection(error),
          );
        } catch (error) {
          return rejection(error);
        }
        return await Promise.race([pending, cancellation]);
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        removeCancellation?.();
      }
    },
  };
}
