import { describe, expect, it, vi } from 'vitest';
import { createLiveBackend } from '../apps/voice-gateway/src/live-backend.js';
import { loadVoiceConfig } from '../apps/voice-gateway/src/config.js';

type BackendInput = Parameters<ReturnType<typeof createLiveBackend>>[0];
type BackendOptions = Parameters<typeof createLiveBackend>[0];
const options: BackendOptions = {
  apiKey: 'synthetic-openai-test-key',
  model: 'gpt-6-luna',
  instructions: 'Use approved synthetic restaurant facts. Tools prepare requests only.',
};

function input(signal = new AbortController().signal): BackendInput {
  return {
    transcript: [
      { role: 'assistant', text: 'Which day would you like?' },
      {
        role: 'user',
        text: ' Tomorrow, please.',
        dateReference: '11111111-1111-4111-8111-111111111111',
        startedAt: '2026-10-02T23:59:59.000Z',
      },
    ],
    signal,
  };
}

function reply(text = 'I can take a request for staff review.') {
  return {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  };
}

function tool(name = 'prepare_request', argumentsText = '{"dateExpression":"tomorrow"}') {
  return { type: 'function_call', name, arguments: argumentsText, call_id: 'synthetic-call-id' };
}

function fixture(payload: unknown = reply(), capabilities: Partial<BackendOptions> = {}) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload));
  return { fetcher, backend: createLiveBackend({ ...options, ...capabilities }, fetcher) };
}

describe('GPT-Live stateless client backend', () => {
  it('returns a reply using the fixed endpoint, transient context, and bounded request', async () => {
    const f = fixture();
    const context = input();
    await expect(f.backend(context)).resolves.toEqual({
      kind: 'reply',
      text: 'I can take a request for staff review.',
    });
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, request] = f.fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(request?.body))).toEqual({
      model: 'gpt-6-luna',
      instructions: options.instructions,
      store: false,
      reasoning: { effort: 'low' },
      max_output_tokens: 1024,
      parallel_tool_calls: false,
      tools: [],
      tool_choice: 'none',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: JSON.stringify(context.transcript) }],
        },
      ],
    });
    const next = input();
    next.transcript = [{ role: 'user', text: 'Actually Thursday.' }];
    await f.backend(next);
    const subsequent = JSON.parse(String(f.fetcher.mock.calls[1]?.[1]?.body));
    expect(subsequent.store).toBe(false);
    expect(subsequent).not.toHaveProperty('previous_response_id');
    expect(subsequent).not.toHaveProperty('conversation');
    expect(subsequent.input[0].content[0].text).toBe(JSON.stringify(next.transcript));
  });

  it.each([
    { actionsEnabled: false, transfersEnabled: false, names: [] },
    {
      actionsEnabled: true,
      transfersEnabled: false,
      names: ['prepare_request', 'prepare_message'],
    },
    { actionsEnabled: false, transfersEnabled: true, names: ['request_staff_transfer'] },
    {
      actionsEnabled: true,
      transfersEnabled: true,
      names: ['prepare_request', 'prepare_message', 'request_staff_transfer'],
    },
  ])('advertises only authorized proposal tools: %j', async (capabilities) => {
    const { names, ...permissions } = capabilities;
    const f = fixture(reply(), permissions);
    await f.backend(input());
    const request = JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body));
    expect(request.tools.map((entry: { name: string }) => entry.name)).toEqual(names);
    expect(request.tool_choice).toBe(names.length ? 'auto' : 'none');
    expect(request.parallel_tool_calls).toBe(false);
    for (const entry of request.tools) {
      expect(entry.type).toBe('function');
      expect(entry.name).not.toMatch(/save|confirm|book/);
      expect(entry.parameters).toBeTypeOf('object');
    }
  });

  it.each(['prepare_request', 'prepare_message', 'request_staff_transfer'])(
    'returns %s as an unexecuted proposal, without another provider call',
    async (name) => {
      const proposal = tool(name);
      const f = fixture(
        { status: 'completed', output: [proposal] },
        { actionsEnabled: true, transfersEnabled: true },
      );
      await expect(f.backend(input())).resolves.toEqual({
        kind: 'tool',
        name,
        arguments: proposal.arguments,
        callId: proposal.call_id,
      });
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(['incomplete', 'failed', 'cancelled', 'in_progress'])(
    'rejects a %s response even if it contains usable-looking output',
    async (status) => {
      const f = fixture({ ...reply(), status });
      await expect(f.backend(input())).rejects.toThrow();
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );

  it('rejects multiple function proposals before any can be used', async () => {
    const f = fixture(
      { status: 'completed', output: [tool(), tool('prepare_message')] },
      { actionsEnabled: true },
    );
    await expect(f.backend(input())).rejects.toThrow('Voice backend action limit');
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'save_request', actionsEnabled: true, transfersEnabled: true },
    { name: 'prepare_request', actionsEnabled: false, transfersEnabled: true },
    { name: 'prepare_message', actionsEnabled: false, transfersEnabled: true },
    { name: 'request_staff_transfer', actionsEnabled: true, transfersEnabled: false },
  ])('rejects unknown or unauthorized tools: %j', async ({ name, ...permissions }) => {
    const f = fixture({ status: 'completed', output: [tool(name)] }, permissions);
    await expect(f.backend(input())).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { status: 'completed', output: 'not-an-array' },
    { status: 'completed', output: Array.from({ length: 17 }, () => ({ type: 'reasoning' })) },
    { status: 'completed', output: [{ type: 'message', content: 'not-content' }] },
    { status: 'completed', output: [tool('prepare_request', '{}'), { type: 9 }] },
    { status: 'completed', output: [{ ...tool(), call_id: '' }] },
    { status: 'completed', output: [{ ...tool(), arguments: 'x'.repeat(4097) }] },
    { status: 'completed', output: [] },
    reply(''),
    reply(' '.repeat(8)),
    reply('x'.repeat(481)),
    reply('é'.repeat(241)),
  ])('rejects malformed, empty, or oversized reply data: %j', async (payload) => {
    const f = fixture(payload, { actionsEnabled: true });
    await expect(f.backend(input())).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('rejects invalid JSON without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{broken json'));
    await expect(createLiveBackend(options, fetcher)(input())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['empty', 'oversized'] as const)('rejects %s input before fetching', async (scenario) => {
    const f = fixture();
    const context = input();
    context.transcript =
      scenario === 'empty' ? [] : [{ role: 'user', text: 'x'.repeat(64 * 1024) }];
    await expect(f.backend(context)).rejects.toThrow('Voice backend context unavailable');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('cancels an oversized streamed response rather than reading it to completion', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(createLiveBackend(options, fetcher)(input())).rejects.toThrow(
      'Voice backend response limit',
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([302, 429, 500])('cancels HTTP %s response bodies without retries', async (status) => {
    const cancel = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { status }));
    await expect(createLiveBackend(options, fetcher)(input())).rejects.toThrow(
      'Voice backend unavailable',
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects a successful HTTP response without a body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(createLiveBackend(options, fetcher)(input())).rejects.toThrow(
      'Voice backend unavailable',
    );
  });

  it('propagates caller cancellation to an in-flight request without retrying', async () => {
    const cancellation = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, request) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = request?.signal;
          if (!signal) throw new Error('Missing cancellation signal');
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const pending = createLiveBackend(options, fetcher)(input(cancellation.signal));
    const rejection = expect(pending).rejects.toThrow('Synthetic caller left');
    cancellation.abort(new Error('Synthetic caller left'));
    await rejection;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('rejects a late successful result when its caller signal was already aborted', async () => {
    const cancellation = new AbortController();
    cancellation.abort(new Error('Synthetic stale request'));
    const f = fixture();
    await expect(f.backend(input(cancellation.signal))).rejects.toThrow('Synthetic stale request');
  });
});

describe('voice model configuration', () => {
  const environment = {
    LIVE_VOICE_ENABLED: 'true',
    VOICE_MODE: 'sandbox',
    TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: 'synthetic-twilio-test-token',
    TWILIO_PHONE_NUMBER: '+12125550142',
    OPENAI_API_KEY: 'synthetic-openai-test-key',
    VOICE_PUBLIC_URL: 'https://voice.example.test',
    VOICE_SERVICE_TOKEN: 'synthetic-internal-service-token-at-least-32-chars',
    VOICE_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  };

  it('defaults to GPT-Live with the separate configured backend', () => {
    expect(loadVoiceConfig(environment)).toMatchObject({
      enabled: true,
      model: 'gpt-live-1',
      backendModel: 'gpt-6-luna',
      actionsEnabled: false,
      transfersEnabled: false,
    });
  });

  it.each(['gpt-live-1', 'gpt-realtime', 'gpt-realtime-mini'])(
    'accepts the explicit supported voice model %s',
    (model) => {
      expect(loadVoiceConfig({ ...environment, OPENAI_REALTIME_MODEL: model })).toMatchObject({
        enabled: true,
        model,
        backendModel: 'gpt-6-luna',
      });
    },
  );

  it.each([
    { OPENAI_REALTIME_MODEL: 'caller-selected-model' },
    { OPENAI_VOICE_BACKEND_MODEL: 'caller-selected-backend' },
  ])('rejects unsupported models without including their values: %j', (overrides) => {
    const load = () => loadVoiceConfig({ ...environment, ...overrides });
    expect(load).toThrow('Invalid voice configuration fields:');
    expect(load).not.toThrow(/caller-selected/);
  });
});
