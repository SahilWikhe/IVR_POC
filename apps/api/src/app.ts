import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  confirmInputSchema,
  idSchema,
  inboxActionSchema,
  settingsUpdateSchema,
  turnInputSchema,
} from '@hostline/contracts';
import {
  advanceConversation,
  confirmSimulation,
  createSimulationSession,
  transitionInbox,
} from '@hostline/domain';
import { getIntegrationStatuses, type CallStatusReader } from '@hostline/connectors';
import type { Database, TenantTransaction } from '@hostline/database';
import type { AppConfig } from '@hostline/config';
import { logEvent } from '@hostline/observability';
import { registerAuth } from './auth.js';
import { registerVoiceActions } from './voice.js';
import { registerPhoneOperations } from './phone-operations.js';

class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const routeParams = z.object({ id: idSchema }).strict();
const versionBody = z.object({ expectedVersion: z.number().int().positive() }).strict();
const emptyBody = z.object({}).strict();
const inboxQuery = z
  .object({
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(200),
  })
  .strict();
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function compareVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new ApiError('VERSION_CONFLICT', 409, 'This item changed. Refresh and try again.');
}
async function requiredCall(tx: TenantTransaction, id: string) {
  const call = await tx.getCall(id);
  if (!call) throw new ApiError('NOT_FOUND', 404, 'Call not found.');
  if (call.mode !== 'simulation')
    throw new ApiError(
      'SIMULATION_ONLY',
      403,
      'Phone calls cannot be modified through the simulator.',
    );
  return call;
}

export async function createApp(
  config: AppConfig,
  db: Database,
  dependencies: { callStatusReader?: CallStatusReader } = {},
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 15000,
    trustProxy: false,
  });
  await app.register(cookie, { secret: config.auth.sessionSecret });
  await app.register(helmet);
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  const auth = await registerAuth(app, config.auth);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.addHook('onClose', async () => {
    auth.close();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: 'INVALID_INPUT',
          message: 'Check the submitted fields and try again.',
          requestId: request.id,
        },
      });
    const known = z
      .object({ status: z.number().int().min(400).max(499), code: z.string(), message: z.string() })
      .safeParse(error);
    if (known.success)
      return reply
        .code(known.data.status)
        .send({ error: { ...known.data, requestId: request.id } });
    const http = z.object({ statusCode: z.number().int().min(400).max(499) }).safeParse(error);
    if (http.success)
      return reply.code(http.data.statusCode).send({
        error: {
          code: 'REQUEST_REJECTED',
          message: 'The request could not be accepted.',
          requestId: request.id,
        },
      });
    logEvent({ event: 'api.error', requestId: request.id, code: 'INTERNAL_ERROR' });
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        requestId: request.id,
      },
    });
  });
  function actor(request: FastifyRequest, write = false) {
    return write ? auth.requireRole(request, ['owner', 'staff']) : auth.actor(request);
  }
  app.get('/api/health', async () => ({
    status: 'ok',
    mode: config.auth.mode,
    liveReservations: false,
  }));
  app.get('/api/bootstrap', async (request) => {
    const user = actor(request);
    return db.withTenant(user.tenantId, async (tx) => ({
      restaurant: await tx.getRestaurant(),
      inbox: await tx.listInbox(),
      calls: await tx.listCalls(),
      integrations: getIntegrationStatuses(),
    }));
  });
  app.get('/api/inbox', async (request) => {
    const user = actor(request),
      query = inboxQuery.parse(request.query);
    return db.withTenant(user.tenantId, (tx) => tx.listInbox(query));
  });
  app.get('/api/inbox/:id', async (request) => {
    const user = actor(request);
    const { id } = routeParams.parse(request.params);
    return db.withTenant(user.tenantId, async (tx) => {
      const item = await tx.getInbox(id);
      if (!item) throw new ApiError('NOT_FOUND', 404, 'Request not found.');
      return item;
    });
  });
  app.put('/api/restaurant', async (request) => {
    const user = auth.requireRole(request, ['owner']);
    const input = settingsUpdateSchema.parse(request.body);
    if (
      input.settings.transferEnabled &&
      (!input.settings.transferNumber ||
        [input.settings.publicPhone, config.twilioPhoneNumber].includes(
          input.settings.transferNumber,
        ))
    )
      throw new ApiError(
        'TRANSFER_LOOP',
        400,
        'Use a staff destination different from the restaurant and AI phone numbers.',
      );
    return db.withTenant(user.tenantId, async (tx) => {
      const previous = await tx.getRestaurant();
      compareVersion(previous.version, input.expectedVersion);
      const next = {
        ...input.settings,
        id: previous.id,
        version: previous.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await tx.saveRestaurant(next, input.expectedVersion);
      await tx.audit(user.userId, 'restaurant.updated', next.id);
      return next;
    });
  });
  app.patch('/api/inbox/:id', async (request) => {
    const user = actor(request, true),
      { id } = routeParams.parse(request.params),
      input = inboxActionSchema.parse(request.body);
    return db.withTenant(user.tenantId, async (tx) => {
      const item = await tx.getInbox(id);
      if (!item) throw new ApiError('NOT_FOUND', 404, 'Request not found.');
      compareVersion(item.version, input.expectedVersion);
      const next = transitionInbox(item, input, user, new Date());
      await tx.saveInbox(next, item.version);
      await tx.audit(user.userId, `inbox.${input.action.toLowerCase()}`, id);
      await tx.enqueue('inbox.updated', id);
      return next;
    });
  });
  app.post('/api/simulator/calls', async (request) => {
    const user = actor(request, true);
    emptyBody.parse(request.body ?? {});
    if (config.auth.mode !== 'demo')
      throw new ApiError(
        'SIMULATION_DISABLED',
        403,
        'The simulator is restricted to synthetic demo workspaces.',
      );
    return db.withTenant(user.tenantId, async (tx) => {
      const call = createSimulationSession(await tx.getRestaurant(), new Date());
      await tx.insertCall(call);
      await tx.audit(user.userId, 'simulation.started', call.id);
      return call;
    });
  });
  app.get('/api/simulator/calls/:id', async (request) => {
    const user = actor(request),
      { id } = routeParams.parse(request.params);
    return db.withTenant(user.tenantId, (tx) => requiredCall(tx, id));
  });
  app.post('/api/simulator/calls/:id/turn', async (request) => {
    const user = actor(request, true),
      { id } = routeParams.parse(request.params),
      input = turnInputSchema.parse(request.body);
    return db.withTenant(user.tenantId, async (tx) => {
      const call = await requiredCall(tx, id),
        key = `turn:${id}:${input.clientTurnId}`,
        hash = fingerprint(input),
        receipt = await tx.getReceipt(key);
      if (receipt) {
        if (receipt.fingerprint !== hash)
          throw new ApiError('IDEMPOTENCY_CONFLICT', 409, 'This retry contains different details.');
        return receipt.result;
      }
      compareVersion(call.version, input.expectedVersion);
      const next = advanceConversation(call, input.text, await tx.getRestaurant(), new Date());
      await tx.saveCall(next, call.version);
      await tx.putReceipt(key, hash, next);
      return next;
    });
  });
  app.post('/api/simulator/calls/:id/confirm', async (request) => {
    const user = actor(request, true),
      { id } = routeParams.parse(request.params),
      input = confirmInputSchema.parse(request.body);
    return db.withTenant(user.tenantId, async (tx) => {
      const call = await requiredCall(tx, id),
        key = `confirm:${id}:${input.idempotencyKey}`,
        hash = fingerprint(input),
        receipt = await tx.getReceipt(key);
      if (receipt) {
        if (receipt.fingerprint !== hash)
          throw new ApiError('IDEMPOTENCY_CONFLICT', 409, 'This retry contains different details.');
        return receipt.result;
      }
      compareVersion(call.version, input.expectedVersion);
      const result = confirmSimulation(
        call,
        input.proposalId,
        await tx.getRestaurant(),
        new Date(),
      );
      await tx.insertInbox(result.item);
      await tx.saveCall(result.call, call.version);
      await tx.enqueue('inbox.created', result.item.id);
      await tx.audit(user.userId, 'inbox.created', result.item.id);
      await tx.putReceipt(key, hash, result.call);
      return result.call;
    });
  });
  app.post('/api/simulator/calls/:id/end', async (request) => {
    const user = actor(request, true),
      { id } = routeParams.parse(request.params),
      input = versionBody.parse(request.body);
    return db.withTenant(user.tenantId, async (tx) => {
      const call = await requiredCall(tx, id);
      compareVersion(call.version, input.expectedVersion);
      if (call.status !== 'active') return call;
      const next = {
        ...call,
        status: 'ended' as const,
        phase: 'complete' as const,
        proposal: null,
        draft: {},
        version: call.version + 1,
        updatedAt: new Date().toISOString(),
        outcome: 'Simulation ended without submitting a new request.',
      };
      await tx.saveCall(next, call.version);
      return next;
    });
  });
  app.get('/internal/voice/context', async (request) => {
    const supplied = Buffer.from(request.headers.authorization ?? ''),
      expected = Buffer.from(`Bearer ${config.voiceServiceToken ?? ''}`);
    if (
      !config.voiceServiceToken ||
      !config.voiceTenantId ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new ApiError('UNAUTHORIZED', 401, 'Unauthorized.');
    return db.withTenant(config.voiceTenantId, async (tx) => ({
      tenantId: config.voiceTenantId,
      restaurant: await tx.getRestaurant(),
    }));
  });
  await registerVoiceActions(app, config, db);
  await registerPhoneOperations(app, config, db, auth, dependencies);
  return app;
}
