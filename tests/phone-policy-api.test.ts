import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEMO_TENANTS,
  phoneCallDetailSchema,
  phonePolicySchema,
  sessionSchema,
  type PhonePolicy,
  type Restaurant,
} from '@hostline/contracts';
import { loadConfig } from '@hostline/config';
import { createDatabase, type Database, type TenantTransaction } from '@hostline/database';
import { createApp } from '../apps/api/src/app.js';

const accountSid = `AC${'c'.repeat(32)}`;
const serviceToken = 'synthetic-phone-policy-service-token-for-tests';
const origin = 'http://127.0.0.1:5173';
const providerSid = () => `CA${randomUUID().replaceAll('-', '')}`;
const streamSid = () => `MZ${randomUUID().replaceAll('-', '')}`;
const permissions = { voiceEnabled: true, requestsEnabled: true, transfersEnabled: true };
const environment = {
  NODE_ENV: 'test',
  LIVE_VOICE_ENABLED: 'true',
  VOICE_MODE: 'sandbox',
  VOICE_ACTIONS_ENABLED: 'true',
  VOICE_TRANSFERS_ENABLED: 'true',
  VOICE_MAX_CONCURRENT_CALLS: '10',
  VOICE_MAX_CALL_SECONDS: '600',
  TWILIO_ACCOUNT_SID: accountSid,
  TWILIO_PHONE_NUMBER: '+12125550190',
  VOICE_PUBLIC_URL: 'https://voice.example.test',
  VOICE_SERVICE_TOKEN: serviceToken,
  VOICE_TENANT_ID: DEMO_TENANTS.harbor,
};
const admissionSchema = z.object({
  voiceCallId: z.uuid(),
  generation: z.uuid(),
  twiml: z.string(),
});
const controlSchema = z.object({ controlId: z.uuid(), twiml: z.string() });
interface Binding {
  providerCallSid: string;
  voiceCallId: string;
  generation: string;
  twiml: string;
}
interface Control {
  controlId: string;
  twiml: string;
  token: string;
}

function grant(twiml: string) {
  const value = /<Parameter name="grant" value="([a-f0-9]{64})"/.exec(twiml)?.[1];
  if (!value) throw new Error('Expected a synthetic stream grant.');
  return value;
}
function callbackToken(twiml: string, kind: 'confirmation' | 'transfer-result') {
  const value = new RegExp(`/twilio/${kind}/([a-f0-9]{64})`).exec(twiml)?.[1];
  if (!value) throw new Error('Expected a synthetic callback token.');
  return value;
}

describe('current restaurant phone policy and private handoff authorization', () => {
  let database: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerHeaders: Record<string, string>;
  let otherHeaders: Record<string, string>;
  let originalRestaurant: Restaurant;
  let testClient = 0;
  const calls = new Set<string>();

  beforeAll(async () => {
    database = await createDatabase();
    await database.seedDemo();
    originalRestaurant = await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      const restaurant = await tx.getRestaurant();
      await tx.saveRestaurant(
        {
          ...restaurant,
          transferEnabled: true,
          transferNumber: '+12125550191',
          version: restaurant.version + 1,
        },
        restaurant.version,
      );
      return restaurant;
    });
    app = await createApp(loadConfig(environment), database);
    await app.ready();
    ownerHeaders = await login('harbor');
    otherHeaders = await login('juniper');
  });
  beforeEach(() => {
    testClient += 1;
  });
  afterEach(async () => {
    for (const providerCallSid of calls) {
      const terminal = await post('end', { providerCallSid, reason: 'provider_terminal' });
      expect(terminal.statusCode).toBe(200);
    }
    calls.clear();
    await database.processJobs(100);
    await setPolicy(permissions);
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      const restaurant = await tx.getRestaurant();
      if (restaurant.address !== originalRestaurant.address) {
        await tx.saveRestaurant(
          { ...restaurant, address: originalRestaurant.address, version: restaurant.version + 1 },
          restaurant.version,
        );
      }
    });
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

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
    if (!cookie || !session.csrfToken) throw new Error('Expected a synthetic owner session.');
    return { cookie: `${cookie.name}=${cookie.value}`, origin, 'x-csrf-token': session.csrfToken };
  }
  async function post(path: string, payload: object) {
    return app.inject({
      method: 'POST',
      url: `/internal/voice/${path}`,
      headers: { authorization: `Bearer ${serviceToken}` },
      remoteAddress: `198.51.100.${testClient}`,
      payload,
    });
  }
  async function policy() {
    return database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getPhonePolicy());
  }
  async function setPolicy(changes: Partial<Pick<PhonePolicy, keyof typeof permissions>>) {
    const previous = await policy();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/phone/policy',
      headers: ownerHeaders,
      remoteAddress: `198.51.100.${testClient}`,
      payload: {
        expectedVersion: previous.version,
        policy: {
          voiceEnabled: previous.voiceEnabled,
          requestsEnabled: previous.requestsEnabled,
          transfersEnabled: previous.transfersEnabled,
          ...changes,
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const next = phonePolicySchema.parse(response.json());
    expect(next.version).toBe(previous.version + 1);
    return next;
  }
  async function admit() {
    const providerCallSid = providerSid();
    calls.add(providerCallSid);
    const response = await post('admit', { providerCallSid, accountSid });
    expect(response.statusCode).toBe(200);
    return { providerCallSid, ...admissionSchema.parse(response.json()) };
  }
  async function redeem(call: Binding, twiml = call.twiml) {
    return post('redeem', {
      providerCallSid: call.providerCallSid,
      streamSid: streamSid(),
      streamGrant: grant(twiml),
    });
  }
  async function start() {
    const call = await admit();
    const response = await redeem(call);
    expect(response.statusCode).toBe(200);
    return call;
  }
  function binding(call: Binding) {
    return { providerCallSid: call.providerCallSid, generation: call.generation };
  }
  function proposalInput(call: Binding) {
    return {
      ...binding(call),
      toolCallId: randomUUID(),
      utteranceStartedAt: new Date().toISOString(),
      proposal: {
        kind: 'message',
        message: {
          name: 'Taylor Example',
          callbackNumber: '+12125550141',
          message: 'Synthetic private dining question for staff.',
        },
      },
    };
  }
  async function prepare(call: Binding) {
    const response = await post('propose', proposalInput(call));
    expect(response.statusCode).toBe(200);
    const control = controlSchema.parse(response.json());
    return { ...control, token: callbackToken(control.twiml, 'confirmation') };
  }
  async function transfer(call: Binding) {
    const response = await post('transfer', {
      ...binding(call),
      toolCallId: randomUUID(),
      context: {
        reason: 'allergy_question',
        summary: 'Caller asks staff to verify a synthetic allergy question.',
      },
    });
    expect(response.statusCode).toBe(200);
    const control = controlSchema.parse(response.json());
    return { ...control, token: callbackToken(control.twiml, 'transfer-result') };
  }
  async function dispatch(call: Binding, control: Control) {
    const response = await post('dispatch', { ...binding(call), controlId: control.controlId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ dispatch: true, unavailable: false });
  }
  async function confirm(call: Binding, control: Control) {
    return post('confirmation', {
      providerCallSid: call.providerCallSid,
      confirmationToken: control.token,
      speechResult: 'yes',
      confidence: 0.99,
    });
  }
  async function record(call: Binding) {
    const value = await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
      tx.getVoiceCall(call.providerCallSid),
    );
    if (!value) throw new Error('Expected synthetic call record.');
    return value;
  }
  async function items(call: Binding) {
    return (await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.listInbox())).filter(
      (item) => item.callId === call.voiceCallId,
    );
  }

  it('never revives old stream grants or pending consent after the owner disables and reenables calls', async () => {
    const waiting = await admit();
    const pending = await start();
    const control = await prepare(pending);
    await dispatch(pending, control);
    const originalEpoch = (await record(waiting)).policyVersion;
    await setPolicy({ voiceEnabled: false });
    const current = await setPolicy({ voiceEnabled: true });
    expect(current.version).not.toBe(originalEpoch);
    expect((await redeem(waiting)).statusCode).toBe(403);
    expect(
      (await post('admit', { providerCallSid: waiting.providerCallSid, accountSid })).statusCode,
    ).toBe(403);
    const callback = await confirm(pending, control);
    expect(callback.statusCode).toBe(200);
    expect(callback.json().twiml).not.toContain('<Connect>');
    expect(await items(pending)).toEqual([]);
    expect((await record(pending)).state).toBe('NEEDS_RECONCILIATION');
    const fresh = await start();
    expect((await record(fresh)).policyVersion).toBe(current.version);
    expect((await post('policy', binding(fresh))).json()).toMatchObject({
      allowed: true,
      actionsEnabled: true,
      transfersEnabled: true,
    });
  });

  it('enforces request and transfer permissions for newly admitted calls', async () => {
    await setPolicy({ requestsEnabled: false, transfersEnabled: false });
    const call = await admit();
    const admitted = await redeem(call);
    expect(admitted.statusCode).toBe(200);
    expect(admitted.json()).toMatchObject({ actionsEnabled: false, transfersEnabled: false });
    expect((await post('policy', binding(call))).json()).toMatchObject({
      allowed: true,
      actionsEnabled: false,
      transfersEnabled: false,
    });
    expect((await post('propose', proposalInput(call))).statusCode).toBe(403);
    expect(
      (await post('transfer', { ...binding(call), toolCallId: randomUUID() })).statusCode,
    ).toBe(403);
    expect(await items(call)).toEqual([]);
    expect((await record(call)).state).toBe('STREAMING');
  });

  it('abandons unsent request and transfer controls when the owner changes policy after preparation', async () => {
    for (const kind of ['request', 'transfer'] as const) {
      await setPolicy(permissions);
      const call = await start();
      const control = kind === 'request' ? await prepare(call) : await transfer(call);
      await setPolicy(
        kind === 'request' ? { requestsEnabled: false } : { transfersEnabled: false },
      );
      const response = await post('dispatch', { ...binding(call), controlId: control.controlId });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ dispatch: false, twiml: null, unavailable: true });
      expect(await record(call)).toMatchObject({ state: 'STREAMING', controlState: 'COMPLETED' });
      expect((await post('policy', binding(call))).json()).toMatchObject({
        allowed: false,
        actionsEnabled: false,
        transfersEnabled: false,
      });
      expect(await items(call)).toEqual([]);
    }
  });

  it('reconciles a dispatched confirmation after request saving is disabled without creating an inbox item', async () => {
    const call = await start();
    const control = await prepare(call);
    await dispatch(call, control);
    await setPolicy({ requestsEnabled: false });
    const response = await confirm(call, control);
    expect(response.statusCode).toBe(200);
    expect(response.json().twiml).not.toContain('<Connect>');
    expect(await items(call)).toEqual([]);
    expect(await record(call)).toMatchObject({
      state: 'NEEDS_RECONCILIATION',
      controlState: 'COMPLETED',
    });
    const duplicate = await confirm(call, control);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual(response.json());
    expect(await database.processJobs()).toBe(0);
  });

  it('accepts authoritative terminal callbacks while policy is disabled and releases the durable capacity hold', async () => {
    const call = await start();
    const control = await prepare(call);
    await dispatch(call, control);
    await setPolicy({ voiceEnabled: false });
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.countActiveVoiceCalls(new Date())),
    ).toBe(1);
    const terminal = await post('end', {
      providerCallSid: call.providerCallSid,
      reason: 'provider_terminal',
    });
    expect(terminal.statusCode).toBe(200);
    expect(terminal.json()).toEqual({ state: 'ENDED' });
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.countActiveVoiceCalls(new Date())),
    ).toBe(0);
    expect((await confirm(call, control)).statusCode).toBe(200);
    expect(await items(call)).toEqual([]);
    const delayedIncoming = await post('admit', {
      providerCallSid: call.providerCallSid,
      accountSid,
    });
    expect(delayedIncoming.statusCode).toBe(200);
    expect(delayedIncoming.json().state).toBe('ENDED');
    expect(delayedIncoming.json().twiml).not.toContain('<Connect>');
  });

  it('preserves a known saved receipt across policy edits without duplicate writes or valid old grants', async () => {
    const call = await start();
    const control = await prepare(call);
    await dispatch(call, control);
    const saved = await confirm(call, control);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().outcome).toMatch(/message was saved/i);
    expect(await items(call)).toHaveLength(1);
    await setPolicy({ voiceEnabled: false, requestsEnabled: false });
    await setPolicy(permissions);
    const duplicate = await confirm(call, control);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual(saved.json());
    expect(await items(call)).toHaveLength(1);
    expect(await database.processJobs()).toBe(1);
    expect(await database.processJobs()).toBe(0);
    expect((await redeem(call, z.string().parse(saved.json().twiml))).statusCode).toBe(403);
  });

  it('binds heartbeat policy to the current generation and reports the current restaurant configuration revision', async () => {
    const call = await start();
    const previous = await post('policy', binding(call));
    expect(previous.statusCode).toBe(200);
    const configurationVersion = z.number().parse(previous.json().configurationVersion);
    await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      const restaurant = await tx.getRestaurant();
      await tx.saveRestaurant(
        { ...restaurant, address: '12 Synthetic Revision Lane', version: restaurant.version + 1 },
        restaurant.version,
      );
    });
    const current = await post('policy', binding(call));
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      allowed: true,
      configurationVersion: configurationVersion + 1,
    });
    expect(
      (await post('policy', { ...binding(call), generation: randomUUID() })).json(),
    ).toMatchObject({ allowed: false, actionsEnabled: false, transfersEnabled: false });
    expect(
      (
        await post('policy', {
          ...binding(call),
          configurationVersion,
          tenantId: DEMO_TENANTS.juniper,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post('policy', { providerCallSid: providerSid(), generation: call.generation }))
        .statusCode,
    ).toBe(404);
  });

  it('does not let another restaurant policy revoke a call or claim its internal identity', async () => {
    const call = await start();
    const before = await record(call);
    const otherApp = await createApp(
      loadConfig({ ...environment, VOICE_TENANT_ID: DEMO_TENANTS.juniper }),
      database,
    );
    const otherProviderCallSid = providerSid();
    try {
      await otherApp.ready();
      const admitted = await otherApp.inject({
        method: 'POST',
        url: '/internal/voice/admit',
        headers: { authorization: `Bearer ${serviceToken}` },
        payload: { providerCallSid: otherProviderCallSid, accountSid },
      });
      expect(admitted.statusCode).toBe(200);
      const other = admissionSchema.parse(admitted.json());
      expect(
        (
          await post('policy', {
            providerCallSid: otherProviderCallSid,
            generation: other.generation,
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await otherApp.inject({
        method: 'POST',
        url: '/internal/voice/end',
        headers: { authorization: `Bearer ${serviceToken}` },
        payload: { providerCallSid: otherProviderCallSid, reason: 'provider_terminal' },
      });
      await otherApp.close();
    }
    const otherPolicy = await database.withTenant(DEMO_TENANTS.juniper, (tx) =>
      tx.getPhonePolicy(),
    );
    const response = await app.inject({
      method: 'PUT',
      url: '/api/phone/policy',
      headers: otherHeaders,
      payload: {
        expectedVersion: otherPolicy.version,
        policy: { voiceEnabled: false, requestsEnabled: false, transfersEnabled: false },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(await record(call)).toEqual(before);
    expect((await post('policy', binding(call))).json()).toMatchObject({
      allowed: true,
      actionsEnabled: true,
    });
    expect(
      (await app.inject({ url: `/api/phone/calls/${call.voiceCallId}`, headers: otherHeaders }))
        .statusCode,
    ).toBe(404);
    expect(
      (await post('policy', { ...binding(call), tenantId: DEMO_TENANTS.juniper })).statusCode,
    ).toBe(400);
  });

  it('exposes no further save action after the first confirmed message in a resumed call', async () => {
    const call = await start();
    const control = await prepare(call);
    await dispatch(call, control);
    const saved = await confirm(call, control);
    expect(saved.statusCode).toBe(200);
    const resumed = await redeem(call, z.string().parse(saved.json().twiml));
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ actionsEnabled: false, transfersEnabled: true });
    const current = { ...call, generation: z.uuid().parse(resumed.json().generation) };
    expect((await post('policy', binding(current))).json()).toMatchObject({
      allowed: true,
      actionsEnabled: false,
      transfersEnabled: true,
    });
    expect((await post('propose', proposalInput(current))).statusCode).toBe(409);
    expect(await items(call)).toHaveLength(1);
  });

  it('keeps transfer context private and labels it as untrusted in authorized staff details', async () => {
    const call = await start();
    const control = await transfer(call);
    const summary = 'Caller asks staff to verify a synthetic allergy question.';
    expect(control.twiml).not.toContain(summary);
    const context = await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
      tx.getHandoff(call.voiceCallId),
    );
    expect(context).toMatchObject({
      callId: call.voiceCallId,
      controlId: control.controlId,
      reason: 'allergy_question',
      summary,
    });
    const detail = await app.inject({
      url: `/api/phone/calls/${call.voiceCallId}`,
      headers: ownerHeaders,
    });
    expect(detail.statusCode).toBe(200);
    const safe = phoneCallDetailSchema.parse(detail.json());
    expect(safe.context).toMatchObject({ source: 'AI_UNTRUSTED', summary });
    for (const sensitive of [call.providerCallSid, accountSid, control.token, control.twiml])
      expect(detail.body).not.toContain(sensitive);
    const list = await app.inject({ url: '/api/phone/operations', headers: ownerHeaders });
    expect(list.body).not.toContain(summary);
    expect((await app.inject(`/api/phone/calls/${call.voiceCallId}`)).statusCode).toBe(401);
    expect(
      (await app.inject({ url: `/api/phone/calls/${call.voiceCallId}`, headers: otherHeaders }))
        .statusCode,
    ).toBe(404);
  });

  it('rolls back private handoff failure without leaving a prepared control or retry receipt', async () => {
    const call = await start();
    const before = await record(call);
    const payload = {
      ...binding(call),
      toolCallId: randomUUID(),
      context: { reason: 'requested_staff', summary: 'Synthetic caller requests the host stand.' },
    };
    const failingDatabase: Database = {
      ...database,
      withTenant<T>(tenantId: string, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
        return database.withTenant(tenantId, (tx) =>
          work(
            new Proxy(tx, {
              get(target, property) {
                if (property === 'saveHandoff')
                  return async () => {
                    throw new Error('Synthetic handoff storage failure.');
                  };
                const value: unknown = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ),
        );
      },
    };
    const failingApp = await createApp(loadConfig(environment), failingDatabase);
    try {
      await failingApp.ready();
      const failed = await failingApp.inject({
        method: 'POST',
        url: '/internal/voice/transfer',
        headers: { authorization: `Bearer ${serviceToken}` },
        payload,
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('Synthetic handoff storage failure');
      expect(await record(call)).toEqual(before);
      await database.withTenant(DEMO_TENANTS.harbor, async (tx) => {
        expect(await tx.getHandoff(call.voiceCallId)).toBeNull();
        expect(
          await tx.getReceipt(`voice:tool:${call.voiceCallId}:${payload.toolCallId}`),
        ).toBeNull();
      });
    } finally {
      await failingApp.close();
    }
    const retry = await post('transfer', payload);
    expect(retry.statusCode).toBe(200);
    const control = controlSchema.parse(retry.json());
    expect((await record(call)).controlId).toBe(control.controlId);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getHandoff(call.voiceCallId)),
    ).toMatchObject({ controlId: control.controlId, summary: payload.context.summary });
  });

  it('rejects model arguments that attempt to select policy epochs, tenant scope, or callback authority', async () => {
    const call = await start();
    const before = await record(call);
    for (const unauthorized of [
      { policyVersion: (await policy()).version },
      { tenantId: DEMO_TENANTS.juniper },
      { nonce: 'd'.repeat(64) },
    ]) {
      expect((await post('propose', { ...proposalInput(call), ...unauthorized })).statusCode).toBe(
        400,
      );
      expect(
        (await post('transfer', { ...binding(call), toolCallId: randomUUID(), ...unauthorized }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await post('transfer', {
          ...binding(call),
          toolCallId: randomUUID(),
          context: {
            reason: 'requested_staff',
            summary: 'Synthetic summary',
            policyVersion: (await policy()).version,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(await record(call)).toEqual(before);
    expect(await items(call)).toEqual([]);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) => tx.getHandoff(call.voiceCallId)),
    ).toBeNull();
  });

  it('rejects stale policy edits instead of silently reauthorizing earlier grants', async () => {
    const call = await admit();
    const previous = await policy();
    await setPolicy({ voiceEnabled: false });
    const stale = await app.inject({
      method: 'PUT',
      url: '/api/phone/policy',
      headers: ownerHeaders,
      payload: { expectedVersion: previous.version, policy: permissions },
    });
    expect(stale.statusCode).toBe(409);
    expect((await policy()).voiceEnabled).toBe(false);
    expect((await redeem(call)).statusCode).toBe(403);
    const blockedProviderCallSid = providerSid();
    calls.add(blockedProviderCallSid);
    expect(
      (await post('admit', { providerCallSid: blockedProviderCallSid, accountSid })).statusCode,
    ).toBe(403);
    expect(
      await database.withTenant(DEMO_TENANTS.harbor, (tx) =>
        tx.getVoiceCall(blockedProviderCallSid),
      ),
    ).toBeNull();
  });

  it('does not let permissive restaurant policy exceed disabled deployment capabilities', async () => {
    await setPolicy(permissions);
    const call = await admit();
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
      const headers = { authorization: `Bearer ${serviceToken}` };
      const redeemed = await gated.inject({
        method: 'POST',
        url: '/internal/voice/redeem',
        headers,
        payload: {
          providerCallSid: call.providerCallSid,
          streamSid: streamSid(),
          streamGrant: grant(call.twiml),
        },
      });
      expect(redeemed.statusCode).toBe(200);
      expect(redeemed.json()).toMatchObject({ actionsEnabled: false, transfersEnabled: false });
      const checked = await gated.inject({
        method: 'POST',
        url: '/internal/voice/policy',
        headers,
        payload: binding(call),
      });
      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toMatchObject({
        allowed: true,
        actionsEnabled: false,
        transfersEnabled: false,
      });
      expect(
        (
          await gated.inject({
            method: 'POST',
            url: '/internal/voice/propose',
            headers,
            payload: proposalInput(call),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await gated.inject({
            method: 'POST',
            url: '/internal/voice/transfer',
            headers,
            payload: { ...binding(call), toolCallId: randomUUID() },
          })
        ).statusCode,
      ).toBe(403);
      expect(await items(call)).toEqual([]);
    } finally {
      await gated.close();
    }
  });

  it('retains sent transfer evidence after policy revocation while blocking further work', async () => {
    const call = await start();
    const control = await transfer(call);
    await dispatch(call, control);
    await setPolicy({ transfersEnabled: false });
    const childCallSid = providerSid();
    const answered = await post('transfer-status', {
      transferToken: control.token,
      childCallSid,
      parentCallSid: call.providerCallSid,
      status: 'answered',
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toEqual({ state: 'CONNECTED_TO_STAFF' });
    const before = await record(call);
    for (const outcome of ['unknown', 'rejected', 'accepted'] as const) {
      expect(
        (await post('dispatched', { ...binding(call), controlId: control.controlId, outcome }))
          .statusCode,
      ).toBe(200);
      expect(await record(call)).toEqual(before);
    }
    expect((await post('propose', proposalInput(call))).statusCode).toBe(403);
    expect(
      (await post('transfer', { ...binding(call), toolCallId: randomUUID() })).statusCode,
    ).toBe(403);
    const completed = await post('transfer-result', {
      providerCallSid: call.providerCallSid,
      transferToken: control.token,
      dialCallSid: childCallSid,
      dialCallStatus: 'completed',
      bridged: true,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().twiml).not.toContain('<Connect>');
    expect((await record(call)).state).toBe('NEEDS_RECONCILIATION');
    expect(await items(call)).toEqual([]);
  });
});
