import twilio from 'twilio';
import RequestClient from 'twilio/lib/base/RequestClient.js';
import { z } from 'zod';

const accountSidSchema = z.string().regex(/^AC[0-9a-fA-F]{32}$/);
const callSidSchema = z.string().regex(/^CA[0-9a-fA-F]{32}$/);
export const providerCallStatusSchema = z.enum([
  'queued',
  'ringing',
  'in-progress',
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
]);
export type ProviderCallStatus = z.infer<typeof providerCallStatusSchema>;
const childSchema = z.object({ callSid: callSidSchema, status: providerCallStatusSchema }).strict();
export const callStatusResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('known'),
      callSid: callSidSchema,
      accountSid: accountSidSchema,
      status: providerCallStatusSchema,
      children: z.array(childSchema).max(20),
      childrenComplete: z.boolean(),
    })
    .strict(),
  z.object({ outcome: z.literal('unavailable') }).strict(),
]);
export type CallStatusResult = z.infer<typeof callStatusResultSchema>;
export interface CallStatusRequest {
  accountSid: string;
  callSid: string;
  includeChildren: boolean;
}
export interface CallStatusReader {
  read(request: CallStatusRequest, signal?: AbortSignal): Promise<CallStatusResult>;
}
export type CallStatusTransport = (
  request: CallStatusRequest & { signal: AbortSignal },
) => Promise<unknown>;

const requestSchema = z
  .object({ accountSid: accountSidSchema, callSid: callSidSchema, includeChildren: z.boolean() })
  .strict();
const configSchema = z
  .object({ accountSid: accountSidSchema, authToken: z.string().min(16).max(256) })
  .strict();
const providerResourceSchema = z.object({
  sid: callSidSchema,
  accountSid: accountSidSchema,
  status: providerCallStatusSchema,
});
const providerChildSchema = providerResourceSchema.extend({ parentCallSid: callSidSchema });
const providerChildrenEnvelopeSchema = z.object({
  calls: z.array(z.unknown()).max(20),
  next_page_uri: z.string().min(1).max(2048).nullable(),
  uri: z.string().min(1).max(2048),
  meta: z.never().optional(),
});

export function isTerminalProviderStatus(status: ProviderCallStatus): boolean {
  return ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status);
}

function sdkTransport(
  config: z.infer<typeof configSchema>,
  timeoutMs: number,
): CallStatusTransport {
  return async ({ callSid, includeChildren, signal }) => {
    const httpClient = new RequestClient({
      timeout: timeoutMs,
      autoRetry: false,
      keepAlive: false,
    });
    const accountCalls = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls`;
    let verifiedChildrenComplete = false;
    httpClient.axios.interceptors.request.use((request) => {
      const parentRequest = request.url === `${accountCalls}/${callSid}.json`;
      const childrenRequest = request.url === `${accountCalls}.json` && includeChildren;
      if (request.method?.toLowerCase() !== 'get' || (!parentRequest && !childrenRequest))
        throw new Error('Call status target is not allowed.');
      if (
        childrenRequest &&
        !z
          .object({ ParentCallSid: z.literal(callSid), PageSize: z.literal(20) })
          .strict()
          .safeParse(request.params).success
      )
        throw new Error('Call status query is not allowed.');
      request.signal = signal;
      request.timeout = timeoutMs;
      request.maxRedirects = 0;
      request.maxContentLength = 64 * 1024;
      request.maxBodyLength = 0;
      return request;
    });
    httpClient.axios.interceptors.response.use((response) => {
      if (response.config.url === `${accountCalls}.json`) {
        // The SDK turns missing/malformed pagination metadata into no next
        // page. Require an explicit null in the authenticated raw envelope
        // before treating the enumeration as complete.
        const raw: unknown =
          typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        const envelope = providerChildrenEnvelopeSchema.parse(raw);
        const pageUrl = new URL(envelope.uri, 'https://api.twilio.com');
        if (
          pageUrl.origin !== 'https://api.twilio.com' ||
          pageUrl.pathname !== `/2010-04-01/Accounts/${config.accountSid}/Calls.json` ||
          pageUrl.username ||
          pageUrl.password ||
          pageUrl.hash
        )
          throw new Error('Call status page identity does not match the configured account.');
        verifiedChildrenComplete = envelope.next_page_uri === null;
        // Legacy v2010 lists use calls/next_page_uri. The SDK also accepts
        // modern meta.key and arbitrary first array fields; remove that
        // ambiguity so its instances are exactly the validated calls array.
        response.data = {
          calls: envelope.calls,
          next_page_uri: envelope.next_page_uri,
          previous_page_uri: null,
          first_page_uri: null,
          uri: envelope.uri,
          page: 0,
          page_size: 20,
        };
      }
      return response;
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
      const parent = providerResourceSchema.parse(await client.calls(callSid).fetch());
      if (parent.sid !== callSid || parent.accountSid !== config.accountSid)
        throw new Error('Call status does not match the configured call.');
      const children: Array<z.infer<typeof childSchema>> = [];
      let childrenComplete = !includeChildren;
      if (includeChildren) {
        // Fetch exactly one bounded page. An additional page is an uncertainty
        // hold, never permission to release capacity or make another call.
        const page = await client.calls.page({ parentCallSid: callSid, pageSize: 20 });
        if (page.instances.length > 20) throw new Error('Call status page exceeds the bound.');
        for (const rawChild of page.instances) {
          const child = providerChildSchema.parse(rawChild);
          if (child.accountSid !== config.accountSid || child.parentCallSid !== callSid)
            throw new Error('Call status child is not bound to the configured parent.');
          children.push({ callSid: child.sid, status: child.status });
        }
        childrenComplete = verifiedChildrenComplete;
      }
      return {
        outcome: 'known',
        callSid: parent.sid,
        accountSid: parent.accountSid,
        status: parent.status,
        children,
        childrenComplete,
      };
    } finally {
      delete httpClient.lastRequest;
      delete httpClient.lastResponse;
      httpClient.axios.interceptors.request.clear();
      httpClient.axios.interceptors.response.clear();
    }
  };
}

/** Sandbox-only read adapter; no call updates, retries, pagination, or retained provider bodies. */
export function createCallStatusReader(
  config: { accountSid: string; authToken: string },
  dependencies: { transport?: CallStatusTransport; timeoutMs?: number } = {},
): CallStatusReader {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new Error('Invalid call status server configuration.');
  const timeoutMs = dependencies.timeoutMs ?? 3000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000)
    throw new Error('Invalid call status timeout.');
  const transport = dependencies.transport ?? sdkTransport(parsed.data, timeoutMs);
  return {
    async read(input, signal) {
      const request = requestSchema.safeParse(input);
      if (!request.success || request.data.accountSid !== parsed.data.accountSid || signal?.aborted)
        return { outcome: 'unavailable' };
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cleanupCancellation: (() => void) | undefined;
      try {
        const cancelled = new Promise<CallStatusResult>((resolve) => {
          const onAbort = () => resolve({ outcome: 'unavailable' });
          controller.signal.addEventListener('abort', onAbort, { once: true });
          cleanupCancellation = () => controller.signal.removeEventListener('abort', onAbort);
          timer = setTimeout(abort, timeoutMs);
        });
        const pending: Promise<CallStatusResult> = Promise.resolve()
          .then(() => transport({ ...request.data, signal: controller.signal }))
          .then((raw): CallStatusResult => {
            const result = callStatusResultSchema.safeParse(raw);
            if (
              !result.success ||
              (result.data.outcome === 'known' &&
                (result.data.accountSid !== request.data.accountSid ||
                  result.data.callSid !== request.data.callSid ||
                  new Set(result.data.children.map((child) => child.callSid)).size !==
                    result.data.children.length ||
                  result.data.children.some((child) => child.callSid === request.data.callSid)))
            )
              return { outcome: 'unavailable' };
            return result.data;
          })
          .catch((): CallStatusResult => ({ outcome: 'unavailable' }));
        return await Promise.race([pending, cancelled]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        cleanupCancellation?.();
      }
    },
  };
}
