import { z } from 'zod';
import { toolsFor, type RelayOptions } from './relay.js';
import type { LiveDelegationInput, LiveDelegationResult } from './live-relay.js';

const functionCall = z.object({
  type: z.literal('function_call'),
  name: z.enum(['prepare_request', 'prepare_message', 'request_staff_transfer']),
  call_id: z.string().min(1).max(128),
  arguments: z.string().min(2).max(4096),
});
const outputEnvelope = z.object({
  status: z.literal('completed'),
  output: z.array(z.object({ type: z.string().max(80) }).passthrough()).max(16),
});

/** Stateless, bounded delegation. It proposes a tool; the relay/API own all execution. */
export function createLiveBackend(
  options: Pick<RelayOptions, 'actionsEnabled' | 'transfersEnabled'> & {
    apiKey: string;
    model: 'gpt-6-luna';
    instructions: string;
  },
  fetcher: typeof fetch = fetch,
): (input: LiveDelegationInput) => Promise<LiveDelegationResult> {
  const tools = toolsFor(options).map((tool) => ({ ...tool, strict: false }));
  return async ({ transcript, signal }) => {
    // No retries, persisted provider state, arbitrary URLs, or caller-selected tools.
    const input = JSON.stringify(transcript);
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
      return { kind: 'tool', name: tool.name, arguments: tool.arguments, callId: tool.call_id };
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
