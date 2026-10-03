import { z } from 'zod';
import {
  restaurantSchema,
  voiceCallStateSchema,
  type VoiceProposalInput,
} from '@hostline/contracts';
import type { EnabledVoiceConfig } from './config.js';

const uuid = z.uuid();
const twiml = z.string().min(1).max(20_000);
const scope = { tenantId: uuid };
const stateResponse = z.object({ state: voiceCallStateSchema }).strict();
const admissionResponse = z
  .object({ voiceCallId: uuid, generation: uuid, ...scope, twiml, state: voiceCallStateSchema })
  .strict();
const redemptionResponse = z
  .object({
    voiceCallId: uuid,
    generation: uuid,
    ...scope,
    restaurant: restaurantSchema,
    expiresAt: z.iso.datetime({ offset: true }),
    outcome: z.string().max(500).nullable(),
    actionsEnabled: z.boolean(),
    transfersEnabled: z.boolean(),
    configurationVersion: z.number().int().positive(),
  })
  .strict();
const preparationResponse = z.object({ controlId: uuid, twiml }).strict();
const dispatchResponse = z
  .object({ dispatch: z.boolean(), twiml: twiml.nullable(), unavailable: z.boolean() })
  .strict();
const callbackResponse = z
  .object({ ...scope, twiml, outcome: z.string().max(500).nullable() })
  .strict();
const policyResponse = z
  .object({
    allowed: z.boolean(),
    configurationVersion: z.number().int().positive(),
    actionsEnabled: z.boolean(),
    transfersEnabled: z.boolean(),
  })
  .strict();

// Only documented application codes may cross into operational logs. Never
// retain the response message, submitted fields, request ID or raw error body.
const controlErrorCode = z.enum([
  'INVALID_INPUT',
  'INVALID_VOICE_PROPOSAL',
  'INVALID_UTTERANCE_REFERENCE',
  'INVALID_DATE',
  'AMBIGUOUS_DATE',
  'INVALID_LOCAL_TIME',
  'INVALID_RESERVATION',
  'PAST_RESERVATION',
  'PARTY_TOO_LARGE',
  'OUTSIDE_REQUEST_HORIZON',
  'RESTAURANT_CLOSED',
  'CALL_BUDGET_EXCEEDED',
  'READBACK_TOO_LONG',
  'ACTIONS_DISABLED',
  'PHONE_POLICY_REVOKED',
  'CALL_NOT_ACTIVE',
  'STALE_GENERATION',
]);
export class VoiceControlError extends Error {
  constructor(readonly code: z.infer<typeof controlErrorCode> | 'CONTROL_UNAVAILABLE') {
    super('Voice control unavailable');
    this.name = 'VoiceControlError';
  }
}

export interface TransferContext {
  reason: 'requested_staff' | 'allergy_question' | 'other';
  summary: string;
}

export interface CallBinding {
  providerCallSid: string;
  generation: string;
}
export interface VoiceApiClient {
  admit(input: {
    providerCallSid: string;
    accountSid: string;
  }): Promise<z.infer<typeof admissionResponse>>;
  redeem(input: {
    providerCallSid: string;
    streamSid: string;
    streamGrant: string;
  }): Promise<z.infer<typeof redemptionResponse>>;
  end(input: {
    providerCallSid: string;
    generation?: string;
    reason: 'stream_closed' | 'provider_terminal';
  }): Promise<z.infer<typeof stateResponse>>;
  policy(input: CallBinding, signal?: AbortSignal): Promise<z.infer<typeof policyResponse>>;
  propose(
    input: CallBinding & {
      toolCallId: string;
      utteranceStartedAt: string;
      proposal: VoiceProposalInput;
    },
  ): Promise<z.infer<typeof preparationResponse>>;
  transfer(
    input: CallBinding & { toolCallId: string; context?: TransferContext },
  ): Promise<z.infer<typeof preparationResponse>>;
  dispatch(input: CallBinding & { controlId: string }): Promise<z.infer<typeof dispatchResponse>>;
  dispatched(
    input: CallBinding & { controlId: string; outcome: 'accepted' | 'rejected' | 'unknown' },
  ): Promise<z.infer<typeof stateResponse>>;
  confirmation(input: {
    providerCallSid: string;
    confirmationToken: string;
    speechResult?: string;
    digits?: string;
    confidence?: number;
  }): Promise<z.infer<typeof callbackResponse>>;
  transferStatus(input: {
    transferToken: string;
    childCallSid: string;
    status: string;
    parentCallSid?: string;
  }): Promise<z.infer<typeof stateResponse>>;
  transferResult(input: {
    providerCallSid: string;
    transferToken: string;
    dialCallSid?: string;
    dialCallStatus: string;
    bridged: boolean;
  }): Promise<z.infer<typeof callbackResponse>>;
}

/** Scoped server-to-server calls. No redirects, raw errors, body logging, or automatic retries. */
export function createVoiceApiClient(
  config: EnabledVoiceConfig,
  transport: typeof fetch = fetch,
): VoiceApiClient {
  const post = async <T>(
    path: string,
    input: object,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const response = await transport(`${config.apiUrl}/internal/voice/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.serviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
        : AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!response.body) throw new VoiceControlError('CONTROL_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > (response.ok ? 128 * 1024 : 4096))
          throw new VoiceControlError('CONTROL_UNAVAILABLE');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    if (!response.ok) {
      let code: z.infer<typeof controlErrorCode> | 'CONTROL_UNAVAILABLE' = 'CONTROL_UNAVAILABLE';
      if (response.status >= 400 && response.status < 500) {
        try {
          const error = z
            .object({ error: z.object({ code: controlErrorCode }) })
            .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          code = error.error.code;
        } catch {
          /* Unknown or malformed errors stay generic. */
        }
      }
      throw new VoiceControlError(code);
    }
    const result = schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (
      typeof result === 'object' &&
      result !== null &&
      'tenantId' in result &&
      result.tenantId !== config.tenantId
    )
      throw new Error('Voice control scope mismatch');
    return result;
  };
  return {
    admit: (input) => post('admit', input, admissionResponse),
    redeem: async (input) => {
      const result = await post('redeem', input, redemptionResponse);
      if (result.restaurant.id !== config.tenantId) throw new Error('Voice context scope mismatch');
      return result;
    },
    end: (input) => post('end', input, stateResponse),
    policy: (input, signal) => post('policy', input, policyResponse, signal),
    propose: (input) => post('propose', input, preparationResponse),
    transfer: (input) => post('transfer', input, preparationResponse),
    dispatch: (input) => post('dispatch', input, dispatchResponse),
    dispatched: (input) => post('dispatched', input, stateResponse),
    confirmation: (input) => post('confirmation', input, callbackResponse),
    transferStatus: (input) => post('transfer-status', input, stateResponse),
    transferResult: (input) => post('transfer-result', input, callbackResponse),
  };
}
