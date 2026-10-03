import { afterEach, describe, expect, it, vi } from 'vitest';
import RequestClient from 'twilio/lib/base/RequestClient.js';
import RestException from 'twilio/lib/base/RestException.js';
import type HttpResponse from 'twilio/lib/http/response.js';
import {
  buildConfirmationRetryTwiml,
  buildReadbackTwiml,
  buildSilentConfirmationTwiml,
  buildTransferTwiml,
  TelephonyInputError,
} from '@hostline/connectors';
import {
  createCallController,
  type CallControlTransport,
} from '../apps/voice-gateway/src/control.js';

const configuration = {
  accountSid: `AC${'a'.repeat(32)}`,
  authToken: 'synthetic-call-control-test-token',
  publicUrl: 'https://voice.example.test',
};
const callSid = `CA${'b'.repeat(32)}`;
const token = 'c'.repeat(64);
const readback =
  'A request for 4 people on October 1 at 7 PM, for Alex. Staff must confirm availability.';
const twiml = buildReadbackTwiml({
  publicUrl: configuration.publicUrl,
  confirmationToken: token,
  readback,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('provider-authored canonical call instructions', () => {
  it('collects a signed confirmation silently after an application-verified Live readback', () => {
    const xml = buildSilentConfirmationTwiml({
      publicUrl: configuration.publicUrl,
      confirmationToken: token,
    });
    expect(xml).toContain('<Play>https://voice.example.test/twilio/confirmation-tone.wav</Play>');
    expect(xml.slice(xml.indexOf('<Gather'), xml.indexOf('</Gather>'))).not.toContain('<Say');
    expect(xml.slice(0, xml.indexOf('<Gather'))).not.toContain('<Say');
    expect(xml).toContain(`action="https://voice.example.test/twilio/confirmation/${token}"`);
    expect(xml).toContain('input="speech dtmf"');
    expect(xml).toContain('numDigits="1"');
    expect(xml).toContain('actionOnEmptyResult="true"');
    expect(xml).not.toContain('Say yes');
    expect(xml).toContain('I could not confirm that your request was saved.');
    expect(xml).toContain('<Hangup/>');
    expect(() =>
      buildSilentConfirmationTwiml({
        publicUrl: 'https://evil.example.test/path',
        confirmationToken: token,
      }),
    ).toThrow(TelephonyInputError);
    expect(() =>
      buildSilentConfirmationTwiml({
        publicUrl: configuration.publicUrl,
        confirmationToken: 'invalid',
      }),
    ).toThrow(TelephonyInputError);
  });

  it('finishes canonical readback before speech or keypad collection and never commits on missing input', () => {
    const canonicalEnd = twiml.indexOf('</Say>');
    expect(twiml.slice(0, canonicalEnd)).toContain(readback);
    expect(canonicalEnd).toBeLessThan(twiml.indexOf('<Gather'));
    expect(twiml).toContain(`action="https://voice.example.test/twilio/confirmation/${token}"`);
    expect(twiml).toContain('method="POST"');
    expect(twiml).toContain('input="speech dtmf"');
    expect(twiml).toContain('numDigits="1"');
    expect(twiml).toContain('timeout="5"');
    expect(twiml).toContain('speechTimeout="auto"');
    expect(twiml).toContain('maxSpeechTime="5"');
    expect(twiml).toContain('actionOnEmptyResult="true"');
    expect(twiml).toContain('Say yes or press 1 to save this unconfirmed request for staff review');
    expect(twiml).toContain('say no or press 2 to cancel');
    expect(twiml).toContain('This does not book a table.');
    expect(twiml.slice(twiml.indexOf('</Gather>'))).toContain(
      'I could not confirm that your request was saved.',
    );
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('input="dtmf"');
  });

  it('retries only confirmation with a fixed short prompt and the same bounded callback and fallthrough', () => {
    const xml = buildConfirmationRetryTwiml({
      publicUrl: configuration.publicUrl,
      confirmationToken: token,
    });
    expect(xml.indexOf('<Gather')).toBeLessThan(xml.indexOf('<Say'));
    expect(xml.match(/<Gather\b/g)).toHaveLength(1);
    expect(xml).toContain(`action="https://voice.example.test/twilio/confirmation/${token}"`);
    expect(xml).toContain('method="POST"');
    expect(xml).toContain('input="speech dtmf"');
    expect(xml).toContain('numDigits="1"');
    expect(xml).toContain('timeout="5"');
    expect(xml).toContain('speechTimeout="auto"');
    expect(xml).toContain('maxSpeechTime="5"');
    expect(xml).toContain('actionOnEmptyResult="true"');
    expect(xml).toContain(
      'I could not clearly confirm. Say yes or press 1 to save this request for staff review. Say no or press 2 to cancel.',
    );
    expect(xml).not.toContain(readback);
    expect(xml.slice(xml.indexOf('</Gather>'))).toContain(
      'I could not confirm that your request was saved. Please try again later.',
    );
    expect(xml).toContain('<Hangup/>');
    expect(xml.length).toBeLessThan(1000);
    expect(() =>
      buildConfirmationRetryTwiml({
        publicUrl: configuration.publicUrl,
        confirmationToken: token,
        readback: 'Injected repeated details',
      } as Parameters<typeof buildConfirmationRetryTwiml>[0]),
    ).toThrow(TelephonyInputError);
  });

  it('escapes canonical text and rejects untrusted callback targets or unusable payloads', () => {
    const escaped = buildReadbackTwiml({
      publicUrl: configuration.publicUrl,
      confirmationToken: token,
      readback: 'Alex <Dial> & Sam',
    });
    expect(escaped).toContain('Alex &lt;Dial&gt; &amp; Sam');
    expect(escaped).not.toContain('<Dial>');
    for (const publicUrl of [
      'http://voice.example.test',
      'https://user:pass@voice.example.test',
      'https://voice.example.test/evil',
      'https://voice.example.test?url=evil',
      'https://voice.example.test/#token',
    ]) {
      expect(() => buildReadbackTwiml({ publicUrl, confirmationToken: token, readback })).toThrow(
        TelephonyInputError,
      );
      expect(() => buildConfirmationRetryTwiml({ publicUrl, confirmationToken: token })).toThrow(
        TelephonyInputError,
      );
    }
    for (const badToken of ['short', `/${token}`, `${token}?evil`, 'x'.repeat(64)]) {
      expect(() =>
        buildReadbackTwiml({
          publicUrl: configuration.publicUrl,
          confirmationToken: badToken,
          readback,
        }),
      ).toThrow(TelephonyInputError);
      expect(() =>
        buildConfirmationRetryTwiml({
          publicUrl: configuration.publicUrl,
          confirmationToken: badToken,
        }),
      ).toThrow(TelephonyInputError);
    }
    for (const badReadback of ['', '\u0000', '&'.repeat(1000), 'x'.repeat(2001)]) {
      expect(() =>
        buildReadbackTwiml({
          publicUrl: configuration.publicUrl,
          confirmationToken: token,
          readback: badReadback,
        }),
      ).toThrow(TelephonyInputError);
    }
  });

  it('supports the full message readback while bounding its escaped document', () => {
    const fullReadback = `Please save an unconfirmed message for ${'N'.repeat(120)}, callback +12125550144: ${'m'.repeat(1500)}. Restaurant staff will review it.`;
    const xml = buildReadbackTwiml({
      publicUrl: configuration.publicUrl,
      confirmationToken: token,
      readback: fullReadback,
    });
    expect(xml).toContain(fullReadback);
    expect(xml.length).toBeLessThanOrEqual(4000);
    expect(
      buildReadbackTwiml({
        publicUrl: configuration.publicUrl,
        confirmationToken: token,
        readback: 'x'.repeat(2000),
      }),
    ).toContain('x'.repeat(2000));
    expect(() =>
      buildReadbackTwiml({
        publicUrl: configuration.publicUrl,
        confirmationToken: token,
        readback: '&'.repeat(1500),
      }),
    ).toThrow(TelephonyInputError);
  });

  it('dials only a server-authorized E.164 destination and requests distinct child-leg evidence', () => {
    const xml = buildTransferTwiml({
      publicUrl: configuration.publicUrl,
      transferToken: token,
      destination: '+12125550144',
      staffLabel: 'Host stand',
      remainingSeconds: 300,
    });
    expect(xml).toContain('I will try restaurant staff now. Please hold.');
    expect(xml).toContain('answerOnBridge="true"');
    expect(xml).toContain('timeout="20"');
    expect(xml).toContain('timeLimit="265"');
    expect(xml).toContain(`action="https://voice.example.test/twilio/transfer-result/${token}"`);
    expect(xml).toContain(
      `statusCallback="https://voice.example.test/twilio/transfer-status/${token}"`,
    );
    expect(xml).toContain('statusCallbackMethod="POST"');
    expect(xml).toContain('statusCallbackEvent="initiated ringing answered completed"');
    expect(xml).toContain('>+12125550144</Number>');
    expect(xml).not.toContain('record=');
    expect(xml).not.toContain('recordingStatusCallback');
    expect(xml).not.toContain('transferred you successfully');
    for (const destination of [
      '12125550144',
      '+12125550144/evil',
      'sip:attacker@example.test',
      'https://evil.test',
    ]) {
      expect(() =>
        buildTransferTwiml({
          publicUrl: configuration.publicUrl,
          transferToken: token,
          destination,
          staffLabel: 'Host stand',
          remainingSeconds: 300,
        }),
      ).toThrow(TelephonyInputError);
    }
    expect(() =>
      buildTransferTwiml({
        publicUrl: configuration.publicUrl,
        transferToken: token,
        destination: '+12125550144',
        staffLabel: 'x'.repeat(161),
        remainingSeconds: 300,
      }),
    ).toThrow(TelephonyInputError);
  });

  it('keeps ringing and bridging inside the remaining call budget and rejects exhausted calls', () => {
    const input = {
      publicUrl: configuration.publicUrl,
      transferToken: token,
      destination: '+12125550144',
      staffLabel: 'H'.repeat(160),
    };
    for (const remainingSeconds of [25, 26, 39, 40, 41, 300, 600]) {
      const xml = buildTransferTwiml({ ...input, remainingSeconds });
      const timeout = Number(xml.match(/<Dial[^>]*timeout="(\d+)"/)?.[1]);
      const timeLimit = Number(xml.match(/<Dial[^>]*timeLimit="(\d+)"/)?.[1]);
      expect(timeout).toBeGreaterThanOrEqual(5);
      expect(timeout).toBeLessThanOrEqual(20);
      expect(timeLimit).toBeGreaterThanOrEqual(5);
      expect(timeout + timeLimit + 15).toBeLessThanOrEqual(remainingSeconds);
      expect(xml).not.toContain('H'.repeat(160));
      if (remainingSeconds === 25) {
        expect(timeout).toBe(5);
        expect(timeLimit).toBe(5);
      }
    }
    for (const remainingSeconds of [0, 24, 24.9, 25.5, 601, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildTransferTwiml({ ...input, remainingSeconds })).toThrow(TelephonyInputError);
    }
    expect(() =>
      buildTransferTwiml({ ...input } as Parameters<typeof buildTransferTwiml>[0]),
    ).toThrow(TelephonyInputError);
  });
});

describe('bounded call-control dispatch outcomes', () => {
  it('rejects proven predispatch failures without calling any transport', async () => {
    const transport = vi.fn<CallControlTransport>(async () => undefined);
    const control = createCallController(configuration, { transport });
    const aborted = new AbortController();
    aborted.abort();
    expect(await control.dispatch('other-call', twiml)).toEqual({
      outcome: 'rejected',
      code: 'INVALID_CALL_ID',
    });
    expect(await control.dispatch(callSid, '<invalid/>')).toEqual({
      outcome: 'rejected',
      code: 'INVALID_TWIML',
    });
    expect(await control.dispatch(callSid, twiml, aborted.signal)).toEqual({
      outcome: 'rejected',
      code: 'ABORTED_BEFORE_DISPATCH',
    });
    expect(transport).not.toHaveBeenCalled();
    expect(() => createCallController({ ...configuration, publicUrl: 'http://evil.test' })).toThrow(
      'Invalid call-control server configuration.',
    );
    expect(() => createCallController(configuration, { timeoutMs: 5001 })).toThrow(
      'Invalid call-control timeout.',
    );
    for (const maxCallSeconds of [0, 14, 15.5, 601, Number.NaN]) {
      expect(() =>
        createCallController({ ...configuration, maxCallSeconds }, { transport }),
      ).toThrow('Invalid call-control server configuration.');
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('reports provider admission without claiming playback or successful transfer', async () => {
    const transport = vi.fn<CallControlTransport>(async () => undefined);
    expect(
      await createCallController(configuration, { transport }).dispatch(callSid, twiml),
    ).toEqual({ outcome: 'accepted' });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[0]).toMatchObject({ callSid, twiml });
  });

  it('classifies explicit provider rejection safely and never retries rate limits', async () => {
    const cases = [
      [400, 'PROVIDER_REJECTED'],
      [401, 'NOT_AUTHORIZED'],
      [403, 'NOT_AUTHORIZED'],
      [404, 'CALL_UNAVAILABLE'],
      [410, 'CALL_UNAVAILABLE'],
      [429, 'RATE_LIMITED'],
    ] as const;
    for (const [status, code] of cases) {
      const transport = vi.fn<CallControlTransport>(async () => {
        throw new RestException({
          statusCode: status,
          body: { message: 'Sensitive provider body excluded', code: 12345 },
          headers: {},
        });
      });
      const result = await createCallController(configuration, { transport }).dispatch(
        callSid,
        twiml,
      );
      expect(result).toEqual({ outcome: 'rejected', code });
      expect(JSON.stringify(result)).not.toContain('Sensitive');
      expect(transport).toHaveBeenCalledOnce();
    }
  });

  it('preserves unknown outcome after resets, 5xx or response parsing failure', async () => {
    for (const error of [
      new Error('ECONNRESET with private details'),
      new SyntaxError('Sensitive response parse details'),
      new RestException({
        statusCode: 500,
        body: { message: 'Sensitive upstream details' },
        headers: {},
      }),
      { status: 401, message: 'Unverified error is not an explicit provider rejection' },
    ]) {
      const transport = vi.fn<CallControlTransport>(async () => {
        throw error;
      });
      expect(
        await createCallController(configuration, { transport }).dispatch(callSid, twiml),
      ).toEqual({ outcome: 'unknown' });
      expect(transport).toHaveBeenCalledOnce();
    }
  });

  it('returns an unknown outcome instead of leaking a synchronous transport failure', async () => {
    const transport = vi.fn<CallControlTransport>(() => {
      throw new Error('Sensitive synchronous transport exception');
    });
    expect(
      await createCallController(configuration, { transport }).dispatch(callSid, twiml),
    ).toEqual({ outcome: 'unknown' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('bounds timeouts even if a transport ignores cancellation and ignores late success', async () => {
    vi.useFakeTimers();
    let resolveTransport: (() => void) | undefined;
    const transport = vi.fn<CallControlTransport>(
      () =>
        new Promise<void>((resolve) => {
          resolveTransport = resolve;
        }),
    );
    const pending = createCallController(configuration, { transport, timeoutMs: 4500 }).dispatch(
      callSid,
      twiml,
    );
    await vi.advanceTimersByTimeAsync(4500);
    expect(await pending).toEqual({ outcome: 'unknown' });
    expect(transport.mock.calls[0]?.[0].signal.aborted).toBe(true);
    resolveTransport?.();
    await Promise.resolve();
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates cancellation across concurrent calls and treats post-admission abort as unknown', async () => {
    const completions = new Map<string, () => void>();
    const transport = vi.fn<CallControlTransport>(
      ({ callSid }) =>
        new Promise<void>((resolve) => {
          completions.set(callSid, resolve);
        }),
    );
    const control = createCallController(configuration, { transport });
    const cancellation = new AbortController();
    const first = control.dispatch(callSid, twiml, cancellation.signal);
    const secondSid = `CA${'d'.repeat(32)}`;
    const second = control.dispatch(secondSid, twiml);
    cancellation.abort();
    expect(await first).toEqual({ outcome: 'unknown' });
    expect(transport.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(transport.mock.calls[1]?.[0].signal.aborted).toBe(false);
    completions.get(secondSid)?.();
    expect(await second).toEqual({ outcome: 'accepted' });
    completions.get(callSid)?.();
  });

  it('uses the actual SDK through a fake HTTP adapter with a fixed host, deadline and no redirects', async () => {
    const original = RequestClient.prototype.request;
    const observed: Array<{
      uri: string | undefined;
      method: string | undefined;
      timeout: number | undefined;
      maxRedirects: number | undefined;
      signalPresent: boolean;
      retry: boolean;
      data: unknown;
    }> = [];
    vi.stubEnv('TWILIO_EDGE', 'hostile-edge');
    vi.stubEnv('TWILIO_REGION', 'hostile-region');
    vi.stubEnv('TWILIO_LOG_LEVEL', 'debug');
    vi.spyOn(RequestClient.prototype, 'request').mockImplementation(function <TData>(
      this: RequestClient,
      options: RequestClient.RequestOptions<TData>,
    ): Promise<HttpResponse<TData>> {
      this.axios.defaults.adapter = async (request) => {
        observed.push({
          uri: request.url,
          method: request.method,
          timeout: request.timeout,
          maxRedirects: request.maxRedirects,
          signalPresent: request.signal !== undefined,
          retry: this.autoRetry,
          data: request.data,
        });
        return {
          status: 200,
          statusText: 'OK',
          data: { sid: callSid, account_sid: configuration.accountSid, status: 'in-progress' },
          headers: {},
          config: request,
        };
      };
      return original.call(this, options) as Promise<HttpResponse<TData>>;
    });
    const logging = vi.spyOn(console, 'log');
    const result = await createCallController({ ...configuration, maxCallSeconds: 300 }).dispatch(
      callSid,
      twiml,
    );
    expect(result).toEqual({ outcome: 'accepted' });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      uri: `https://api.twilio.com/2010-04-01/Accounts/${configuration.accountSid}/Calls/${callSid}.json`,
      method: 'post',
      timeout: 4500,
      maxRedirects: 0,
      signalPresent: true,
      retry: false,
    });
    expect(observed[0]?.data).toContain('Twiml=');
    expect(observed[0]?.data).toContain('TimeLimit=300');
    expect(logging).not.toHaveBeenCalled();
  });
});
