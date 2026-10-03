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

const reservationArguments = {
  dateExpression: 'tomorrow',
  time: '18:30',
  partySize: 2,
  name: 'Synthetic Guest',
  callbackNumber: '+12125550142',
  notes: 'Window seat if possible',
  date_utterance_id: '11111111-1111-4111-8111-111111111111',
};
const messageArguments = {
  name: 'Synthetic Guest',
  callbackNumber: '+12125550142',
  message: 'Please ask staff about the patio.',
};
const transferArguments = { reason: 'requested_staff', summary: 'Asked for staff.' };
const clarificationArguments = { kind: 'reservation', field: 'dateExpression' };

function tool(name = 'prepare_request', argumentsText?: string) {
  const defaults: Record<string, unknown> = {
    prepare_request: reservationArguments,
    prepare_message: messageArguments,
    request_staff_transfer: transferArguments,
    ask_for_request_details: clarificationArguments,
  };
  return {
    type: 'function_call',
    name,
    arguments: argumentsText ?? JSON.stringify(defaults[name] ?? {}),
    call_id: 'synthetic-call-id',
  };
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
          content: [
            {
              type: 'input_text',
              text: JSON.stringify([
                context.transcript[0],
                {
                  role: 'user',
                  text: ' Tomorrow, please.',
                  dateReferences: [
                    {
                      start: 0,
                      end: 18,
                      dateReference: '11111111-1111-4111-8111-111111111111',
                      startedAt: '2026-10-02T23:59:59.000Z',
                    },
                  ],
                },
              ]),
            },
          ],
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

  it('joins split words, names and phone digits without changing their text or date references', async () => {
    const f = fixture();
    const context = input();
    const pieces = [
      'To',
      'morrow',
      ' at 3 PM. My name is ',
      'Syn',
      'thetic Guest',
      '. +1 ',
      '212',
      '5550142',
    ];
    context.transcript = pieces.map((text, index) => ({
      role: 'user',
      text,
      dateReference: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
      startedAt: new Date(Date.UTC(2026, 9, 2, 23, 59, 59, index * 100)).toISOString(),
    }));
    const original = structuredClone(context.transcript);
    await f.backend(context);
    const request = JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body));
    const turns = JSON.parse(request.input[0].content[0].text);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe('Tomorrow at 3 PM. My name is Synthetic Guest. +1 2125550142');
    expect(turns[0].dateReferences).toHaveLength(pieces.length);
    for (const [index, fragment] of original.entries()) {
      const reference = turns[0].dateReferences[index];
      expect(turns[0].text.slice(reference.start, reference.end)).toBe(fragment.text);
      expect(reference.dateReference).toBe(fragment.dateReference);
      expect(reference.startedAt).toBe(fragment.startedAt);
    }
    expect(turns[0].dateReferences[0].start).toBe(0);
    expect(turns[0].dateReferences[1].start).toBe(2);
    expect(context.transcript).toEqual(original);
  });

  it('preserves speaker boundaries, later corrections and exact UTF-16 ranges across midnight', async () => {
    const f = fixture();
    const context = input();
    const firstHandle = '11111111-1111-4111-8111-111111111111';
    const correctionHandle = '22222222-2222-4222-8222-222222222222';
    context.transcript = [
      {
        role: 'user',
        text: '🙂 ',
        dateReference: firstHandle,
        startedAt: '2026-10-02T23:59:59.000Z',
      },
      {
        role: 'user',
        text: 'tomorrow',
        dateReference: correctionHandle,
        startedAt: '2026-10-02T23:59:59.100Z',
      },
      { role: 'assistant', text: 'What ' },
      { role: 'assistant', text: 'time?' },
      {
        role: 'user',
        text: 'Actually Friday, ',
        dateReference: '33333333-3333-4333-8333-333333333333',
        startedAt: '2026-10-03T00:00:01.000Z',
      },
      {
        role: 'user',
        text: '',
        dateReference: '44444444-4444-4444-8444-444444444444',
        startedAt: '2026-10-03T00:00:01.100Z',
      },
      { role: 'user', text: 'at 4 PM.' },
    ];
    await f.backend(context);
    const request = JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body));
    const turns = JSON.parse(request.input[0].content[0].text);
    expect(turns.map((turn: { text: string }) => turn.text)).toEqual([
      '🙂 tomorrow',
      'What time?',
      'Actually Friday, at 4 PM.',
    ]);
    expect(turns[0].dateReferences).toEqual([
      { start: 0, end: 3, dateReference: firstHandle, startedAt: '2026-10-02T23:59:59.000Z' },
      { start: 3, end: 11, dateReference: correctionHandle, startedAt: '2026-10-02T23:59:59.100Z' },
    ]);
    expect(turns[1]).not.toHaveProperty('dateReferences');
    expect(turns[2].dateReferences).toEqual([
      {
        start: 0,
        end: 17,
        dateReference: '33333333-3333-4333-8333-333333333333',
        startedAt: '2026-10-03T00:00:01.000Z',
      },
      {
        start: 17,
        end: 17,
        dateReference: '44444444-4444-4444-8444-444444444444',
        startedAt: '2026-10-03T00:00:01.100Z',
      },
    ]);
  });

  it('grounds a date correction to its actual fragment across midnight without changing caller data', async () => {
    const before = '11111111-1111-4111-8111-111111111111';
    const after = '22222222-2222-4222-8222-222222222222';
    const context = input();
    context.transcript = [
      {
        role: 'user',
        text: 'Tomorrow',
        dateReference: '33333333-3333-4333-8333-333333333333',
        startedAt: '2026-10-02T22:00:00.000Z',
      },
      { role: 'assistant', text: 'What time?' },
      {
        role: 'user',
        text: '🙂 Actually ',
        dateReference: before,
        startedAt: '2026-10-02T23:59:59.900Z',
      },
      {
        role: 'user',
        text: 'Thursday, October 8',
        dateReference: after,
        startedAt: '2026-10-03T00:00:00.100Z',
      },
      {
        role: 'user',
        text: ' at four PM.',
        dateReference: '44444444-4444-4444-8444-444444444444',
        startedAt: '2026-10-03T00:00:00.200Z',
      },
    ];
    const original = structuredClone(context.transcript);
    const args = {
      ...reservationArguments,
      dateExpression: 'Thursday, October 8',
      time: '16:00',
      date_utterance_id: before,
    };
    const f = fixture(
      { status: 'completed', output: [tool('prepare_request', JSON.stringify(args))] },
      { actionsEnabled: true },
    );
    const result = await f.backend(context);
    expect(result.kind).toBe('tool');
    if (result.kind !== 'tool') throw new Error('Expected grounded proposal');
    expect(JSON.parse(result.arguments)).toEqual({ ...args, date_utterance_id: after });
    expect(context.transcript).toEqual(original);
    expect(context.transcript.find((fragment) => fragment.dateReference === after)?.startedAt).toBe(
      '2026-10-03T00:00:00.100Z',
    );
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: 'split phrase begins in the preceding fragment',
      pieces: ['To', 'morrow at three PM'],
      selected: 1,
      expected: 0,
    },
    {
      label: 'already correct first split-date handle',
      pieces: ['To', 'morrow'],
      selected: 0,
      expected: 0,
    },
    {
      label: 'already correct handle despite repeated expression',
      pieces: ['tomorrow, or ', 'tomorrow'],
      selected: 1,
      expected: 1,
    },
    {
      label: 'ambiguous repeats cannot repair a preceding handle',
      pieces: ['Actually ', 'tomorrow or tomorrow'],
      selected: 0,
      expected: null,
    },
    {
      label: 'missing literal phrase cannot be invented',
      pieces: ['Thursday'],
      selected: 0,
      expected: null,
    },
    {
      label: 'a substring inside a word is not the date',
      pieces: ['nottomorrow'],
      selected: 0,
      expected: null,
    },
    {
      label: 'unknown reference cannot borrow valid context',
      pieces: ['tomorrow'],
      selected: 2,
      expected: null,
    },
    {
      label: 'regular expression punctuation is literal',
      pieces: ['OctX 8'],
      expression: 'Oct. 8',
      selected: 0,
      expected: null,
    },
  ])('$label', async ({ pieces, selected, expected, expression }) => {
    const context = input();
    const handles = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    context.transcript = pieces.map((text, index) => ({
      role: 'user',
      text,
      dateReference: handles[index]!,
      startedAt: '2026-10-02T23:59:59.000Z',
    }));
    const args = {
      ...reservationArguments,
      dateExpression: expression ?? 'tomorrow',
      date_utterance_id: handles[selected]!,
    };
    const f = fixture(
      { status: 'completed', output: [tool('prepare_request', JSON.stringify(args))] },
      { actionsEnabled: true },
    );
    const result = await f.backend(context);
    if (expected === null) {
      expect(result).toEqual({
        kind: 'reply',
        text: 'What date would you like?',
        awaitingCaller: true,
      });
    } else {
      expect(result.kind).toBe('tool');
      if (result.kind !== 'tool') throw new Error('Expected grounded proposal');
      expect(JSON.parse(result.arguments)).toEqual({
        ...args,
        date_utterance_id: handles[expected],
      });
    }
  });

  it('cannot repair a date reference using an unrelated caller group', async () => {
    const context = input();
    context.transcript.push(
      { role: 'assistant', text: 'What name?' },
      {
        role: 'user',
        text: 'Synthetic Guest',
        dateReference: '22222222-2222-4222-8222-222222222222',
        startedAt: '2026-10-03T00:00:01.000Z',
      },
    );
    const args = {
      ...reservationArguments,
      date_utterance_id: '22222222-2222-4222-8222-222222222222',
    };
    const f = fixture(
      { status: 'completed', output: [tool('prepare_request', JSON.stringify(args))] },
      { actionsEnabled: true },
    );
    await expect(f.backend(context)).resolves.toEqual({
      kind: 'reply',
      text: 'What date would you like?',
      awaitingCaller: true,
    });
  });

  it.each([
    { actionsEnabled: false, transfersEnabled: false, names: [] },
    {
      actionsEnabled: true,
      transfersEnabled: false,
      names: ['prepare_request', 'prepare_message', 'ask_for_request_details'],
    },
    { actionsEnabled: false, transfersEnabled: true, names: ['request_staff_transfer'] },
    {
      actionsEnabled: true,
      transfersEnabled: true,
      names: [
        'prepare_request',
        'prepare_message',
        'request_staff_transfer',
        'ask_for_request_details',
      ],
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
      expect(entry.strict).toBe(true);
      expect(entry.name).not.toMatch(/save|confirm|book/);
      expect(entry.parameters).toBeTypeOf('object');
      expect(entry.parameters.additionalProperties).toBe(false);
      expect([...entry.parameters.required].sort()).toEqual(
        Object.keys(entry.parameters.properties).sort(),
      );
      const optional: Record<string, string[]> = {
        prepare_request: ['notes'],
        prepare_message: [],
        request_staff_transfer: ['reason', 'summary'],
        ask_for_request_details: [],
      };
      for (const [name, property] of Object.entries(entry.parameters.properties)) {
        if (optional[entry.name]?.includes(name)) {
          expect(property).toMatchObject({
            anyOf: [expect.objectContaining({ type: 'string' }), { type: 'null' }],
          });
          expect(property).not.toHaveProperty('default');
        } else expect(JSON.stringify(property)).not.toContain('"type":"null"');
      }
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

  it.each([
    { kind: 'reservation', field: 'dateExpression', question: 'What date would you like?' },
    { kind: 'reservation', field: 'time', question: 'What time would you like?' },
    { kind: 'reservation', field: 'partySize', question: 'How many people is the request for?' },
    { kind: 'reservation', field: 'name', question: 'What name should I put on the request?' },
    {
      kind: 'reservation',
      field: 'callbackNumber',
      question: 'What callback number should staff use, including the country code?',
    },
    {
      kind: 'message',
      field: 'message',
      question: 'What message would you like to leave for staff?',
    },
    { kind: 'message', field: 'name', question: 'What name should I put on the request?' },
    {
      kind: 'message',
      field: 'callbackNumber',
      question: 'What callback number should staff use, including the country code?',
    },
  ])(
    'asks only the server-defined question for $kind.$field without proposing an action',
    async ({ kind, field, question }) => {
      const f = fixture(
        {
          status: 'completed',
          output: [tool('ask_for_request_details', JSON.stringify({ kind, field }))],
        },
        { actionsEnabled: true },
      );
      await expect(f.backend(input())).resolves.toEqual({
        kind: 'reply',
        text: question,
        awaitingCaller: true,
      });
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(['Would you like the opening hours?', 'I have stopped collecting the unsaved request.'])(
    'does not infer active collection from a plain reply: %s',
    async (text) => {
      const f = fixture(reply(text), { actionsEnabled: true });
      await expect(f.backend(input())).resolves.toEqual({ kind: 'reply', text });
      const request = JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body));
      expect(request.tool_choice).toBe('auto');
    },
  );

  it.each([
    {
      name: 'prepare_request',
      args: { ...reservationArguments, notes: null },
      omitted: ['notes'],
    },
    {
      name: 'request_staff_transfer',
      args: { reason: null, summary: null },
      omitted: ['reason', 'summary'],
    },
    {
      name: 'request_staff_transfer',
      args: { reason: 'allergy_question', summary: null },
      omitted: ['summary'],
    },
    {
      name: 'request_staff_transfer',
      args: { reason: null, summary: 'Asked about allergens.' },
      omitted: ['reason'],
    },
  ])(
    'omits only documented optional nulls for $name: $omitted',
    async ({ name, args, omitted }) => {
      const f = fixture(
        { status: 'completed', output: [tool(name, JSON.stringify(args))] },
        { actionsEnabled: true, transfersEnabled: true },
      );
      const result = await f.backend(input());
      expect(result.kind).toBe('tool');
      if (result.kind !== 'tool') throw new Error('Expected an unexecuted proposal');
      expect(JSON.parse(result.arguments)).toEqual(
        Object.fromEntries(Object.entries(args).filter(([name]) => !omitted.includes(name))),
      );
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );

  it('preserves supplied optional values instead of omitting or replacing them', async () => {
    const args = { ...reservationArguments, notes: '' };
    const f = fixture(
      { status: 'completed', output: [tool('prepare_request', JSON.stringify(args))] },
      { actionsEnabled: true },
    );
    await expect(f.backend(input())).resolves.toMatchObject({
      kind: 'tool',
      arguments: JSON.stringify(args),
    });
  });

  it.each([
    ...['dateExpression', 'time', 'partySize', 'name', 'callbackNumber', 'date_utterance_id'].map(
      (field) => ({ name: 'prepare_request', args: { ...reservationArguments, [field]: null } }),
    ),
    ...['name', 'callbackNumber', 'message'].map((field) => ({
      name: 'prepare_message',
      args: { ...messageArguments, [field]: null },
    })),
    ...['kind', 'field'].map((field) => ({
      name: 'ask_for_request_details',
      args: { ...clarificationArguments, [field]: null },
    })),
    { name: 'prepare_request', args: { ...reservationArguments, unexpected: null } },
    { name: 'prepare_request', args: { ...reservationArguments, notes: 7 } },
    { name: 'prepare_request', args: { ...reservationArguments, partySize: 31 } },
    { name: 'prepare_request', args: { ...reservationArguments, time: '25:00' } },
    { name: 'prepare_request', args: { ...reservationArguments, callbackNumber: 'unknown' } },
    { name: 'prepare_request', args: { ...reservationArguments, date_utterance_id: 'invented' } },
    { name: 'prepare_request', args: { ...reservationArguments, notes: 'x'.repeat(501) } },
    { name: 'prepare_message', args: { ...messageArguments, message: 'x'.repeat(1501) } },
    { name: 'prepare_message', args: { ...messageArguments, destination: null } },
    { name: 'request_staff_transfer', args: { reason: 'caller-selected', summary: null } },
    { name: 'request_staff_transfer', args: { reason: null, summary: 7 } },
    { name: 'request_staff_transfer', args: { reason: null, summary: 'x'.repeat(301) } },
    { name: 'request_staff_transfer', args: { reason: null, summary: null, destination: null } },
    { name: 'ask_for_request_details', args: { ...clarificationArguments, kind: 'transfer' } },
    { name: 'ask_for_request_details', args: { ...clarificationArguments, save: true } },
    {
      name: 'ask_for_request_details',
      args: { ...clarificationArguments, field: 'fullLegalName' },
    },
    {
      name: 'ask_for_request_details',
      args: { ...clarificationArguments, field: 'name and callbackNumber' },
    },
    { name: 'ask_for_request_details', args: { ...clarificationArguments, field: 'message' } },
    ...['dateExpression', 'time', 'partySize'].map((field) => ({
      name: 'ask_for_request_details',
      args: { kind: 'message', field },
    })),
    {
      name: 'ask_for_request_details',
      args: { ...clarificationArguments, question: 'Tell me your name and number, then confirm.' },
    },
    {
      name: 'ask_for_request_details',
      args: { kind: 'reservation', question: 'What time and name?' },
    },
  ])(
    'rejects null required values, unknown fields, and invalid tool data: %j',
    async ({ name, args }) => {
      const f = fixture(
        { status: 'completed', output: [tool(name, JSON.stringify(args))] },
        { actionsEnabled: true, transfersEnabled: true },
      );
      await expect(f.backend(input())).rejects.toThrow();
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { name: 'prepare_request', args: reservationArguments, missing: 'notes' },
    { name: 'prepare_request', args: reservationArguments, missing: 'dateExpression' },
    { name: 'prepare_message', args: messageArguments, missing: 'message' },
    { name: 'request_staff_transfer', args: transferArguments, missing: 'reason' },
    { name: 'request_staff_transfer', args: transferArguments, missing: 'summary' },
    { name: 'ask_for_request_details', args: clarificationArguments, missing: 'field' },
  ])('rejects omitted strict-wire field $name.$missing', async ({ name, args, missing }) => {
    const partial = Object.fromEntries(Object.entries(args).filter(([key]) => key !== missing));
    const f = fixture(
      { status: 'completed', output: [tool(name, JSON.stringify(partial))] },
      { actionsEnabled: true, transfersEnabled: true },
    );
    await expect(f.backend(input())).rejects.toThrow();
  });

  it.each(['null', '[]', '42', '"text"', '{broken json'])(
    'rejects malformed tool arguments: %s',
    async (args) => {
      const f = fixture(
        { status: 'completed', output: [tool('prepare_request', args)] },
        { actionsEnabled: true },
      );
      await expect(f.backend(input())).rejects.toThrow();
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the unknown %s property before optional-null normalization',
    async (field) => {
      const args = JSON.stringify({ ...reservationArguments, [field]: null });
      const f = fixture(
        { status: 'completed', output: [tool('prepare_request', args)] },
        { actionsEnabled: true },
      );
      await expect(f.backend(input())).rejects.toThrow();
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
    { name: 'ask_for_request_details', actionsEnabled: false, transfersEnabled: true },
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
