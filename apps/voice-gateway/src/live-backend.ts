import { z } from 'zod';
import { voiceProposalInputSchema } from '@hostline/contracts';
import { toolsFor, type RelayOptions } from './relay.js';
import type { LiveDelegationInput, LiveDelegationResult } from './live-relay.js';

const functionCall = z.object({
  type: z.literal('function_call'),
  name: z.enum([
    'prepare_request',
    'prepare_message',
    'request_staff_transfer',
    'ask_for_request_details',
  ]),
  call_id: z.string().min(1).max(128),
  arguments: z.string().min(2).max(4096),
});
const outputEnvelope = z.object({
  status: z.literal('completed'),
  output: z.array(z.object({ type: z.string().max(80) }).passthrough()).max(16),
});
type ToolName = z.infer<typeof functionCall>['name'];
const clarificationFields = {
  reservation: ['dateExpression', 'time', 'partySize', 'name', 'callbackNumber'],
  message: ['message', 'name', 'callbackNumber'],
} as const;
const clarificationQuestions = {
  dateExpression: 'What date would you like?',
  time: 'What time would you like?',
  partySize: 'How many people is the request for?',
  name: 'What name should I put on the request?',
  callbackNumber: 'What callback number should staff use, including the country code?',
  message: 'What message would you like to leave for staff?',
} as const;
const callbackNumber =
  voiceProposalInputSchema.options[0].shape.reservation.shape.callbackNumber.describe(
    'Normalize only the digits and country code explicitly supplied by the caller. Join spoken digit groups without changing digits. If the caller never supplied a country code, use ask_for_request_details for callbackNumber instead of preparing. Never infer a country code from the restaurant or a national number.',
  );
const argumentSchemas = {
  prepare_request: voiceProposalInputSchema.options[0].shape.reservation
    .extend({
      callbackNumber,
      dateExpression:
        voiceProposalInputSchema.options[0].shape.reservation.shape.dateExpression.describe(
          'Copy the caller date expression from the transcript with its original wording, spacing and punctuation. Do not calculate relative dates or rewrite the expression.',
        ),
      date_utterance_id: z
        .uuid()
        .describe(
          'Original dateReference whose text range contains the beginning of the current dateExpression. Use the new reference after an explicit date correction; never use a later name or phone fragment reference.',
        ),
    })
    .strict(),
  prepare_message: voiceProposalInputSchema.options[1].shape.message.extend({ callbackNumber }),
  request_staff_transfer: z
    .object({
      reason: z.enum(['requested_staff', 'allergy_question', 'other']).optional(),
      summary: z.string().trim().max(300).optional(),
    })
    .strict(),
  ask_for_request_details: z
    .object({
      kind: z.enum(['reservation', 'message']),
      field: z
        .enum(['dateExpression', 'time', 'partySize', 'name', 'callbackNumber', 'message'])
        .describe(
          'One missing or unclear field only. For reservation use dateExpression, time, partySize, name or callbackNumber. For message use message, name or callbackNumber.',
        ),
    })
    .strict()
    .refine(({ kind, field }) => clarificationFields[kind].some((allowed) => allowed === field)),
};
// Responses strict mode requires every property. Only these domain-optional
// fields may use null on the wire; required caller details stay non-nullable.
const strictArgumentSchemas = {
  prepare_request: argumentSchemas.prepare_request.extend({
    notes: argumentSchemas.prepare_request.shape.notes.unwrap().nullable(),
  }),
  prepare_message: argumentSchemas.prepare_message,
  request_staff_transfer: argumentSchemas.request_staff_transfer.extend({
    reason: argumentSchemas.request_staff_transfer.shape.reason.unwrap().nullable(),
    summary: argumentSchemas.request_staff_transfer.shape.summary.unwrap().nullable(),
  }),
  ask_for_request_details: argumentSchemas.ask_for_request_details,
};
const optionalFields: Record<ToolName, readonly string[]> = {
  prepare_request: ['notes'],
  prepare_message: [],
  request_staff_transfer: ['reason', 'summary'],
  ask_for_request_details: [],
};

function normalizeArguments(name: ToolName, text: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(text);
  strictArgumentSchemas[name].parse(decoded);
  const normalized = z.record(z.string(), z.unknown()).parse(decoded);
  for (const field of optionalFields[name]) {
    if (normalized[field] === null) delete normalized[field];
  }
  // Keep the existing domain validation as an independent boundary. Its default
  // values are applied by the relay; null optional values remain omitted here.
  argumentSchemas[name].parse(normalized);
  return normalized;
}

interface BackendTurn {
  role: 'user' | 'assistant';
  text: string;
  dateReferences?: Array<{
    start: number;
    end: number;
    dateReference: string;
    startedAt?: string;
  }>;
}

function groupTranscript(transcript: LiveDelegationInput['transcript']): BackendTurn[] {
  const turns: BackendTurn[] = [];
  for (const fragment of transcript) {
    let turn = turns.at(-1);
    if (!turn || turn.role !== fragment.role) {
      turn = { role: fragment.role, text: '' };
      turns.push(turn);
    }
    const start = turn.text.length;
    // Preserve provider spacing and order. These are readable text groups,
    // not inferred utterance boundaries or newly minted date authority.
    turn.text += fragment.text;
    if (fragment.role === 'user' && fragment.dateReference !== undefined) {
      turn.dateReferences ??= [];
      turn.dateReferences.push({
        start,
        end: turn.text.length,
        dateReference: fragment.dateReference,
        ...(fragment.startedAt === undefined ? {} : { startedAt: fragment.startedAt }),
      });
    }
  }
  return turns;
}

function groundDateReference(
  turns: BackendTurn[],
  expression: string,
  selectedReference: string,
): string | undefined {
  const turn = turns.find(
    (candidate) =>
      candidate.role === 'user' &&
      candidate.dateReferences?.some((reference) => reference.dateReference === selectedReference),
  );
  const references = turn?.dateReferences;
  if (!turn || !references) return undefined;
  const selected = references.find((reference) => reference.dateReference === selectedReference);
  if (!selected) return undefined;
  // This grounds literal text only within the model-selected caller group. It
  // neither interprets dates nor searches unrelated turns to repair authority.
  const literal = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [
    ...turn.text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])`, 'giu')),
  ];
  if (matches.some((match) => match.index >= selected.start && match.index < selected.end))
    return selectedReference;
  if (matches.length !== 1) return undefined;
  const start = matches[0]?.index;
  if (start === undefined) return undefined;
  return references.find((reference) => reference.start <= start && start < reference.end)
    ?.dateReference;
}

/** Stateless, bounded delegation. It proposes a tool; the relay/API own all execution. */
export function createLiveBackend(
  options: Pick<RelayOptions, 'actionsEnabled' | 'transfersEnabled'> & {
    apiKey: string;
    model: 'gpt-6-luna';
    instructions: string;
  },
  fetcher: typeof fetch = fetch,
): (input: LiveDelegationInput) => Promise<LiveDelegationResult> {
  const availableTools = toolsFor(options);
  if (options.actionsEnabled)
    availableTools.push({
      type: 'function',
      name: 'ask_for_request_details',
      description:
        'Select one missing or unclear required field for an ongoing reservation request or message. The server asks a single fixed question for that field. Reuse clear details already supplied by the caller. This read-only question keeps collection active; it never prepares, confirms, saves or books. Do not use for FAQs or canceled tasks.',
    });
  const tools = availableTools.map((tool) => {
    const name = functionCall.shape.name.parse(tool.name);
    return {
      ...tool,
      strict: true,
      parameters: z.toJSONSchema(strictArgumentSchemas[name]),
    };
  });
  return async ({ transcript, signal }) => {
    // No retries, persisted provider state, arbitrary URLs, or caller-selected tools.
    const turns = groupTranscript(transcript);
    const input = JSON.stringify(turns);
    if (!transcript.length || Buffer.byteLength(input) > 64 * 1024)
      throw new Error('Voice backend context unavailable');
    const cancellation = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    const response = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST',
      redirect: 'error',
      signal: cancellation,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        instructions: options.instructions,
        store: false,
        reasoning: { effort: 'low' },
        max_output_tokens: 1024,
        parallel_tool_calls: false,
        tools,
        tool_choice: tools.length ? 'auto' : 'none',
        input: [{ role: 'user', content: [{ type: 'input_text', text: input }] }],
      }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Voice backend unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 64 * 1024) throw new Error('Voice backend response limit');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    cancellation.throwIfAborted();
    const result = outputEnvelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const calls = result.output.filter((item) => item.type === 'function_call');
    if (calls.length > 1) throw new Error('Voice backend action limit');
    if (calls.length === 1) {
      const tool = functionCall.parse(calls[0]);
      if (!tools.some((enabled) => enabled.name === tool.name))
        throw new Error('Voice backend tool unavailable');
      const normalized = normalizeArguments(tool.name, tool.arguments);
      if (tool.name === 'ask_for_request_details') {
        const { field } = argumentSchemas.ask_for_request_details.parse(normalized);
        return { kind: 'reply', text: clarificationQuestions[field], awaitingCaller: true };
      }
      if (tool.name === 'prepare_request') {
        const reservation = argumentSchemas.prepare_request.parse(normalized);
        const reference = groundDateReference(
          turns,
          reservation.dateExpression,
          reservation.date_utterance_id,
        );
        if (reference === undefined)
          return {
            kind: 'reply',
            text: clarificationQuestions.dateExpression,
            awaitingCaller: true,
          };
        normalized.date_utterance_id = reference;
      }
      return {
        kind: 'tool',
        name: tool.name,
        arguments: JSON.stringify(normalized),
        callId: tool.call_id,
      };
    }
    const text = result.output
      .filter((item) => item.type === 'message')
      .flatMap(
        (item) =>
          z
            .object({
              content: z.array(z.object({ type: z.string(), text: z.string().optional() })).max(8),
            })
            .parse(item).content,
      )
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join(' ')
      .trim();
    // GPT-Live appends accept at most 500 tokens. This conservative UTF-8 bound
    // also covers text outside English without estimating tokenization.
    if (!text || Buffer.byteLength(text) > 480) throw new Error('Voice backend reply unavailable');
    return { kind: 'reply', text };
  };
}
