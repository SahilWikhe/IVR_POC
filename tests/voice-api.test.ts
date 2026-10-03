import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEMO_TENANTS,
  bootstrapSchema,
  sessionSchema,
  voiceCallStateSchema,
  type Restaurant,
  type VoiceCallRecord,
  type VoiceProposalInput,
} from '@hostline/contracts';
import { loadConfig } from '@hostline/config';
import { createDatabase, type Database, type TenantTransaction } from '@hostline/database';
import { createApp } from '../apps/api/src/app.js';
import type { OperationalEvent, VoiceTranscriptSink } from '../packages/observability/src/index.js';

const accountSid = `AC${'a'.repeat(32)}`;
const phoneNumber = '+12125550190';
const serviceToken = 'synthetic-voice-service-token-for-tests-only';
const origin = 'http://127.0.0.1:5173';
const sid = () => `CA${randomUUID().replaceAll('-', '')}`;
const streamSid = () => `MZ${randomUUID().replaceAll('-', '')}`;
const environment = {
  NODE_ENV: 'test',
  LIVE_VOICE_ENABLED: 'true',
  VOICE_MODE: 'sandbox',
  VOICE_ACTIONS_ENABLED: 'true',
  VOICE_TRANSFERS_ENABLED: 'true',
  VOICE_MAX_CONCURRENT_CALLS: '10',
  VOICE_MAX_CALL_SECONDS: '600',
  TWILIO_ACCOUNT_SID: accountSid,
  TWILIO_PHONE_NUMBER: phoneNumber,
  VOICE_PUBLIC_URL: 'https://voice.example.test',
  VOICE_SERVICE_TOKEN: serviceToken,
  VOICE_TENANT_ID: DEMO_TENANTS.harbor,
};
const admissionSchema = z.object({
  voiceCallId: z.uuid(),
  generation: z.uuid(),
  tenantId: z.uuid(),
  twiml: z.string(),
  state: voiceCallStateSchema,
});
const preparationSchema = z.object({
  controlId: z.uuid(),
  twiml: z.string(),
  readbackText: z.string().optional(),
});
const callbackSchema = z.object({
  tenantId: z.uuid(),
  twiml: z.string(),
  outcome: z.string().nullable(),
});

interface Binding {
  providerCallSid: string;
  voiceCallId: string;
  generation: string;
}
interface Control {
  controlId: string;
  twiml: string;
  token: string;
  readbackText?: string | undefined;
}

function streamGrant(twiml: string): string {
  const parameters = [...twiml.matchAll(/<Parameter\s+([^>]+)\/?\s*>/g)];
  for (const parameter of parameters) {
    const attributes = parameter[1] ?? '';
    if (/name="(?:grant|streamGrant)"/.test(attributes)) {
      const value = /value="([a-f0-9]{64})"/.exec(attributes)?.[1];
      if (value) return value;
    }
  }
  throw new Error('Expected a server-issued stream grant in synthetic TwiML.');
}

function controlToken(twiml: string, kind: 'confirmation' | 'transfer-result'): string {
  const token = new RegExp(`/twilio/${kind}/([a-f0-9]{64})`).exec(twiml)?.[1];
  if (!token) throw new Error('Expected a call-bound callback token in synthetic TwiML.');
  return token;
}

describe('durable phone actions through the authenticated API', () => {
  let database: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let originalRestaurant: Restaurant;
  let testClient = 0;
  const providerCalls = new Set<string>();
  const diagnostics: OperationalEvent[] = [];
  let failDiagnostics = false;

  beforeAll(async () => {
    database = await createDatabase();
    await database.seedDemo();
    originalRestaurant = await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getRestaurant());
    app = await createApp(loadConfig(environment), database, {
      onVoiceDiagnostic: (event) => {
        if (failDiagnostics) throw new Error('Synthetic log sink failure');
        diagnostics.push(event);
      },
    });
    await app.ready();
  });

  beforeEach(() => {
    testClient += 1;
    diagnostics.length = 0;
    failDiagnostics = false;
  });

  afterEach(async () => {
    for (const providerCallSid of providerCalls) {
      await post('end', { providerCallSid, reason: 'provider_terminal' });
    }
    providerCalls.clear();
    await database.processJobs(100);
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      const current = await tx.getRestaurant();
      if (
        current.address !== originalRestaurant.address ||
        current.transferEnabled !== originalRestaurant.transferEnabled ||
        current.transferNumber !== originalRestaurant.transferNumber
      ) {
        await tx.saveRestaurant(
          {
            ...originalRestaurant,
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
          },
          current.version,
        );
      }
    });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  async function post(path: string, payload: object) {
    return app.inject({
      method: 'POST',
      url: `/internal/voice/${path}`,
      headers: { authorization: `Bearer ${serviceToken}` },
      remoteAddress: `192.0.2.${testClient}`,
      payload,
    });
  }

  async function admit(providerCallSid = sid(), openingMode?: 'twilio' | 'gpt_live') {
    providerCalls.add(providerCallSid);
    const response = await post('admit', {
      providerCallSid,
      accountSid,
      ...(openingMode === undefined ? {} : { openingMode }),
    });
    expect(response.statusCode).toBe(200);
    return { providerCallSid, ...admissionSchema.parse(response.json()) };
  }

  async function start(openingMode?: 'twilio' | 'gpt_live') {
    const admitted = await admit(sid(), openingMode);
    const response = await post('redeem', {
      providerCallSid: admitted.providerCallSid,
      streamSid: streamSid(),
      streamGrant: streamGrant(admitted.twiml),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      voiceCallId: admitted.voiceCallId,
      generation: admitted.generation,
      tenantId: DEMO_TENANTS.harbor,
      actionsEnabled: true,
      transfersEnabled: true,
      openingMode: openingMode ?? 'twilio',
    });
    return admitted;
  }

  async function voice(call: Binding) {
    const record = await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
      tx.getVoiceCall(call.providerCallSid),
    );
    if (!record) throw new Error('Expected synthetic voice call.');
    return record;
  }

  async function items(call: Binding) {
    return (
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.listInbox({ limit: 100 }))
    ).filter((item) => item.callId === call.voiceCallId);
  }

  async function prepare(
    call: Binding,
    proposal: VoiceProposalInput = {
      kind: 'message',
      message: {
        name: 'Taylor Example',
        callbackNumber: '+12125550141',
        message: 'Please call about a synthetic private dining event.',
      },
    },
    toolCallId = randomUUID(),
    readbackMode?: 'twilio' | 'gpt_live',
  ): Promise<Control> {
    const response = await post('propose', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      toolCallId,
      utteranceStartedAt: new Date().toISOString(),
      proposal,
      ...(readbackMode === undefined ? {} : { readbackMode }),
    });
    expect(response.statusCode).toBe(200);
    const control = preparationSchema.parse(response.json());
    return { ...control, token: controlToken(control.twiml, 'confirmation') };
  }

  async function dispatch(call: Binding, control: Control) {
    const response = await post('dispatch', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      controlId: control.controlId,
      ...(control.readbackText === undefined ? {} : { readbackTranscript: control.readbackText }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ dispatch: true, unavailable: false });
    const twiml = z.string().parse(response.json().twiml);
    if (control.twiml.includes('<Dial')) {
      // Dispatch may tighten Dial's time limit as the original call budget elapses.
      expect(controlToken(twiml, 'transfer-result')).toBe(control.token);
      expect(twiml).toContain('+12125550191');
    } else expect(twiml).toBe(control.twiml);
  }

  async function accepted(call: Binding, control: Control) {
    await dispatch(call, control);
    const response = await post('dispatched', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      controlId: control.controlId,
      outcome: 'accepted',
    });
    expect(response.statusCode).toBe(200);
  }

  async function confirmation(call: Binding, control: Control, speechResult = 'yes') {
    return post('confirmation', {
      providerCallSid: call.providerCallSid,
      confirmationToken: control.token,
      speechResult,
      confidence: 0.99,
    });
  }

  async function settings(changes: Partial<Restaurant>) {
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      const restaurant = await tx.getRestaurant();
      await tx.saveRestaurant(
        { ...restaurant, ...changes, version: restaurant.version + 1 },
        restaurant.version,
      );
    });
  }

  async function login(workspace: 'harbor' | 'juniper') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { origin },
      payload: { workspace },
    });
    expect(response.statusCode).toBe(200);
    const session = sessionSchema.parse(response.json());
    const cookie = response.cookies.find((entry) => entry.name === 'hostline_session');
    if (!cookie || !session.csrfToken) throw new Error('Expected synthetic staff session.');
    return { cookie: `${cookie.name}=${cookie.value}`, origin, 'x-csrf-token': session.csrfToken };
  }

  async function transfer(call: Binding): Promise<Control> {
    await settings({ transferEnabled: true, transferNumber: '+12125550191' });
    const response = await post('transfer', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      toolCallId: randomUUID(),
    });
    expect(response.statusCode).toBe(200);
    const control = preparationSchema.parse(response.json());
    return { ...control, token: controlToken(control.twiml, 'transfer-result') };
  }

  async function changeVoice(call: Binding, changes: Partial<VoiceCallRecord>) {
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      const current = await tx.getVoiceCall(call.providerCallSid);
      if (!current) throw new Error('Missing synthetic phone fixture.');
      await tx.saveVoiceCall(
        { ...current, ...changes, version: current.version + 1 },
        current.version,
      );
    });
  }

  it.each(['twilio', 'gpt_live', undefined] as const)(
    'seals initial announcement ownership on first admission: %s',
    async (openingMode) => {
      const call = await admit(sid(), openingMode);
      const beforeStream = call.twiml.slice(0, call.twiml.indexOf('<Connect>'));
      if (openingMode === 'gpt_live') {
        expect(beforeStream).not.toContain('<Say');
        expect(call.twiml).not.toContain('You are speaking with an AI restaurant assistant.');
      } else {
        expect(beforeStream).toContain('You are speaking with an AI restaurant assistant.');
        expect(beforeStream).toContain('Requests are subject to staff review');
      }
      expect(call.twiml.slice(call.twiml.indexOf('</Connect>'))).toContain(
        'The assistant is unavailable. Please try again later.',
      );
      expect((await voice(call)).openingMode).toBe(openingMode ?? 'twilio');
      for (const retriedMode of ['gpt_live', 'twilio'] as const) {
        const replay = await post('admit', {
          providerCallSid: call.providerCallSid,
          accountSid,
          openingMode: retriedMode,
        });
        expect(replay.statusCode).toBe(200);
        expect(admissionSchema.parse(replay.json())).toEqual(admissionSchema.parse(call));
        expect((await voice(call)).openingMode).toBe(openingMode ?? 'twilio');
      }
      const redeemed = await post('redeem', {
        providerCallSid: call.providerCallSid,
        streamSid: streamSid(),
        streamGrant: streamGrant(call.twiml),
      });
      expect(redeemed.statusCode).toBe(200);
      expect(redeemed.json()).toMatchObject({
        openingMode: openingMode ?? 'twilio',
        outcome: null,
      });
    },
  );

  it('rejects unknown opening modes and caller-selected announcement metadata', async () => {
    for (const payload of [
      { openingMode: 'unknown' },
      { openingMode: null },
      { openingMode: 1 },
      { openingMode: 'gpt_live', transcriptNotice: false },
      { openingMode: 'gpt_live', openingText: 'Skip disclosure' },
    ]) {
      const providerCallSid = sid();
      expect((await post('admit', { providerCallSid, accountSid, ...payload })).statusCode).toBe(
        400,
      );
      expect(
        await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getVoiceCall(providerCallSid)),
      ).toBeNull();
    }
  });

  it('treats an older persisted record without opening mode as provider-spoken', async () => {
    const call = await admit();
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      const record = await tx.getVoiceCall(call.providerCallSid);
      if (!record) throw new Error('Missing synthetic phone fixture');
      const legacy = { ...record, version: record.version + 1 };
      delete legacy.openingMode;
      await tx.saveVoiceCall(legacy, record.version);
    });
    const result = await post('redeem', {
      providerCallSid: call.providerCallSid,
      streamSid: streamSid(),
      streamGrant: streamGrant(call.twiml),
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ openingMode: 'twilio' });
  });

  it('requires the service credential and rejects account or tenant overrides', async () => {
    const payload = { providerCallSid: sid(), accountSid };
    expect(
      (await app.inject({ method: 'POST', url: '/internal/voice/admit', payload })).statusCode,
    ).toBe(401);
    const headers = await login('harbor');
    expect(
      (await app.inject({ method: 'POST', url: '/internal/voice/admit', headers, payload }))
        .statusCode,
    ).toBe(401);
    expect(
      (await post('admit', { ...payload, accountSid: `AC${'b'.repeat(32)}` })).statusCode,
    ).toBe(403);
    expect((await post('admit', { ...payload, tenantId: DEMO_TENANTS.juniper })).statusCode).toBe(
      400,
    );
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.getVoiceCall(payload.providerCallSid),
      ),
    ).toBeNull();
  });

  it('deduplicates incoming retries and redeems a call-bound stream grant once', async () => {
    const providerCallSid = sid();
    providerCalls.add(providerCallSid);
    const responses = await Promise.all([
      post('admit', { providerCallSid, accountSid }),
      post('admit', { providerCallSid, accountSid }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]?.json()).toEqual(responses[1]?.json());
    const admitted = admissionSchema.parse(responses[0]?.json());
    const wrongCall = await admit();
    expect(
      (
        await post('redeem', {
          providerCallSid: wrongCall.providerCallSid,
          streamSid: streamSid(),
          streamGrant: streamGrant(admitted.twiml),
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    const payload = {
      providerCallSid,
      streamSid: streamSid(),
      streamGrant: streamGrant(admitted.twiml),
    };
    const starts = await Promise.all([post('redeem', payload), post('redeem', payload)]);
    expect(starts.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(starts.filter((response) => response.statusCode >= 400)).toHaveLength(1);
    expect((await voice({ providerCallSid, ...admitted })).state).toBe('STREAMING');
    expect(
      await database.withTenant(DEMO_TENANTS.juniper, (tx) => tx.getVoiceCall(providerCallSid)),
    ).toBeNull();
  });

  it('persists an early terminal callback and never reopens its delayed incoming call', async () => {
    const providerCallSid = sid();
    providerCalls.add(providerCallSid);
    expect(
      (await post('end', { providerCallSid, reason: 'provider_terminal' })).json(),
    ).toMatchObject({ state: 'ENDED' });
    const admitted = await admit(providerCallSid);
    expect(admitted.state).toBe('ENDED');
    expect(admitted.twiml).not.toContain('<Connect>');
    expect((await voice(admitted)).endedAt).not.toBeNull();
  });

  it('prevents browser simulator routes from acquiring phone confirmation authority', async () => {
    const call = await start();
    const headers = await login('harbor');
    expect(
      (await app.inject({ url: `/api/simulator/calls/${call.voiceCallId}`, headers })).statusCode,
    ).toBe(403);
    for (const [route, payload] of [
      ['turn', { text: 'yes', clientTurnId: randomUUID(), expectedVersion: 1 }],
      ['confirm', { proposalId: randomUUID(), expectedVersion: 1, idempotencyKey: randomUUID() }],
      ['end', { expectedVersion: 1 }],
    ] as const) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/simulator/calls/${call.voiceCallId}/${route}`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(403);
    }
    const own = bootstrapSchema.parse(
      (await app.inject({ url: '/api/bootstrap', headers })).json(),
    );
    const summary = own.calls.find((entry) => entry.id === call.voiceCallId);
    expect(summary).toMatchObject({ mode: 'voice' });
    expect(summary).not.toHaveProperty('streamGrantHash');
    expect(summary).not.toHaveProperty('proposal');
    const other = bootstrapSchema.parse(
      (await app.inject({ url: '/api/bootstrap', headers: await login('juniper') })).json(),
    );
    expect(other.calls.some((entry) => entry.id === call.voiceCallId)).toBe(false);
  });

  it('prepares canonical readback without creating an inbox item or exposing a model save action', async () => {
    const call = await start();
    const control = await prepare(call, {
      kind: 'reservation',
      reservation: {
        dateExpression: 'tomorrow',
        time: '19:00',
        partySize: 4,
        name: 'Taylor Example',
        callbackNumber: '+12125550141',
        notes: 'Patio if available',
      },
    });
    expect(control.twiml.indexOf('<Say')).toBeLessThan(control.twiml.indexOf('<Gather'));
    expect(control.twiml).toContain('your table is not confirmed');
    expect(await items(call)).toEqual([]);
    const stored = await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
      tx.getCall(call.voiceCallId),
    );
    expect(stored).toMatchObject({
      mode: 'voice',
      messages: [],
      draft: {},
      inboxItemId: null,
      phase: 'awaiting_confirmation',
    });
    expect(
      (await post('save', { providerCallSid: call.providerCallSid, generation: call.generation }))
        .statusCode,
    ).toBe(404);
    expect((await confirmation(call, control)).statusCode).toBeGreaterThanOrEqual(400);
    expect(await items(call)).toEqual([]);
  });

  it.each(['reservation', 'message'] as const)(
    'requires the exact Live %s readback before silent Gather and speaks the saved outcome through the resumed model',
    async (kind) => {
      const call = await start('gpt_live');
      const control = await prepare(
        call,
        kind === 'reservation'
          ? {
              kind,
              reservation: {
                dateExpression: 'tomorrow',
                time: '19:00',
                partySize: 4,
                name: 'Taylor Example',
                callbackNumber: '+12125550141',
                notes: 'Patio if available',
              },
            }
          : undefined,
        randomUUID(),
        'gpt_live',
      );
      expect(control.readbackText).toContain('Taylor Example');
      expect(control.readbackText).toContain('say yes or press one');
      expect(control.twiml.slice(0, control.twiml.indexOf('<Gather'))).not.toContain('<Say');
      expect(control.twiml).toContain(
        '<Play>https://voice.example.test/twilio/confirmation-tone.wav</Play>',
      );
      expect(
        control.twiml.slice(control.twiml.indexOf('<Gather'), control.twiml.indexOf('</Gather>')),
      ).not.toContain('<Say');
      expect(
        (
          await post('policy', {
            providerCallSid: call.providerCallSid,
            generation: call.generation,
          })
        ).json(),
      ).toMatchObject({ allowed: true });
      expect((await confirmation(call, control)).statusCode).toBe(403);
      const input = {
        providerCallSid: call.providerCallSid,
        generation: call.generation,
        controlId: control.controlId,
      };
      for (const readbackTranscript of [
        undefined,
        control.readbackText?.replace('Taylor', 'Morgan'),
        `${control.readbackText} Your table is booked.`,
      ]) {
        const result = await post('dispatch', {
          ...input,
          ...(readbackTranscript === undefined ? {} : { readbackTranscript }),
        });
        expect(result.statusCode).toBe(409);
        expect(result.json().error.code).toBe('READBACK_MISMATCH');
        expect((await voice(call)).controlState).toBe('PREPARED');
      }
      const responses = await Promise.all([
        post('dispatch', { ...input, readbackTranscript: control.readbackText }),
        post('dispatch', { ...input, readbackTranscript: control.readbackText }),
      ]);
      expect(responses.filter((result) => result.json().dispatch)).toHaveLength(1);
      expect((await post('cancel-prepared', input)).statusCode).toBe(409);
      const confirmations = await Promise.all([
        confirmation(call, control),
        confirmation(call, control),
      ]);
      expect(confirmations[0]?.json()).toEqual(confirmations[1]?.json());
      const callback = callbackSchema.parse(confirmations[0]?.json());
      expect(callback.outcome).toContain('was saved');
      expect(callback.twiml.slice(0, callback.twiml.indexOf('<Connect'))).not.toContain('<Say');
      const saved = await items(call);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        kind,
        name: 'Taylor Example',
        callbackNumber: '+12125550141',
      });
      const resumed = await post('redeem', {
        providerCallSid: call.providerCallSid,
        streamSid: streamSid(),
        streamGrant: streamGrant(callback.twiml),
      });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({
        outcomeSpoken: false,
        openingMode: 'gpt_live',
        actionsEnabled: false,
        outcome: callback.outcome,
      });
      expect(resumed.json().generation).not.toBe(call.generation);
    },
  );

  it('revokes an interrupted Live preparation before dispatch and rejects its old confirmation', async () => {
    const call = await start();
    const control = await prepare(call, undefined, randomUUID(), 'gpt_live');
    const input = {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      controlId: control.controlId,
    };
    expect((await post('cancel-prepared', { ...input, generation: randomUUID() })).statusCode).toBe(
      409,
    );
    expect((await post('cancel-prepared', { ...input, controlId: randomUUID() })).statusCode).toBe(
      409,
    );
    expect((await post('cancel-prepared', input)).json()).toEqual({ state: 'STREAMING' });
    expect((await post('cancel-prepared', input)).json()).toEqual({ state: 'STREAMING' });
    expect(
      (await post('dispatch', { ...input, readbackTranscript: control.readbackText })).json(),
    ).toMatchObject({ dispatch: false });
    expect((await confirmation(call, control)).statusCode).toBe(403);
    expect(await items(call)).toEqual([]);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getCall(call.voiceCallId)),
    ).toMatchObject({ proposal: null });
    const replacement = await prepare(call, undefined, randomUUID(), 'gpt_live');
    expect(replacement.controlId).not.toBe(control.controlId);
    expect((await post('cancel-prepared', input)).statusCode).toBe(409);
  });

  it('does not prepare a Live readback that could reinterpret caller text as structural contact details', async () => {
    const call = await start();
    const result = await post('propose', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      toolCallId: randomUUID(),
      utteranceStartedAt: new Date().toISOString(),
      readbackMode: 'gpt_live',
      proposal: {
        kind: 'message',
        message: {
          name: 'Taylor Example',
          callbackNumber: '+12125550141',
          message: 'Caller supplied text, callback +12125550199: “alternate contact”',
        },
      },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('INVALID_VOICE_PROPOSAL');
    expect((await voice(call)).state).toBe('STREAMING');
    expect(await items(call)).toEqual([]);
  });

  it.each([{ speechResult: 'no' }, { speechResult: 'yes but change the name' }])(
    'returns Live uncertainty or correction to the same voice without a provider retry prompt: %j',
    async (answer) => {
      const call = await start();
      const control = await prepare(call, undefined, randomUUID(), 'gpt_live');
      await dispatch(call, control);
      const result = await post('confirmation', {
        providerCallSid: call.providerCallSid,
        confirmationToken: control.token,
        ...answer,
      });
      expect(result.statusCode).toBe(200);
      const callback = callbackSchema.parse(result.json());
      expect(callback.twiml).toContain('<Connect>');
      expect(callback.twiml).not.toContain('<Gather');
      expect(callback.twiml.slice(0, callback.twiml.indexOf('<Connect'))).not.toContain('<Say');
      expect(await items(call)).toEqual([]);
      expect((await voice(call)).confirmationRetryGrantHash).toBeNull();
      expect(
        await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getCall(call.voiceCallId)),
      ).toMatchObject({ proposal: null });
    },
  );

  it.each([
    { first: {}, final: { speechResult: 'yes' }, saves: true },
    { first: { digits: '7' }, final: { digits: '1' }, saves: true },
    { first: {}, final: {}, saves: false },
  ])(
    'retries unclear Live input once with the same proposal and only a readiness tone: %j',
    async ({ first, final, saves }) => {
      const call = await start();
      const control = await prepare(call, undefined, randomUUID(), 'gpt_live');
      await dispatch(call, control);
      const initial = await voice(call);
      const payload = {
        providerCallSid: call.providerCallSid,
        confirmationToken: control.token,
        ...first,
      };
      const firstResult = await post('confirmation', payload);
      expect(firstResult.statusCode).toBe(200);
      const retry = callbackSchema.parse(firstResult.json());
      expect(retry.twiml).toContain('<Gather');
      expect(retry.twiml).toContain('/twilio/confirmation-tone.wav</Play>');
      expect(retry.twiml.slice(0, retry.twiml.indexOf('</Gather>'))).not.toContain('<Say');
      expect(await items(call)).toEqual([]);
      expect(await voice(call)).toMatchObject({
        proposalId: initial.proposalId,
        confirmationExpiresAt: initial.confirmationExpiresAt,
        controlState: 'ACCEPTED',
      });
      expect((await post('confirmation', payload)).json()).toEqual(retry);
      const retryToken = controlToken(retry.twiml, 'confirmation');
      expect(retryToken).not.toBe(control.token);
      const finalPayload = {
        providerCallSid: call.providerCallSid,
        confirmationToken: retryToken,
        ...final,
      };
      const results = await Promise.all([
        post('confirmation', finalPayload),
        post('confirmation', finalPayload),
      ]);
      expect(results[0]?.json()).toEqual(results[1]?.json());
      const completed = callbackSchema.parse(results[0]?.json());
      expect(completed.twiml).toContain('<Connect>');
      expect(completed.twiml).not.toContain('<Gather');
      expect(completed.twiml.slice(0, completed.twiml.indexOf('<Connect'))).not.toContain('<Say');
      expect(await items(call)).toHaveLength(saves ? 1 : 0);
      expect(
        callbackSchema.parse((await post('confirmation', payload)).json()).twiml,
      ).not.toContain('<Gather');
    },
  );

  it('does not admit a changed, revoked or expired proposal merely because a Live readback matches', async () => {
    for (const invalidation of ['digest', 'expiry', 'policy'] as const) {
      const call = await start();
      const control = await prepare(call, undefined, randomUUID(), 'gpt_live');
      if (invalidation === 'policy') {
        const version = await database.withTenant(
          DEMO_TENANTS.harbor,
          async (tx) => (await tx.getPhonePolicy()).version,
        );
        await changeVoice(call, { policyVersion: version + 1 });
      } else
        await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
          const stored = await tx.getCall(call.voiceCallId);
          if (!stored?.proposal) throw new Error('Expected a synthetic proposal');
          await tx.saveCall(
            {
              ...stored,
              version: stored.version + 1,
              proposal: {
                ...stored.proposal,
                ...(invalidation === 'digest'
                  ? { digest: 'a'.repeat(64) }
                  : { expiresAt: new Date(Date.now() - 1000).toISOString() }),
              },
            },
            stored.version,
          );
        });
      const result = await post('dispatch', {
        providerCallSid: call.providerCallSid,
        generation: call.generation,
        controlId: control.controlId,
        readbackTranscript: control.readbackText,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ dispatch: false, twiml: null, unavailable: true });
      expect(await items(call)).toEqual([]);
    }
  });

  it('deduplicates tool preparation and rejects changed arguments on the same tool identity', async () => {
    const call = await start();
    const payload = {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      toolCallId: randomUUID(),
      utteranceStartedAt: new Date().toISOString(),
      proposal: {
        kind: 'message',
        message: {
          name: 'Taylor Example',
          callbackNumber: '+12125550141',
          message: 'Synthetic request for event information.',
        },
      },
    };
    const first = await post('propose', payload);
    expect(first.statusCode).toBe(200);
    const retry = await post('propose', payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    const changed = await post('propose', {
      ...payload,
      proposal: {
        ...payload.proposal,
        message: { ...payload.proposal.message, message: 'Changed request' },
      },
    });
    expect(changed.statusCode).toBe(409);
    expect(await items(call)).toEqual([]);
  });

  it('admits one dispatch winner and never retries an uncertain external update', async () => {
    const call = await start();
    const control = await prepare(call);
    const payload = {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      controlId: control.controlId,
    };
    const responses = await Promise.all([post('dispatch', payload), post('dispatch', payload)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses.filter((response) => response.json().dispatch === true)).toHaveLength(1);
    expect(responses.filter((response) => response.json().dispatch === false)).toHaveLength(1);
    expect((await post('dispatched', { ...payload, outcome: 'unknown' })).json()).toMatchObject({
      state: 'NEEDS_RECONCILIATION',
    });
    expect((await post('dispatch', payload)).json()).toEqual({
      dispatch: false,
      twiml: null,
      unavailable: false,
    });
    expect(await items(call)).toEqual([]);
  });

  it('accepts a verified callback before REST acknowledgment and saves exactly once on concurrent retries', async () => {
    const call = await start();
    const control = await prepare(call);
    await dispatch(call, control);
    const confirmations = await Promise.all([
      confirmation(call, control),
      confirmation(call, control),
    ]);
    expect(confirmations.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(confirmations[0]?.json()).toEqual(confirmations[1]?.json());
    const result = callbackSchema.parse(confirmations[0]?.json());
    expect(result.outcome).toMatch(/saved/i);
    expect(await items(call)).toHaveLength(1);
    expect(diagnostics.filter((event) => event.code === 'request_saved')).toEqual([
      { event: 'voice.workflow', requestId: call.voiceCallId, code: 'request_saved' },
    ]);
    expect(diagnostics.some((event) => event.code === 'confirmation_replayed')).toBe(true);
    const logged = JSON.stringify(diagnostics);
    for (const privateValue of [
      call.providerCallSid,
      control.token,
      'Taylor Example',
      '+12125550141',
    ])
      expect(logged).not.toContain(privateValue);
    expect(await database.processJobs(100)).toBe(1);
    expect(await database.processJobs(100)).toBe(0);
    const before = await voice(call);
    const lateAck = await post('dispatched', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      controlId: control.controlId,
      outcome: 'accepted',
    });
    expect(lateAck.statusCode).toBe(200);
    expect(await voice(call)).toEqual(before);
    expect((await confirmation(call, control, 'no')).statusCode).toBe(409);
    expect(await items(call)).toHaveLength(1);
  });

  it('binds confirmation tokens to the exact call and rejects fabricated callback authority', async () => {
    const call = await start();
    const other = await start();
    const control = await prepare(call);
    await accepted(call, control);
    const wrongCall = await confirmation(other, control);
    expect(wrongCall.statusCode).toBeGreaterThanOrEqual(400);
    expect(wrongCall.statusCode).toBeLessThan(500);
    expect(
      (
        await post('confirmation', {
          providerCallSid: call.providerCallSid,
          confirmationToken: 'f'.repeat(64),
          speechResult: 'yes',
          confidence: 0.99,
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(await items(call)).toEqual([]);
    expect(await items(other)).toEqual([]);
    expect((await confirmation(call, control)).statusCode).toBe(200);
    expect(await items(call)).toHaveLength(1);
  });

  it.each([0, 0.575, 0.636, 1, undefined])(
    'saves one exact confirmed reservation regardless of optional recognition confidence: %s',
    async (confidence) => {
      const call = await start();
      const reservation = {
        dateExpression: 'tomorrow',
        time: '19:00',
        partySize: 4,
        name: 'Taylor Example',
        callbackNumber: '+12125550141',
        notes: 'Patio if available',
      };
      const control = await prepare(call, { kind: 'reservation', reservation });
      const proposed = await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.getCall(call.voiceCallId),
      );
      await accepted(call, control);
      const payload = {
        providerCallSid: call.providerCallSid,
        confirmationToken: control.token,
        speechResult: 'Yes.',
        ...(confidence === undefined ? {} : { confidence }),
      };
      const responses = await Promise.all([
        post('confirmation', payload),
        post('confirmation', payload),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(responses[0]?.json()).toEqual(responses[1]?.json());
      expect(callbackSchema.parse(responses[0]?.json()).outcome).toBe(
        'Your unconfirmed reservation request was saved for staff review. Your table is not booked.',
      );
      const saved = await items(call);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        kind: 'reservation',
        state: 'PENDING_STAFF_REVIEW',
        name: reservation.name,
        callbackNumber: reservation.callbackNumber,
      });
      expect(saved[0]?.reservation).toEqual(proposed?.proposal?.reservation);
      expect((await voice(call)).confirmationRetryGrantHash).toBeNull();
      expect(diagnostics.filter((event) => event.code === 'request_saved')).toHaveLength(1);
      expect(await database.processJobs(100)).toBe(1);
      expect(await database.processJobs(100)).toBe(0);
    },
  );

  it('rejects invalid confidence metadata without consuming confirmation authority', async () => {
    const call = await start();
    const control = await prepare(call);
    await accepted(call, control);
    const original = await voice(call);
    for (const confidence of [-0.01, 1.01, '0.9', null]) {
      const response = await post('confirmation', {
        providerCallSid: call.providerCallSid,
        confirmationToken: control.token,
        speechResult: 'yes',
        confidence,
      });
      expect(response.statusCode).toBe(400);
      expect(await items(call)).toEqual([]);
      expect(await voice(call)).toEqual(original);
    }
    expect((await confirmation(call, control)).statusCode).toBe(200);
    expect(await items(call)).toHaveLength(1);
  });

  it('requires an unambiguous affirmative result regardless of recognition confidence', async () => {
    for (const answer of [
      { speechResult: 'maybe yes, I need to change the date', confidence: 0.99 },
      { speechResult: 'yes but change the date', confidence: 0 },
      { speechResult: 'no', confidence: 0.99 },
      { speechResult: 'no', confidence: 0 },
      { speechResult: 'cancel' },
      {},
    ]) {
      const call = await start();
      const control = await prepare(call);
      await accepted(call, control);
      const response = await post('confirmation', {
        providerCallSid: call.providerCallSid,
        confirmationToken: control.token,
        ...answer,
      });
      expect(response.statusCode).toBe(200);
      expect(await items(call)).toEqual([]);
      await post('end', { providerCallSid: call.providerCallSid, reason: 'provider_terminal' });
    }
  });

  it.each([
    { first: { digits: '9' }, final: { digits: '1' } },
    { first: {}, final: { speechResult: 'yes', confidence: 0.575 } },
  ])(
    'retries uncertain confirmation once and saves the same proposal: %j',
    async ({ first, final }) => {
      const call = await start();
      const control = await prepare(call);
      await dispatch(call, control);
      const original = await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.getCall(call.voiceCallId),
      );
      const payload = {
        providerCallSid: call.providerCallSid,
        confirmationToken: control.token,
        ...first,
      };
      const uncertain = await post('confirmation', payload);
      expect(uncertain.statusCode).toBe(200);
      const retry = callbackSchema.parse(uncertain.json());
      const retryToken = controlToken(retry.twiml, 'confirmation');
      expect(retryToken).not.toBe(control.token);
      expect(retry.twiml).toContain('<Gather');
      expect(retry.twiml).not.toContain('<Connect>');
      expect(await items(call)).toEqual([]);
      const pending = await voice(call);
      expect(pending).toMatchObject({
        state: 'AWAITING_CONFIRMATION',
        controlState: 'ACCEPTED',
        confirmationGrantHash: createHash('sha256').update(control.token).digest('hex'),
        confirmationRetryGrantHash: createHash('sha256').update(retryToken).digest('hex'),
      });
      expect(
        await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getCall(call.voiceCallId)),
      ).toEqual(original);
      expect((await post('confirmation', payload)).json()).toEqual(retry);
      expect(await voice(call)).toEqual(pending);
      expect((await post('confirmation', { ...payload, digits: '1' })).statusCode).toBe(409);
      for (const outcome of ['unknown', 'rejected'] as const) {
        expect(
          (
            await post('dispatched', {
              providerCallSid: call.providerCallSid,
              generation: call.generation,
              controlId: control.controlId,
              outcome,
            })
          ).statusCode,
        ).toBe(200);
        expect(await voice(call)).toEqual(pending);
      }
      const acceptedPayload = {
        providerCallSid: call.providerCallSid,
        confirmationToken: retryToken,
        ...final,
      };
      const confirmations = await Promise.all([
        post('confirmation', acceptedPayload),
        post('confirmation', acceptedPayload),
      ]);
      expect(confirmations.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(confirmations[0]?.json()).toEqual(confirmations[1]?.json());
      const saved = await items(call);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        kind: original?.proposal?.kind,
        name: original?.proposal?.message?.name,
        callbackNumber: original?.proposal?.message?.callbackNumber,
        message: original?.proposal?.message?.message,
      });
      expect(
        diagnostics.filter(
          (event) => event.requestId === call.voiceCallId && event.code === 'request_saved',
        ),
      ).toHaveLength(1);
      const completed = await voice(call);
      const lateInitial = await post('confirmation', payload);
      expect(lateInitial.statusCode).toBe(200);
      expect(callbackSchema.parse(lateInitial.json()).twiml).not.toMatch(/<(?:Gather|Connect)/);
      expect(await voice(call)).toEqual(completed);
      expect(await items(call)).toHaveLength(1);
    },
  );

  it('does not turn retry exhaustion, corrections or conflicting channels into consent', async () => {
    for (const answer of [
      { speechResult: 'maybe', confidence: 0.99 },
      { digits: '2' },
      { speechResult: 'yes but change the date', confidence: 0.99 },
      {},
      { digits: '9' },
      { digits: '1', speechResult: 'yes', confidence: 0.99 },
    ]) {
      const call = await start();
      const control = await prepare(call);
      await accepted(call, control);
      const initial = await post('confirmation', {
        providerCallSid: call.providerCallSid,
        confirmationToken: control.token,
      });
      expect(initial.statusCode).toBe(200);
      const retryToken = controlToken(callbackSchema.parse(initial.json()).twiml, 'confirmation');
      const response = await post('confirmation', {
        providerCallSid: call.providerCallSid,
        confirmationToken: retryToken,
        ...answer,
      });
      expect(response.statusCode).toBeLessThan(500);
      expect(await items(call)).toEqual([]);
      if (response.statusCode === 200) {
        expect(callbackSchema.parse(response.json()).twiml).not.toContain('<Gather');
        expect((await voice(call)).controlState).toBe('COMPLETED');
      }
      expect((await voice(call)).confirmationRetryGrantHash).toBe(
        createHash('sha256').update(retryToken).digest('hex'),
      );
      await post('end', { providerCallSid: call.providerCallSid, reason: 'provider_terminal' });
    }
  });

  it('rechecks policy, configuration, expiry and hangup before saving retry consent', async () => {
    for (const gate of ['policy', 'configuration', 'expiry', 'deadline', 'hangup'] as const) {
      const call = await start();
      const control = await prepare(call);
      await accepted(call, control);
      const initial = await post('confirmation', {
        providerCallSid: call.providerCallSid,
        confirmationToken: control.token,
      });
      expect(initial.statusCode).toBe(200);
      const retryToken = controlToken(callbackSchema.parse(initial.json()).twiml, 'confirmation');
      if (gate === 'policy') {
        const version = await database.withTenant(
          DEMO_TENANTS.harbor,
          async (tx) => (await tx.getPhonePolicy()).version,
        );
        await changeVoice(call, { policyVersion: version + 1 });
      } else if (gate === 'configuration') {
        await settings({ address: '12 Synthetic Retry Lane' });
      } else if (gate === 'expiry') {
        await changeVoice(call, {
          confirmationExpiresAt: new Date(Date.now() - 1000).toISOString(),
        });
      } else if (gate === 'deadline') {
        await changeVoice(call, { createdAt: new Date(Date.now() - 601_000).toISOString() });
      } else {
        await post('end', { providerCallSid: call.providerCallSid, reason: 'provider_terminal' });
      }
      const response = await post('confirmation', {
        providerCallSid: call.providerCallSid,
        confirmationToken: retryToken,
        digits: '1',
      });
      expect(response.statusCode).toBe(200);
      expect(await items(call)).toEqual([]);
      expect(callbackSchema.parse(response.json()).twiml).not.toContain('<Gather');
      await post('end', { providerCallSid: call.providerCallSid, reason: 'provider_terminal' });
    }
  });

  it('does not issue a retry without twenty seconds of both call and confirmation authority', async () => {
    for (const gate of ['call', 'confirmation'] as const) {
      const call = await start();
      const control = await prepare(call);
      await accepted(call, control);
      await changeVoice(
        call,
        gate === 'call'
          ? { createdAt: new Date(Date.now() - 581_000).toISOString() }
          : { confirmationExpiresAt: new Date(Date.now() + 19_000).toISOString() },
      );
      const response = await post('confirmation', {
        providerCallSid: call.providerCallSid,
        confirmationToken: control.token,
      });
      expect(response.statusCode).toBe(200);
      expect(await items(call)).toEqual([]);
      expect(callbackSchema.parse(response.json()).twiml).not.toContain('<Gather');
      expect((await voice(call)).confirmationRetryGrantHash).toBeNull();
      await post('end', { providerCallSid: call.providerCallSid, reason: 'provider_terminal' });
    }
  });

  it('invalidates a spoken proposal after a restaurant configuration change', async () => {
    const call = await start();
    const control = await prepare(call);
    await accepted(call, control);
    await settings({ address: '12 Synthetic Update Lane' });
    const response = await confirmation(call, control);
    expect(response.statusCode).toBe(200);
    expect(await items(call)).toEqual([]);
    expect(callbackSchema.parse(response.json()).outcome).not.toMatch(/^Message saved/);
  });

  it('rejects expired confirmation authority and does not save after an authoritative hangup', async () => {
    for (const cause of ['expiry', 'hangup'] as const) {
      const call = await start();
      const control = await prepare(call);
      await accepted(call, control);
      if (cause === 'expiry') {
        await changeVoice(call, {
          confirmationExpiresAt: new Date(Date.now() - 1000).toISOString(),
        });
      } else {
        expect(
          (
            await post('end', {
              providerCallSid: call.providerCallSid,
              reason: 'provider_terminal',
            })
          ).json(),
        ).toMatchObject({ state: 'ENDED' });
      }
      const response = await confirmation(call, control);
      expect(response.statusCode).toBe(200);
      expect(await items(call)).toEqual([]);
      if (cause === 'hangup') {
        expect((await voice(call)).state).toBe('ENDED');
        expect(response.json().twiml).not.toContain('<Connect>');
      }
    }
  });

  it('fences stale stream owners and safely restores a definitively rejected dispatch', async () => {
    const call = await start();
    expect(
      (await post('end', { providerCallSid: call.providerCallSid, reason: 'stream_closed' }))
        .statusCode,
    ).toBe(400);
    const before = await voice(call);
    expect(
      (
        await post('end', {
          providerCallSid: call.providerCallSid,
          generation: randomUUID(),
          reason: 'stream_closed',
        })
      ).json(),
    ).toMatchObject({ state: 'STREAMING' });
    expect(await voice(call)).toEqual(before);
    const control = await prepare(call);
    await dispatch(call, control);
    const rejected = await post('dispatched', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      controlId: control.controlId,
      outcome: 'rejected',
    });
    expect(rejected.statusCode).toBe(200);
    expect(await voice(call)).toMatchObject({ state: 'STREAMING', generation: call.generation });
    expect((await confirmation(call, control)).statusCode).toBeGreaterThanOrEqual(400);
    expect(await items(call)).toEqual([]);
  });

  it('keeps action and transfer feature flags enforced in the service boundary', async () => {
    const call = await start();
    const gated = await createApp(
      loadConfig({
        ...environment,
        VOICE_ACTIONS_ENABLED: 'false',
        VOICE_TRANSFERS_ENABLED: 'false',
      }),
      database,
    );
    try {
      await gated.ready();
      for (const [path, payload] of [
        [
          'propose',
          {
            providerCallSid: call.providerCallSid,
            generation: call.generation,
            toolCallId: randomUUID(),
            utteranceStartedAt: new Date().toISOString(),
            proposal: {
              kind: 'message',
              message: {
                name: 'Taylor Example',
                callbackNumber: '+12125550141',
                message: 'Synthetic event question',
              },
            },
          },
        ],
        [
          'transfer',
          {
            providerCallSid: call.providerCallSid,
            generation: call.generation,
            toolCallId: randomUUID(),
          },
        ],
      ] as const) {
        expect(
          (
            await gated.inject({
              method: 'POST',
              url: `/internal/voice/${path}`,
              headers: { authorization: `Bearer ${serviceToken}` },
              payload,
            })
          ).statusCode,
        ).toBe(403);
      }
      const control = await prepare(call);
      await accepted(call, control);
      const disabledConfirmation = await gated.inject({
        method: 'POST',
        url: '/internal/voice/confirmation',
        headers: { authorization: `Bearer ${serviceToken}` },
        payload: {
          providerCallSid: call.providerCallSid,
          confirmationToken: control.token,
          speechResult: 'yes',
          confidence: 0.99,
        },
      });
      expect(disabledConfirmation.statusCode).toBe(200);
      expect(await items(call)).toEqual([]);
    } finally {
      await gated.close();
    }
  });

  it('refuses disabled transfers and destinations that loop to either restaurant number', async () => {
    const call = await start();
    const payload = () => ({
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      toolCallId: randomUUID(),
    });
    expect((await post('transfer', payload())).statusCode).toBeGreaterThanOrEqual(400);
    for (const transferNumber of [phoneNumber, originalRestaurant.publicPhone]) {
      await settings({ transferEnabled: true, transferNumber });
      const response = await post('transfer', payload());
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect((await voice(call)).state).toBe('STREAMING');
    }
    expect((await post('transfer', { ...payload(), destination: '+12125550199' })).statusCode).toBe(
      400,
    );
  });

  it('rechecks the configured transfer destination before dispatch', async () => {
    const call = await start();
    const control = await transfer(call);
    expect(control.twiml).toContain('+12125550191');
    expect(control.twiml).not.toContain(originalRestaurant.publicPhone);
    await settings({ transferNumber: '+12125550192' });
    const response = await post('dispatch', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      controlId: control.controlId,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dispatch: false, twiml: null, unavailable: true });
    expect(await voice(call)).toMatchObject({ state: 'STREAMING', controlState: 'COMPLETED' });
  });

  it('returns a fresh stream grant after no-answer and deduplicates its action callback', async () => {
    const call = await start();
    const control = await transfer(call);
    await accepted(call, control);
    const payload = {
      providerCallSid: call.providerCallSid,
      transferToken: control.token,
      dialCallSid: sid(),
      dialCallStatus: 'no-answer',
      bridged: false,
    };
    const response = await post('transfer-result', payload);
    expect(response.statusCode).toBe(200);
    const callback = callbackSchema.parse(response.json());
    expect(callback.outcome).toMatch(/reach|answer|unavailable|could not connect/i);
    const resumed = await post('redeem', {
      providerCallSid: call.providerCallSid,
      streamSid: streamSid(),
      streamGrant: streamGrant(callback.twiml),
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().voiceCallId).toBe(call.voiceCallId);
    expect(resumed.json().generation).not.toBe(call.generation);
    const retry = await post('transfer-result', payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(response.json());
    expect((await post('transfer-result', { ...payload, dialCallStatus: 'busy' })).statusCode).toBe(
      409,
    );
    expect((await voice(call)).state).toBe('STREAMING');
  });

  it('binds the transfer child leg and ignores out-of-order status regressions', async () => {
    const call = await start();
    const control = await transfer(call);
    await accepted(call, control);
    const childCallSid = sid();
    const payload = {
      transferToken: control.token,
      childCallSid,
      parentCallSid: call.providerCallSid,
    };
    expect(
      (await post('transfer-status', { ...payload, status: 'answered' })).json(),
    ).toMatchObject({ state: 'CONNECTED_TO_STAFF' });
    expect((await post('transfer-status', { ...payload, status: 'ringing' })).json()).toMatchObject(
      { state: 'CONNECTED_TO_STAFF' },
    );
    expect(
      (await post('transfer-status', { ...payload, childCallSid: sid(), status: 'answered' }))
        .statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect((await voice(call)).transferChildSid).toBe(childCallSid);
    const result = await post('transfer-result', {
      providerCallSid: call.providerCallSid,
      transferToken: control.token,
      dialCallSid: childCallSid,
      dialCallStatus: 'completed',
      bridged: true,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().twiml).not.toContain('<Connect>');
    expect((await voice(call)).state).toBe('NEEDS_RECONCILIATION');
    expect((await post('transfer-status', { ...payload, status: 'ringing' })).json()).toMatchObject(
      { state: 'NEEDS_RECONCILIATION' },
    );
    await post('end', { providerCallSid: call.providerCallSid, reason: 'provider_terminal' });
    expect((await voice(call)).state).toBe('ENDED');
    const late = await post('transfer-status', { ...payload, status: 'answered' });
    expect(late.statusCode).toBe(200);
    expect((await voice(call)).state).toBe('ENDED');
  });

  it('does not revive a terminated call through a delayed no-answer transfer result', async () => {
    const call = await start();
    const control = await transfer(call);
    await accepted(call, control);
    await post('end', { providerCallSid: call.providerCallSid, reason: 'provider_terminal' });
    const response = await post('transfer-result', {
      providerCallSid: call.providerCallSid,
      transferToken: control.token,
      dialCallSid: sid(),
      dialCallStatus: 'no-answer',
      bridged: false,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().twiml).not.toContain('<Connect>');
    expect((await voice(call)).state).toBe('ENDED');
    expect(await items(call)).toEqual([]);
  });

  it('keeps incoming callback replay sealed to its spent initial grant after a resume', async () => {
    const call = await start();
    const initial = call.twiml;
    const control = await prepare(call);
    await accepted(call, control);
    const confirmed = await confirmation(call, control);
    expect(confirmed.statusCode).toBe(200);
    const callback = callbackSchema.parse(confirmed.json());
    expect(streamGrant(callback.twiml)).not.toBe(streamGrant(initial));
    const replay = await admit(call.providerCallSid);
    expect(replay.twiml).toBe(initial);
    expect(replay.state).toBe('WAITING_FOR_STREAM');
    expect(
      (
        await post('redeem', {
          providerCallSid: call.providerCallSid,
          streamSid: streamSid(),
          streamGrant: streamGrant(replay.twiml),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post('redeem', {
          providerCallSid: call.providerCallSid,
          streamSid: streamSid(),
          streamGrant: streamGrant(callback.twiml),
        })
      ).statusCode,
    ).toBe(200);
    expect(await items(call)).toHaveLength(1);
  });

  it('preserves the original hard deadline across resumed media and fences its current disconnect', async () => {
    const call = await start();
    const initialDeadline = (await voice(call)).leaseExpiresAt;
    const control = await prepare(call);
    await accepted(call, control);
    const confirmed = await confirmation(call, control);
    expect(confirmed.statusCode).toBe(200);
    const callback = callbackSchema.parse(confirmed.json());
    const resumed = await post('redeem', {
      providerCallSid: call.providerCallSid,
      streamSid: streamSid(),
      streamGrant: streamGrant(callback.twiml),
    });
    expect(resumed.statusCode).toBe(200);
    const currentGeneration = z.uuid().parse(resumed.json().generation);
    expect(resumed.json().expiresAt).toBe(initialDeadline);
    expect((await voice(call)).leaseExpiresAt).toBe(initialDeadline);
    await post('end', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      reason: 'stream_closed',
    });
    expect((await voice(call)).state).toBe('STREAMING');
    await post('end', {
      providerCallSid: call.providerCallSid,
      generation: currentGeneration,
      reason: 'stream_closed',
    });
    expect(await voice(call)).toMatchObject({
      state: 'NEEDS_RECONCILIATION',
      leaseExpiresAt: initialDeadline,
    });
    expect(await items(call)).toHaveLength(1);
  });

  it('uses an authenticated child-leg callback as evidence before a late contradictory REST outcome', async () => {
    const call = await start();
    const control = await transfer(call);
    await dispatch(call, control);
    const childCallSid = sid();
    const observed = await post('transfer-status', {
      transferToken: control.token,
      childCallSid,
      parentCallSid: call.providerCallSid,
      status: 'answered',
    });
    expect(observed.statusCode).toBe(200);
    expect(observed.json()).toMatchObject({ state: 'CONNECTED_TO_STAFF' });
    const before = await voice(call);
    for (const outcome of ['unknown', 'rejected', 'accepted'] as const) {
      const lateAck = await post('dispatched', {
        providerCallSid: call.providerCallSid,
        generation: call.generation,
        controlId: control.controlId,
        outcome,
      });
      expect(lateAck.statusCode).toBe(200);
      expect(await voice(call)).toEqual(before);
    }
    expect(
      (
        await post('dispatch', {
          providerCallSid: call.providerCallSid,
          generation: call.generation,
          controlId: control.controlId,
        })
      ).json(),
    ).toEqual({ dispatch: false, twiml: null, unavailable: false });
  });

  it('handles a maximum-length valid message without partially preparing an oversized control', async () => {
    const call = await start();
    const control = await prepare(call, {
      kind: 'message',
      message: {
        name: 'Taylor Example',
        callbackNumber: '+12125550141',
        message: 'a'.repeat(1500),
      },
    });
    expect(control.twiml).toContain('a'.repeat(1500));
    expect(await items(call)).toEqual([]);
    expect((await voice(call)).controlState).toBe('PREPARED');
  });

  it('rolls back inbox, confirmation, and receipt together when durable enqueue fails', async () => {
    const call = await start();
    const control = await prepare(call);
    await accepted(call, control);
    const before = await voice(call);
    const failingDatabase: Database = {
      ...database,
      withTenant<T>(tenantId: string, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
        return database.withTenant(tenantId, (tx) =>
          work(
            new Proxy(tx, {
              get(target, property) {
                if (property === 'enqueue')
                  return async () => {
                    throw new Error('Synthetic enqueue failure.');
                  };
                const value: unknown = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ),
        );
      },
    };
    const rolledBackEvents: OperationalEvent[] = [];
    const rolledBackTranscripts: Parameters<VoiceTranscriptSink['record']>[] = [];
    const failingApp = await createApp(
      loadConfig({ ...environment, VOICE_DEBUG_TRANSCRIPTS: 'true' }),
      failingDatabase,
      {
        voiceTranscripts: {
          record: (...entry) => {
            rolledBackTranscripts.push(entry);
          },
        },
        onVoiceDiagnostic: (event) => rolledBackEvents.push(event),
      },
    );
    try {
      await failingApp.ready();
      const response = await failingApp.inject({
        method: 'POST',
        url: '/internal/voice/confirmation',
        headers: { authorization: `Bearer ${serviceToken}` },
        payload: {
          providerCallSid: call.providerCallSid,
          confirmationToken: control.token,
          speechResult: 'yes',
          confidence: 0.99,
        },
      });
      expect(response.statusCode).toBe(500);
      expect(rolledBackEvents).toEqual([]);
      expect(rolledBackTranscripts).toEqual([]);
      expect(response.body).not.toContain('Synthetic enqueue failure');
      expect(await items(call)).toEqual([]);
      expect(await voice(call)).toEqual(before);
      const tokenHash = createHash('sha256').update(control.token).digest('hex');
      expect(
        await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
          tx.getReceipt(`voice:confirmation:${tokenHash}`),
        ),
      ).toBeNull();
      expect(await database.processJobs(100)).toBe(0);
    } finally {
      await failingApp.close();
    }
    expect((await confirmation(call, control)).statusCode).toBe(200);
    expect(await items(call)).toHaveLength(1);
    expect(await database.processJobs(100)).toBe(1);
  });

  it('commits exactly one confirmed request even when the diagnostic sink fails', async () => {
    const call = await start();
    const control = await prepare(call);
    await accepted(call, control);
    failDiagnostics = true;
    try {
      expect((await confirmation(call, control)).statusCode).toBe(200);
      expect((await confirmation(call, control)).statusCode).toBe(200);
      expect(await items(call)).toHaveLength(1);
    } finally {
      failDiagnostics = false;
    }
  });

  it.each([false, true])(
    'captures committed readback and bound confirmation only when opted in: %s',
    async (enabled) => {
      const capture: Parameters<VoiceTranscriptSink['record']>[] = [];
      const originalApp = app;
      app = await createApp(
        loadConfig({ ...environment, VOICE_DEBUG_TRANSCRIPTS: String(enabled) }),
        database,
        {
          onVoiceDiagnostic: () => {},
          voiceTranscripts: {
            record: (...entry) => {
              capture.push(entry);
            },
          },
        },
      );
      try {
        await app.ready();
        const liveCall = await admit(sid(), 'gpt_live');
        expect(liveCall.twiml.slice(0, liveCall.twiml.indexOf('<Connect'))).not.toContain('<Say');
        expect(liveCall.twiml).not.toContain('A transcript is saved locally for debugging.');
        const liveRedemption = await post('redeem', {
          providerCallSid: liveCall.providerCallSid,
          streamSid: streamSid(),
          streamGrant: streamGrant(liveCall.twiml),
        });
        expect(liveRedemption.statusCode).toBe(200);
        expect(liveRedemption.json()).toMatchObject({
          openingMode: 'gpt_live',
        });
        const call = await start();
        expect(call.twiml).not.toContain('A transcript is saved locally for debugging.');
        const control = await prepare(call);
        const proposed = await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
          tx.getCall(call.voiceCallId),
        );
        await accepted(call, control);
        const before = capture.length;
        const invalid = await post('confirmation', {
          providerCallSid: call.providerCallSid,
          confirmationToken: '0'.repeat(64),
          speechResult: 'UNBOUND TEXT',
        });
        expect(invalid.statusCode).not.toBe(200);
        expect(capture).toHaveLength(before);
        expect((await confirmation(call, control, 'Yes!')).statusCode).toBe(200);
        expect((await confirmation(call, control, 'Yes!')).statusCode).toBe(200);
        expect(await items(call)).toHaveLength(1);
        if (enabled) {
          expect(capture.filter(([, event]) => event.kind === 'server_readback')).toEqual([
            [
              call.voiceCallId,
              { kind: 'server_readback', text: proposed?.proposal?.readback },
              call.generation,
            ],
          ]);
          expect(capture.filter(([, event]) => event.kind === 'confirmation')).toEqual([
            [
              call.voiceCallId,
              { kind: 'confirmation', text: 'Yes!', confidence: 0.99 },
              call.generation,
            ],
          ]);
          expect(capture.filter(([, event]) => event.kind === 'server_outcome')).toHaveLength(1);
          expect(
            capture.filter(([, event]) => event.kind === 'stage' && event.code === 'request_saved'),
          ).toHaveLength(1);
          for (const forbidden of [
            call.providerCallSid,
            control.token,
            serviceToken,
            'UNBOUND TEXT',
            '<Response>',
          ])
            expect(JSON.stringify(capture)).not.toContain(forbidden);
        } else expect(capture).toEqual([]);
      } finally {
        await app.close();
        app = originalApp;
      }
    },
  );

  it.each(['throw', 'reject'])(
    'preserves confirmed saves when transcript capture fails with %s',
    async (failure) => {
      const originalApp = app;
      app = await createApp(
        loadConfig({ ...environment, VOICE_DEBUG_TRANSCRIPTS: 'true' }),
        database,
        {
          onVoiceDiagnostic: () => {},
          voiceTranscripts: {
            record: () => {
              if (failure === 'throw') throw new Error('Synthetic capture failure');
              return Promise.reject(new Error('Synthetic capture rejection'));
            },
          },
        },
      );
      try {
        await app.ready();
        const call = await start();
        const control = await prepare(call);
        await accepted(call, control);
        expect((await confirmation(call, control)).statusCode).toBe(200);
        expect((await confirmation(call, control)).statusCode).toBe(200);
        expect(await items(call)).toHaveLength(1);
      } finally {
        await app.close();
        app = originalApp;
      }
    },
  );

  it('enforces one durable admission slot for simultaneous incoming calls', async () => {
    const bounded = await createApp(
      loadConfig({ ...environment, VOICE_MAX_CONCURRENT_CALLS: '1' }),
      database,
    );
    const providerCallSids = [sid(), sid()];
    for (const providerCallSid of providerCallSids) providerCalls.add(providerCallSid);
    try {
      await bounded.ready();
      const responses = await Promise.all(
        providerCallSids.map((providerCallSid) =>
          bounded.inject({
            method: 'POST',
            url: '/internal/voice/admit',
            headers: { authorization: `Bearer ${serviceToken}` },
            payload: { providerCallSid, accountSid },
          }),
        ),
      );
      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(1);
      expect(
        await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
          tx.countActiveVoiceCalls(new Date()),
        ),
      ).toBe(1);
    } finally {
      await bounded.close();
    }
  });
});
