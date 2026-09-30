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
  })
  .strict();
const preparationResponse = z.object({ controlId: uuid, twiml }).strict();
const dispatchResponse = z
  .object({ dispatch: z.boolean(), twiml: twiml.nullable(), unavailable: z.boolean() })
  .strict();
const callbackResponse = z
  .object({ ...scope, twiml, outcome: z.string().max(500).nullable() })
  .strict();

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
  propose(
    input: CallBinding & {
      toolCallId: string;
      utteranceStartedAt: string;
      proposal: VoiceProposalInput;
    },
  ): Promise<z.infer<typeof preparationResponse>>;
  transfer(
    input: CallBinding & { toolCallId: string },
  ): Promise<z.infer<typeof preparationResponse>>;
  dispatch(input: CallBinding & { controlId: string }): Promise<z.infer<typeof dispatchResponse>>;
  dispatched(
    input: CallBinding & { controlId: string; outcome: 'accepted' | 'rejected' | 'unknown' },
  ): Promise<z.infer<typeof stateResponse>>;
  confirmation(input: {
    providerCallSid: string;
    confirmationToken: string;
    speechResult?: string;
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
  const post = async <T>(path: string, input: object, schema: z.ZodType<T>): Promise<T> => {
    const response = await transport(`${config.apiUrl}/internal/voice/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.serviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!response.ok || !response.body) throw new Error('Voice control unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 128 * 1024) throw new Error('Voice control response limit');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
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
    propose: (input) => post('propose', input, preparationResponse),
    transfer: (input) => post('transfer', input, preparationResponse),
    dispatch: (input) => post('dispatch', input, dispatchResponse),
    dispatched: (input) => post('dispatched', input, stateResponse),
    confirmation: (input) => post('confirmation', input, callbackResponse),
    transferStatus: (input) => post('transfer-status', input, stateResponse),
    transferResult: (input) => post('transfer-result', input, callbackResponse),
  };
}
