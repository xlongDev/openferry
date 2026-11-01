import { describe, expect, it } from 'vitest';
import { ProtocolError } from '@openferry/core';
import {
  ChatChunkEncoder,
  createStreamDecoderState,
  decodeChatChunk,
  decodeChatRequest,
  decodeChatResponse,
  encodeChatResponse,
} from '@openferry/protocol-openai-chat';

describe('decodeChatRequest', () => {
  it('maps a minimal request', () => {
    const { request } = decodeChatRequest({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(request.model).toBe('gpt-4o-mini');
    expect(request.stream).toBe(false);
    expect(request.messages[0]?.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('maps system, assistant tool calls and tool results', () => {
    const { request } = decodeChatRequest({
      model: 'm',
      messages: [
        { role: 'system', content: 'be terse' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"p":"a"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
      ],
    });

    expect(request.messages[0]?.role).toBe('system');
    expect(request.messages[1]?.content).toEqual([
      { type: 'tool_call', id: 'call_1', name: 'read_file', argumentsJson: '{"p":"a"}' },
    ]);
    expect(request.messages[2]?.content).toEqual([
      { type: 'tool_result', toolCallId: 'call_1', content: 'contents' },
    ]);
  });

  it('maps tools and tool_choice', () => {
    const { request } = decodeChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
    });
    expect(request.tools?.[0]?.name).toBe('f');
    expect(request.toolChoice).toEqual({ name: 'f' });
  });

  it('maps base64 data urls into canonical image blocks', () => {
    const { request } = decodeChatRequest({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    });
    expect(request.messages[0]?.content[1]).toEqual({
      type: 'image',
      source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' },
    });
  });

  it('rejects n > 1 instead of silently returning one choice', () => {
    try {
      decodeChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], n: 3 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe('invalid_request');
      expect((error as ProtocolError).message).toContain('n');
    }
  });

  it('rejects logprobs', () => {
    expect(() =>
      decodeChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], logprobs: true }),
    ).toThrow(/logprobs/);
  });

  it('rejects a tool message without tool_call_id', () => {
    expect(() =>
      decodeChatRequest({
        model: 'm',
        messages: [{ role: 'tool', content: 'x' }],
      }),
    ).toThrow(/tool_call_id/);
  });
});

describe('decodeChatResponse / encodeChatResponse', () => {
  it('round-trips text and usage', () => {
    const canonical = decodeChatResponse(
      {
        id: 'chatcmpl-1',
        created: 10,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
      'm',
    );

    expect(canonical.finishReason).toBe('stop');
    expect(canonical.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });

    const wire = encodeChatResponse(canonical);
    expect(wire.choices[0]?.message.content).toBe('hi');
    expect(wire.usage?.['total_tokens']).toBe(5);
  });

  it('keeps missing usage as undefined rather than zero', () => {
    const canonical = decodeChatResponse(
      {
        id: 'x',
        model: 'm',
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      },
      'm',
    );
    expect(canonical.usage).toBeUndefined();
    expect(encodeChatResponse(canonical).usage).toBeUndefined();
  });

  it('maps tool_calls finish reason', () => {
    const canonical = decodeChatResponse(
      {
        id: 'x',
        model: 'm',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'm',
    );
    expect(canonical.finishReason).toBe('tool_calls');
    expect(canonical.message.content[0]).toEqual({
      type: 'tool_call',
      id: 'c1',
      name: 'f',
      argumentsJson: '{}',
    });
  });
});

describe('stream decoding', () => {
  it('emits start, text deltas and done', () => {
    const state = createStreamDecoderState();
    const events = [
      ...decodeChatChunk(
        {
          id: 'c1',
          model: 'm',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        },
        state,
      ),
      ...decodeChatChunk({ id: 'c1', model: 'm', choices: [{ delta: { content: 'Hel' } }] }, state),
      ...decodeChatChunk({ id: 'c1', model: 'm', choices: [{ delta: { content: 'lo' } }] }, state),
      ...decodeChatChunk(
        { id: 'c1', model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
        state,
      ),
    ];

    expect(events[0]).toEqual({ type: 'start', id: 'c1', model: 'm' });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as any).text)).toEqual([
      'Hel',
      'lo',
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('accumulates fragmented tool arguments on one block', () => {
    const state = createStreamDecoderState();
    const events = [
      ...decodeChatChunk(
        {
          id: 'c1',
          model: 'm',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'f', arguments: '' },
                  },
                ],
              },
            },
          ],
        },
        state,
      ),
      ...decodeChatChunk(
        {
          id: 'c1',
          model: 'm',
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] } }],
        },
        state,
      ),
      ...decodeChatChunk(
        {
          id: 'c1',
          model: 'm',
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }],
        },
        state,
      ),
      ...decodeChatChunk(
        { id: 'c1', model: 'm', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        state,
      ),
    ];

    const start = events.find((e) => e.type === 'content_block_start') as any;
    expect(start.toolCallId).toBe('call_a');
    expect(start.toolName).toBe('f');

    const fragments = events
      .filter((e) => e.type === 'tool_call_delta')
      .map((e) => (e as any).argumentsDelta);
    expect(fragments.join('')).toBe('{"a":1}');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('surfaces upstream error chunks as error events', () => {
    const state = createStreamDecoderState();
    const events = decodeChatChunk(
      { error: { message: 'quota exceeded', code: 'rate_limited' } },
      state,
    );
    expect(events).toEqual([
      { type: 'error', error: { code: 'rate_limited', message: 'quota exceeded' } },
    ]);
  });
});

describe('ChatChunkEncoder', () => {
  it('encodes text deltas and tool calls with separate index spaces', () => {
    const encoder = new ChatChunkEncoder({ id: 'c1', model: 'm', created: 1 });

    const start = encoder.encode({ type: 'start', id: 'c1', model: 'm' }) as any;
    expect(start.choices[0].delta.role).toBe('assistant');

    const text = encoder.encode({ type: 'text_delta', index: 0, text: 'hi' }) as any;
    expect(text.choices[0].delta.content).toBe('hi');

    encoder.encode({
      type: 'content_block_start',
      index: 1,
      blockType: 'tool_call',
      toolCallId: 'call_1',
      toolName: 'f',
    });
    const args = encoder.encode({ type: 'tool_call_delta', index: 1, argumentsDelta: '{}' }) as any;
    expect(args.choices[0].delta.tool_calls[0].index).toBe(0);

    const done = encoder.encode({ type: 'done', finishReason: 'tool_calls' }) as any;
    expect(done.choices[0].finish_reason).toBe('tool_calls');
  });

  it('does not fabricate a finish reason when unknown', () => {
    const encoder = new ChatChunkEncoder({ id: 'c1', model: 'm', created: 1 });
    const done = encoder.encode({ type: 'done', finishReason: 'unknown' }) as any;
    expect(done.choices[0].finish_reason).toBeNull();
  });
});
