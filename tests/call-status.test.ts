import { afterEach, describe, expect, it, vi } from 'vitest';
import RequestClient from 'twilio/lib/base/RequestClient.js';
import type HttpResponse from 'twilio/lib/http/response.js';
import {
  createCallStatusReader,
  isTerminalProviderStatus,
  type CallStatusTransport,
} from '../packages/connectors/src/call-status.js';

const configuration = {
  accountSid: `AC${'a'.repeat(32)}`,
  authToken: 'synthetic-status-read-test-token',
};
const callSid = `CA${'b'.repeat(32)}`;
const childSid = `CA${'c'.repeat(32)}`;
const request = { accountSid: configuration.accountSid, callSid, includeChildren: true };
const known = {
  outcome: 'known',
  callSid,
  accountSid: configuration.accountSid,
  status: 'completed',
  children: [{ callSid: childSid, status: 'completed' }],
  childrenComplete: true,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('bounded read-only provider status evidence', () => {
  it('rejects arbitrary account/call targets and pre-aborted reads without transport traffic', async () => {
    const transport = vi.fn<CallStatusTransport>(async () => known);
    const reader = createCallStatusReader(configuration, { transport });
    const aborted = new AbortController();
    aborted.abort();
    for (const input of [
      { ...request, callSid: `${callSid}/evil` },
      { ...request, accountSid: `AC${'d'.repeat(32)}` },
      { ...request, accountSid: 'not-an-account' },
    ]) {
      expect(await reader.read(input)).toEqual({ outcome: 'unavailable' });
    }
    expect(await reader.read(request, aborted.signal)).toEqual({ outcome: 'unavailable' });
    expect(transport).not.toHaveBeenCalled();
    expect(() => createCallStatusReader({ ...configuration, accountSid: 'wrong' })).toThrow(
      'Invalid call status server configuration.',
    );
    expect(() => createCallStatusReader(configuration, { timeoutMs: 3001 })).toThrow(
      'Invalid call status timeout.',
    );
  });

  it('returns only validated evidence and never infers identity or termination from bad data', async () => {
    expect(
      await createCallStatusReader(configuration, { transport: async () => known }).read(request),
    ).toEqual(known);
    for (const malformed of [
      { ...known, accountSid: `AC${'d'.repeat(32)}` },
      { ...known, callSid: childSid },
      { ...known, status: 'new-status' },
      { ...known, children: [{ callSid: childSid, status: 'unknown' }] },
      { ...known, children: [{ callSid, status: 'completed' }] },
      { ...known, children: [...known.children, ...known.children] },
      { ...known, children: Array.from({ length: 21 }, () => known.children[0]) },
      { ...known, rawBody: 'private details' },
      { outcome: 'not-found' },
      null,
    ]) {
      const result = await createCallStatusReader(configuration, {
        transport: async () => malformed,
      }).read(request);
      expect(result).toEqual({ outcome: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('private');
    }
    expect(isTerminalProviderStatus('completed')).toBe(true);
    expect(isTerminalProviderStatus('busy')).toBe(true);
    expect(isTerminalProviderStatus('failed')).toBe(true);
    expect(isTerminalProviderStatus('no-answer')).toBe(true);
    expect(isTerminalProviderStatus('canceled')).toBe(true);
    expect(isTerminalProviderStatus('queued')).toBe(false);
    expect(isTerminalProviderStatus('ringing')).toBe(false);
    expect(isTerminalProviderStatus('in-progress')).toBe(false);
  });

  it('bounds hung reads, cancels their transport and ignores late evidence', async () => {
    vi.useFakeTimers();
    let resolveTransport: ((value: unknown) => void) | undefined;
    const transport = vi.fn<CallStatusTransport>(
      () =>
        new Promise((resolve) => {
          resolveTransport = resolve;
        }),
    );
    const pending = createCallStatusReader(configuration, { transport }).read(request);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ outcome: 'unavailable' });
    expect(transport.mock.calls[0]?.[0].signal.aborted).toBe(true);
    resolveTransport?.(known);
    await Promise.resolve();
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry or leak provider errors and handles cancellation independently', async () => {
    for (const failure of [
      new Error('404 private provider body'),
      new SyntaxError('private parse details'),
      { status: 429, message: 'private rate response' },
    ]) {
      const transport = vi.fn<CallStatusTransport>(() => {
        throw failure;
      });
      expect(await createCallStatusReader(configuration, { transport }).read(request)).toEqual({
        outcome: 'unavailable',
      });
      expect(transport).toHaveBeenCalledOnce();
    }
    const cancellation = new AbortController();
    const never = vi.fn<CallStatusTransport>(async () => new Promise(() => undefined));
    const pending = createCallStatusReader(configuration, { transport: never }).read(
      request,
      cancellation.signal,
    );
    await Promise.resolve();
    cancellation.abort();
    expect(await pending).toEqual({ outcome: 'unavailable' });
    expect(never.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  function fakeSdk(
    options: {
      parent?: unknown;
      child?: unknown;
      nextPage?: string | null;
      childCount?: number;
      pageEnvelope?: unknown;
    } = {},
  ) {
    const observed: Array<{
      uri: string | undefined;
      method: string | undefined;
      timeout: number | undefined;
      maxRedirects: number | undefined;
      maxContentLength: number | undefined;
      signalPresent: boolean;
      retry: boolean;
      query: unknown;
    }> = [];
    const original = RequestClient.prototype.request;
    vi.spyOn(RequestClient.prototype, 'request').mockImplementation(function <TData>(
      this: RequestClient,
      input: RequestClient.RequestOptions<TData>,
    ): Promise<HttpResponse<TData>> {
      this.axios.defaults.adapter = async (config) => {
        observed.push({
          uri: config.url,
          method: config.method,
          timeout: config.timeout,
          maxRedirects: config.maxRedirects,
          maxContentLength: config.maxContentLength,
          signalPresent: config.signal !== undefined,
          retry: this.autoRetry,
          query: config.params,
        });
        const list = config.url?.endsWith('/Calls.json');
        const child = options.child ?? {
          sid: childSid,
          account_sid: configuration.accountSid,
          parent_call_sid: callSid,
          status: 'completed',
          from: '+12125550111',
          to: '+12125550112',
        };
        return {
          status: 200,
          statusText: 'OK',
          data: list
            ? (options.pageEnvelope ?? {
                calls: Array.from({ length: options.childCount ?? 1 }, () => child),
                next_page_uri: options.nextPage ?? null,
                previous_page_uri: null,
                uri: `/2010-04-01/Accounts/${configuration.accountSid}/Calls.json`,
              })
            : (options.parent ?? {
                sid: callSid,
                account_sid: configuration.accountSid,
                status: 'completed',
                from: '+12125550111',
                to: '+12125550112',
              }),
          headers: {},
          config,
        };
      };
      return original.call(this, input) as Promise<HttpResponse<TData>>;
    });
    return observed;
  }

  it('uses actual SDK GETs with a fixed account host and bounded page without redirects or logs', async () => {
    vi.stubEnv('TWILIO_EDGE', 'hostile-edge');
    vi.stubEnv('TWILIO_REGION', 'hostile-region');
    vi.stubEnv('TWILIO_LOG_LEVEL', 'debug');
    const observed = fakeSdk();
    const logging = vi.spyOn(console, 'log');
    expect(await createCallStatusReader(configuration).read(request)).toEqual(known);
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({
      uri: `https://api.twilio.com/2010-04-01/Accounts/${configuration.accountSid}/Calls/${callSid}.json`,
      method: 'get',
      timeout: 3000,
      maxRedirects: 0,
      maxContentLength: 65536,
      signalPresent: true,
      retry: false,
    });
    expect(observed[1]).toMatchObject({
      uri: `https://api.twilio.com/2010-04-01/Accounts/${configuration.accountSid}/Calls.json`,
      method: 'get',
      query: { ParentCallSid: callSid, PageSize: 20 },
      maxRedirects: 0,
    });
    expect(logging).not.toHaveBeenCalled();
  });

  it('holds a truncated child list and never follows its provider-supplied next-page URL', async () => {
    const observed = fakeSdk({ nextPage: 'https://untrusted.example.test/next' });
    expect(await createCallStatusReader(configuration).read(request)).toEqual({
      ...known,
      childrenComplete: false,
    });
    expect(observed).toHaveLength(2);
  });

  it('cannot prove child enumeration complete from missing, malformed or foreign pagination metadata', async () => {
    const uri = `/2010-04-01/Accounts/${configuration.accountSid}/Calls.json`;
    for (const pageEnvelope of [
      { calls: [] },
      { calls: [], uri },
      { calls: [], uri, next_page_uri: '' },
      { calls: [], uri, next_page_uri: false },
      { calls: [], next_page_uri: null },
      { calls: [], uri: '/2010-04-01/Accounts/foreign/Calls.json', next_page_uri: null },
      { calls: [], uri: 'https://untrusted.example.test/Calls.json', next_page_uri: null },
      {
        calls: [
          {
            sid: childSid,
            account_sid: configuration.accountSid,
            parent_call_sid: callSid,
            status: 'in-progress',
          },
        ],
        uri,
        next_page_uri: null,
        meta: { key: 'other', next_page_url: '/next' },
        other: [],
      },
    ]) {
      vi.restoreAllMocks();
      const observed = fakeSdk({ pageEnvelope });
      expect(await createCallStatusReader(configuration).read(request)).toEqual({
        outcome: 'unavailable',
      });
      expect(observed).toHaveLength(2);
    }
  });

  it('normalizes SDK list selection to the validated calls array rather than an extra first array', async () => {
    const observed = fakeSdk({
      pageEnvelope: {
        unrelated: [],
        calls: [
          {
            sid: childSid,
            account_sid: configuration.accountSid,
            parent_call_sid: callSid,
            status: 'in-progress',
          },
        ],
        next_page_uri: null,
        uri: `/2010-04-01/Accounts/${configuration.accountSid}/Calls.json`,
      },
    });
    expect(await createCallStatusReader(configuration).read(request)).toEqual({
      ...known,
      children: [{ callSid: childSid, status: 'in-progress' }],
    });
    expect(observed).toHaveLength(2);
  });

  it('rejects a foreign/unknown child and a mismatched parent from the actual SDK', async () => {
    for (const options of [
      { parent: { sid: childSid, account_sid: configuration.accountSid, status: 'completed' } },
      {
        child: {
          sid: childSid,
          account_sid: configuration.accountSid,
          parent_call_sid: `CA${'e'.repeat(32)}`,
          status: 'completed',
        },
      },
      {
        child: {
          sid: childSid,
          account_sid: configuration.accountSid,
          parent_call_sid: callSid,
          status: 'unknown',
        },
      },
      { childCount: 21 },
    ]) {
      vi.restoreAllMocks();
      fakeSdk(options);
      expect(await createCallStatusReader(configuration).read(request)).toEqual({
        outcome: 'unavailable',
      });
    }
  });
});
