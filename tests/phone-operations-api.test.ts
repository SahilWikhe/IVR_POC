import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  DEMO_TENANTS,
  phoneCallDetailSchema,
  phoneOperationsSchema,
  phonePolicySchema,
  phoneReconcileResultSchema,
  sessionSchema,
  type Role,
  type VoiceCallRecord,
} from '@hostline/contracts';
import { loadConfig } from '@hostline/config';
import { createDatabase, type Database } from '@hostline/database';
import type { CallStatusReader, CallStatusResult } from '@hostline/connectors';
import { createApp } from '../apps/api/src/app.js';
import { AuthError, type AuthService } from '../apps/api/src/auth.js';
import { registerPhoneOperations } from '../apps/api/src/phone-operations.js';

const origin = 'http://127.0.0.1:5173';
const accountSid = `AC${'a'.repeat(32)}`;
const serviceToken = 'synthetic-phone-operations-service-token';
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
const sid = () => `CA${randomUUID().replaceAll('-', '')}`;
const bindingSchema = z.object({ voiceCallId: z.uuid(), generation: z.uuid(), twiml: z.string() });

describe('authenticated phone operations and conservative provider reconciliation', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let cookie = '';
  let csrf = '';
  let workspace: 'harbor' | 'juniper' = 'harbor';
  let testClient = 0;
  const providerCalls = new Set<string>();
  const read = vi.fn<CallStatusReader['read']>();
  const headers = () => ({ cookie, origin, 'x-csrf-token': csrf });

  beforeAll(async () => {
    db = await createDatabase();
    await db.seedDemo();
    app = await createApp(loadConfig(environment), db, { callStatusReader: { read } });
    await app.ready();
  });
  beforeEach(async () => {
    testClient += 1;
    read.mockReset();
    read.mockResolvedValue({ outcome: 'unavailable' });
    await login('harbor');
  });
  afterEach(async () => {
    for (const providerCallSid of providerCalls)
      await internal('end', { providerCallSid, reason: 'provider_terminal' });
    providerCalls.clear();
    await db.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      const policy = await tx.getPhonePolicy();
      if (!policy.voiceEnabled || !policy.requestsEnabled || !policy.transfersEnabled)
        await tx.savePhonePolicy(
          {
            version: policy.version + 1,
            voiceEnabled: true,
            requestsEnabled: true,
            transfersEnabled: true,
            updatedAt: new Date().toISOString(),
          },
          policy.version,
        );
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  async function login(next: 'harbor' | 'juniper') {
    workspace = next;
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { origin },
      remoteAddress: `192.0.2.${testClient}`,
      payload: { workspace: next },
    });
    expect(response.statusCode).toBe(200);
    const signedCookie = response.headers['set-cookie'];
    if (typeof signedCookie !== 'string') throw new Error('Expected synthetic session cookie.');
    cookie = signedCookie.split(';')[0] ?? '';
    csrf = sessionSchema.parse(response.json()).csrfToken ?? '';
  }
  async function internal(path: string, payload: object) {
    return app.inject({
      method: 'POST',
      url: `/internal/voice/${path}`,
      headers: { authorization: `Bearer ${serviceToken}` },
      remoteAddress: `192.0.2.${testClient}`,
      payload,
    });
  }
  async function start() {
    const providerCallSid = sid();
    providerCalls.add(providerCallSid);
    const admitted = await internal('admit', { accountSid, providerCallSid });
    expect(admitted.statusCode).toBe(200);
    const binding = bindingSchema.parse(admitted.json());
    const grant = /name="grant" value="([a-f0-9]{64})"/.exec(binding.twiml)?.[1];
    if (!grant) throw new Error('Expected synthetic stream grant.');
    const redeemed = await internal('redeem', {
      providerCallSid,
      streamSid: `MZ${randomUUID().replaceAll('-', '')}`,
      streamGrant: grant,
    });
    expect(redeemed.statusCode).toBe(200);
    return { ...binding, providerCallSid };
  }
  async function record(providerCallSid: string) {
    const value = await db.withTenant(DEMO_TENANTS.harbor, (tx) =>
      tx.getVoiceCall(providerCallSid),
    );
    if (!value) throw new Error('Expected synthetic phone call record.');
    return value;
  }
  async function reconcile(value: VoiceCallRecord) {
    return app.inject({
      method: 'POST',
      url: `/api/phone/calls/${value.id}/reconcile`,
      headers: headers(),
      remoteAddress: `192.0.2.${testClient}`,
      payload: { expectedVersion: value.version },
    });
  }
  function known(
    value: VoiceCallRecord,
    changes: Partial<Extract<CallStatusResult, { outcome: 'known' }>> = {},
  ) {
    return {
      outcome: 'known',
      callSid: value.providerCallSid,
      accountSid: value.accountSid,
      status: 'completed',
      children: [],
      childrenComplete: true,
      ...changes,
    } satisfies CallStatusResult;
  }
  async function prepare(call: Awaited<ReturnType<typeof start>>) {
    const response = await internal('propose', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      toolCallId: randomUUID(),
      utteranceStartedAt: new Date().toISOString(),
      proposal: {
        kind: 'message',
        message: {
          name: 'Taylor Example',
          callbackNumber: '+12125550141',
          message: 'Please call about the synthetic dinner event.',
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const control = z.object({ controlId: z.uuid(), twiml: z.string() }).parse(response.json());
    const token = /\/twilio\/confirmation\/([a-f0-9]{64})/.exec(control.twiml)?.[1];
    if (!token) throw new Error('Expected synthetic confirmation token.');
    const dispatched = await internal('dispatch', {
      providerCallSid: call.providerCallSid,
      generation: call.generation,
      controlId: control.controlId,
    });
    expect(dispatched.statusCode).toBe(200);
    return { ...control, token };
  }

  it('requires authenticated sessions, exact Origin/CSRF and strict versioned owner changes', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/phone/operations' });
    expect(anonymous.statusCode).toBe(401);
    const operations = await app.inject({
      method: 'GET',
      url: '/api/phone/operations',
      headers: { cookie },
    });
    const policy = phoneOperationsSchema.parse(operations.json()).policy;
    const body = {
      expectedVersion: policy.version,
      policy: { voiceEnabled: false, requestsEnabled: false, transfersEnabled: false },
    };
    for (const deniedHeaders of [
      { cookie, origin },
      { ...headers(), origin: 'https://untrusted.example.test' },
      { ...headers(), 'x-csrf-token': 'wrong-token' },
    ]) {
      const denied = await app.inject({
        method: 'PUT',
        url: '/api/phone/policy',
        headers: deniedHeaders,
        payload: body,
      });
      expect(denied.statusCode).toBe(403);
    }
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/phone/policy',
      headers: headers(),
      payload: body,
    });
    expect(saved.statusCode).toBe(200);
    expect(phonePolicySchema.parse(saved.json())).toMatchObject({
      version: policy.version + 1,
      voiceEnabled: false,
    });
    const stale = await app.inject({
      method: 'PUT',
      url: '/api/phone/policy',
      headers: headers(),
      payload: body,
    });
    expect(stale.statusCode).toBe(409);
    const extra = await app.inject({
      method: 'PUT',
      url: '/api/phone/policy',
      headers: headers(),
      payload: { ...body, accountSid },
    });
    expect(extra.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it('paginates tenant-only minimal summaries and rejects oversized queries', async () => {
    const first = await start();
    const second = await start();
    const response = await app.inject({
      method: 'GET',
      url: '/api/phone/operations?limit=1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const operations = phoneOperationsSchema.parse(response.json());
    expect(operations.calls).toHaveLength(1);
    expect(operations.hasMore).toBe(true);
    expect(operations.calls[0]).toMatchObject({ capacityHeld: true, state: 'STREAMING' });
    for (const secret of [
      first.providerCallSid,
      second.providerCallSid,
      accountSid,
      'streamGrantHash',
      'controlTwiml',
      'entryTwiml',
      'confirmationGrantHash',
      'transferDestination',
    ])
      expect(response.body).not.toContain(secret);
    for (const query of ['limit=51', 'offset=1000001', 'tenantId=bad']) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/phone/operations?${query}`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(400);
    }
    await login('juniper');
    const other = await app.inject({
      method: 'GET',
      url: '/api/phone/operations',
      headers: { cookie },
    });
    expect(phoneOperationsSchema.parse(other.json())).toMatchObject({
      calls: [],
      configured: { voiceEnabled: false, reconciliationAvailable: false },
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/phone/calls/${first.voiceCallId}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect((await reconcile(await record(first.providerCallSid))).statusCode).toBe(404);
    expect(workspace).toBe('juniper');
    expect(read).not.toHaveBeenCalled();
  });

  it('separates pending caller fields from saved requests and never exposes confirmation authority', async () => {
    const call = await start();
    const control = await prepare(call);
    const pendingResponse = await app.inject({
      method: 'GET',
      url: `/api/phone/calls/${call.voiceCallId}`,
      headers: { cookie },
    });
    const pending = phoneCallDetailSchema.parse(pendingResponse.json());
    expect(pending.pendingProposal?.message?.name).toBe('Taylor Example');
    expect(pending.savedItem).toBeNull();
    for (const hidden of [
      control.token,
      accountSid,
      call.providerCallSid,
      'digest',
      'controlTwiml',
    ])
      expect(pendingResponse.body).not.toContain(hidden);
    expect(
      (
        await internal('confirmation', {
          providerCallSid: call.providerCallSid,
          confirmationToken: control.token,
          speechResult: 'yes',
          confidence: 0.99,
        })
      ).statusCode,
    ).toBe(200);
    const saved = phoneCallDetailSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/phone/calls/${call.voiceCallId}`,
          headers: { cookie },
        })
      ).json(),
    );
    expect(saved.pendingProposal).toBeNull();
    expect(saved.savedItem).toMatchObject({ kind: 'message', name: 'Taylor Example' });
  });

  it('limits sensitive detail to owner/staff and policy or recovery mutations to owners', async () => {
    const call = await start();
    let role: Role = 'viewer';
    const actor = () => ({ tenantId: DEMO_TENANTS.harbor, userId: 'synthetic-role-subject', role });
    const auth: AuthService = {
      actor,
      requireRole(_request, allowed) {
        if (!allowed.includes(role))
          throw new AuthError('FORBIDDEN', 403, 'Role is not permitted.');
        return actor();
      },
      session: () => ({
        authenticated: false,
        mode: 'demo',
        csrfToken: null,
        user: null,
        workspace: null,
      }),
      close() {},
    };
    const roleApp = Fastify();
    roleApp.setErrorHandler((error, _request, reply) => {
      const safe = z
        .object({ status: z.number(), code: z.string(), message: z.string() })
        .parse(error);
      return reply.code(safe.status).send({ error: safe });
    });
    await registerPhoneOperations(roleApp, loadConfig(environment), db, auth, {
      callStatusReader: { read },
    });
    try {
      expect(
        (await roleApp.inject({ method: 'GET', url: '/api/phone/operations' })).statusCode,
      ).toBe(200);
      for (const testedRole of ['viewer', 'staff'] as const) {
        role = testedRole;
        expect(
          (await roleApp.inject({ method: 'GET', url: `/api/phone/calls/${call.voiceCallId}` }))
            .statusCode,
        ).toBe(testedRole === 'viewer' ? 403 : 200);
        expect(
          (await roleApp.inject({ method: 'PUT', url: '/api/phone/policy', payload: {} }))
            .statusCode,
        ).toBe(403);
        expect(
          (
            await roleApp.inject({
              method: 'POST',
              url: `/api/phone/calls/${call.voiceCallId}/reconcile`,
              payload: { expectedVersion: 2 },
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(read).not.toHaveBeenCalled();
    } finally {
      await roleApp.close();
    }
  });

  it('labels private transfer context as untrusted and excludes it from overview summaries', async () => {
    const call = await start();
    const controlId = randomUUID();
    await db.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      const current = await tx.getVoiceCall(call.providerCallSid);
      if (!current) throw new Error('Expected synthetic voice call.');
      await tx.saveVoiceCall(
        {
          ...current,
          version: current.version + 1,
          controlId,
          controlKind: 'transfer',
          controlState: 'PREPARED',
        },
        current.version,
      );
      await tx.saveHandoff({
        callId: call.voiceCallId,
        controlId,
        reason: 'allergy_question',
        summary: 'Synthetic guest asks staff about possible cross-contamination.',
        createdAt: new Date().toISOString(),
      });
    });
    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/phone/calls/${call.voiceCallId}`,
      headers: { cookie },
    });
    const detail = phoneCallDetailSchema.parse(detailResponse.json());
    expect(detail.context).toMatchObject({
      source: 'AI_UNTRUSTED',
      reason: 'allergy_question',
      summary: 'Synthetic guest asks staff about possible cross-contamination.',
    });
    const overview = await app.inject({
      method: 'GET',
      url: '/api/phone/operations',
      headers: { cookie },
    });
    expect(overview.body).not.toContain('cross-contamination');
    expect(overview.body).not.toContain(controlId);
  });

  it('releases capacity only with terminal bound parent and all child evidence, preserving terminal callbacks', async () => {
    const call = await start();
    const control = await prepare(call);
    const value = await record(call.providerCallSid);
    read.mockResolvedValue(known(value, { children: [{ callSid: sid(), status: 'completed' }] }));
    const response = await reconcile(value);
    expect(response.statusCode).toBe(200);
    expect(phoneReconcileResultSchema.parse(response.json())).toMatchObject({
      result: 'ended',
      call: { state: 'ENDED', capacityHeld: false, requiresReconciliation: false },
    });
    expect(read).toHaveBeenCalledExactlyOnceWith({
      accountSid,
      callSid: call.providerCallSid,
      includeChildren: true,
    });
    expect(
      await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.countActiveVoiceCalls(new Date())),
    ).toBe(0);
    const late = await internal('confirmation', {
      providerCallSid: call.providerCallSid,
      confirmationToken: control.token,
      speechResult: 'yes',
      confidence: 0.99,
    });
    expect(late.statusCode).toBe(200);
    expect(late.json().twiml).toContain('<Hangup/>');
    expect(
      (await db.withTenant(DEMO_TENANTS.harbor, (tx) => tx.listInbox())).some(
        (item) => item.callId === call.voiceCallId,
      ),
    ).toBe(false);
    const staleAlreadyEnded = await reconcile(value);
    expect(staleAlreadyEnded.statusCode).toBe(200);
    expect(read).toHaveBeenCalledOnce();
  });

  it('keeps capacity for nonterminal parents, active children, truncation and omitted known child legs', async () => {
    const call = await start();
    let value = await record(call.providerCallSid);
    const childCallSid = sid();
    for (const evidence of [
      known(value, { status: 'in-progress' }),
      known(value, { children: [{ callSid: childCallSid, status: 'ringing' }] }),
      known(value, { childrenComplete: false }),
    ]) {
      read.mockResolvedValue(evidence);
      const response = await reconcile(value);
      expect(response.statusCode).toBe(200);
      expect(phoneReconcileResultSchema.parse(response.json())).toMatchObject({
        result: 'held',
        call: { capacityHeld: true },
      });
      value = await record(call.providerCallSid);
    }
    await db.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      const current = await tx.getVoiceCall(call.providerCallSid);
      if (!current) throw new Error('Expected synthetic voice call.');
      await tx.saveVoiceCall(
        { ...current, version: current.version + 1, transferChildSid: childCallSid },
        current.version,
      );
    });
    value = await record(call.providerCallSid);
    read.mockResolvedValue(known(value));
    expect(phoneReconcileResultSchema.parse((await reconcile(value)).json())).toMatchObject({
      result: 'held',
      call: { capacityHeld: true },
    });
  });

  it('treats unavailable, malformed or foreign evidence as holds and permits a fresh read after refresh', async () => {
    const call = await start();
    let value = await record(call.providerCallSid);
    read.mockRejectedValue(new Error('Private provider error must stay out of response.'));
    const unavailable = await reconcile(value);
    expect(unavailable.statusCode).toBe(200);
    expect(phoneReconcileResultSchema.parse(unavailable.json())).toMatchObject({
      result: 'unavailable',
      call: { capacityHeld: true },
    });
    expect(unavailable.body).not.toContain('Private provider');
    value = await record(call.providerCallSid);
    read.mockResolvedValue(known(value, { accountSid: `AC${'f'.repeat(32)}` }));
    expect(phoneReconcileResultSchema.parse((await reconcile(value)).json()).result).toBe(
      'unavailable',
    );
    value = await record(call.providerCallSid);
    read.mockResolvedValue(known(value));
    expect(phoneReconcileResultSchema.parse((await reconcile(value)).json()).result).toBe('ended');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('rejects stale versions before reading and holds changed generations after provider I/O outside transactions', async () => {
    const call = await start();
    const value = await record(call.providerCallSid);
    expect((await reconcile({ ...value, version: value.version + 1 })).statusCode).toBe(409);
    expect(read).not.toHaveBeenCalled();
    let resolveEvidence: ((result: CallStatusResult) => void) | undefined;
    const admitted = new Promise<void>((resolve) => {
      read.mockImplementation(() => {
        resolve();
        return new Promise<CallStatusResult>((complete) => {
          resolveEvidence = complete;
        });
      });
    });
    const pending = reconcile(value);
    await admitted;
    // This transaction finishing while provider I/O is pending proves the API
    // does not hold the embedded DB transaction mutex during external reads.
    await db.withTenant(DEMO_TENANTS.harbor, async (tx) => {
      await tx.lockVoiceAdmission();
      const current = await tx.getVoiceCall(call.providerCallSid);
      if (!current) throw new Error('Expected synthetic voice call.');
      await tx.saveVoiceCall(
        { ...current, version: current.version + 1, generation: randomUUID() },
        current.version,
      );
    });
    resolveEvidence?.(known(value));
    expect((await pending).statusCode).toBe(409);
    expect((await record(call.providerCallSid)).state).toBe('STREAMING');
  });

  it('preserves a terminal callback that wins while provider status is being read', async () => {
    const call = await start();
    const value = await record(call.providerCallSid);
    let resolveEvidence: ((result: CallStatusResult) => void) | undefined;
    const admitted = new Promise<void>((resolve) => {
      read.mockImplementation(() => {
        resolve();
        return new Promise<CallStatusResult>((complete) => {
          resolveEvidence = complete;
        });
      });
    });
    const pending = reconcile(value);
    await admitted;
    expect(
      (
        await internal('end', {
          providerCallSid: call.providerCallSid,
          reason: 'provider_terminal',
        })
      ).statusCode,
    ).toBe(200);
    resolveEvidence?.(known(value, { status: 'in-progress' }));
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(phoneReconcileResultSchema.parse(response.json())).toMatchObject({
      result: 'ended',
      call: { state: 'ENDED', capacityHeld: false },
    });
  });

  it('permits parallel read-only probes but only one held-state revision can win', async () => {
    const call = await start();
    const value = await record(call.providerCallSid);
    let admittedCount = 0;
    let releaseEvidence: (() => void) | undefined;
    let probesAdmitted: (() => void) | undefined;
    const admitted = new Promise<void>((resolve) => {
      probesAdmitted = resolve;
    });
    const evidenceAvailable = new Promise<void>((resolve) => {
      releaseEvidence = resolve;
    });
    read.mockImplementation(async () => {
      admittedCount += 1;
      if (admittedCount === 2) probesAdmitted?.();
      await evidenceAvailable;
      return known(value, { status: 'in-progress' });
    });
    const first = reconcile(value);
    const second = reconcile(value);
    await admitted;
    releaseEvidence?.();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const accepted = responses.find((response) => response.statusCode === 200);
    if (!accepted) throw new Error('Expected one accepted status revision.');
    expect(phoneReconcileResultSchema.parse(accepted.json())).toMatchObject({
      result: 'held',
      call: { state: 'STREAMING', capacityHeld: true, version: value.version + 1 },
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('cannot activate environment capabilities through stored policy and missing credentials remain unavailable', async () => {
    const disabled = await createApp(
      loadConfig({
        NODE_ENV: 'test',
        TWILIO_ACCOUNT_SID: accountSid,
        VOICE_TENANT_ID: DEMO_TENANTS.harbor,
      }),
      db,
    );
    try {
      const loginResponse = await disabled.inject({
        method: 'POST',
        url: '/api/auth/demo',
        headers: { origin },
        payload: { workspace: 'harbor' },
      });
      const rawCookie = loginResponse.headers['set-cookie'];
      if (typeof rawCookie !== 'string') throw new Error('Expected synthetic cookie.');
      const safeHeaders = {
        cookie: rawCookie.split(';')[0] ?? '',
        origin,
        'x-csrf-token': sessionSchema.parse(loginResponse.json()).csrfToken ?? '',
      };
      const initial = phoneOperationsSchema.parse(
        (
          await disabled.inject({
            method: 'GET',
            url: '/api/phone/operations',
            headers: safeHeaders,
          })
        ).json(),
      );
      expect(initial.configured).toEqual({
        voiceEnabled: false,
        requestsEnabled: false,
        transfersEnabled: false,
        reconciliationAvailable: false,
      });
      const save = await disabled.inject({
        method: 'PUT',
        url: '/api/phone/policy',
        headers: safeHeaders,
        payload: {
          expectedVersion: initial.policy.version,
          policy: { voiceEnabled: true, requestsEnabled: true, transfersEnabled: true },
        },
      });
      expect(save.statusCode).toBe(200);
      const after = phoneOperationsSchema.parse(
        (
          await disabled.inject({
            method: 'GET',
            url: '/api/phone/operations',
            headers: safeHeaders,
          })
        ).json(),
      );
      expect(after.policy.voiceEnabled).toBe(true);
      expect(after.configured.voiceEnabled).toBe(false);
      const call = await start();
      const value = await record(call.providerCallSid);
      expect(
        (
          await disabled.inject({
            method: 'POST',
            url: `/api/phone/calls/${call.voiceCallId}/reconcile`,
            headers: safeHeaders,
            payload: { expectedVersion: value.version },
          })
        ).statusCode,
      ).toBe(409);
      expect(read).not.toHaveBeenCalled();
    } finally {
      await disabled.close();
    }
  });
});
