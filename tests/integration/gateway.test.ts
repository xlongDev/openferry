import { afterEach, describe, expect, it } from 'vitest';
import { defaultCapabilities } from '@openferry/canonical';
import { chatSseChunks } from '@openferry/testkit';
import {
  authHeaders,
  basicChatBody,
  parseSseData,
  postChat,
  readAllText,
  setupGateway,
  TOKEN,
  type Harness,
} from '../helpers.js';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('gateway endpoints', () => {
  it('serves /healthz without authentication', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0');
  });

  it('serves /readyz with provider list', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: string[] };
    expect(body.providers).toEqual(['fake']);
  });

  it('rejects /v1/models without a token', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/v1/models`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('lists models from the upstream catalogue', async () => {
    harness = await setupGateway({
      script: [{ json: { object: 'list', data: [{ id: 'alpha', owned_by: 'acme', created: 1 }] } }],
    });
    const res = await fetch(`${harness.url}/v1/models`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; provider: string }> };
    expect(body.data[0]?.id).toBe('fake/alpha');
    expect(body.data[0]?.provider).toBe('fake');
  });

  it('returns 404 for unknown routes', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/nope`, { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it('returns 405 for the wrong method', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(405);
  });
});

describe('chat completions', () => {
  it('proxies a non-streaming request and forwards the api key', async () => {
    harness = await setupGateway();
    const res = await postChat(harness.url, basicChatBody());

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.choices[0].message.content).toBe('hello from fake upstream');
    expect(body.usage.total_tokens).toBe(11);

    const upstreamRequest = harness.upstream?.requests[0];
    expect(upstreamRequest?.path).toBe('/v1/chat/completions');
    expect(upstreamRequest?.headers['authorization']).toBe('Bearer sk-test');
  });

  it('rejects a malformed body with 400', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('invalid_request');
  });

  it('rejects n>1 rather than returning a single choice', async () => {
    harness = await setupGateway();
    const res = await postChat(harness.url, basicChatBody({ n: 3 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain('n');
  });

  it('maps upstream 429 to rate_limited', async () => {
    harness = await setupGateway({
      script: [{ status: 429, json: { error: { message: 'slow down' } } }],
    });
    const res = await postChat(harness.url, basicChatBody());
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('rate_limited');
  });

  it('maps upstream 401 without leaking the upstream body verbatim', async () => {
    harness = await setupGateway({
      script: [{ status: 401, json: { error: { message: 'invalid key sk-leaked-key' } } }],
    });
    const res = await postChat(harness.url, basicChatBody());
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain('sk-leaked-key');
  });

  it('times out when the upstream never responds', async () => {
    harness = await setupGateway({
      script: [{ hang: true }],
      timeouts: { connectMs: 100, totalMs: 400, firstEventMs: 200 },
    });
    const res = await postChat(harness.url, basicChatBody());
    expect(res.status).toBe(504);
  });
});

describe('streaming', () => {
  it('streams text deltas and terminates with [DONE]', async () => {
    harness = await setupGateway({
      script: [{ sse: chatSseChunks({ textPieces: ['Hel', 'lo'] }) }],
    });

    const res = await postChat(harness.url, basicChatBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await readAllText(res);
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain('"content":"lo"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('reassembles a tool call whose arguments are split across events', async () => {
    harness = await setupGateway({
      script: [
        {
          sse: chatSseChunks({
            toolCalls: [
              {
                index: 0,
                id: 'call_1',
                name: 'read_file',
                argsPieces: ['{"pa', 'th":"a', '.txt"}'],
              },
            ],
            finishReason: 'tool_calls',
          }),
        },
      ],
    });

    const res = await postChat(harness.url, basicChatBody({ stream: true }));
    const text = await readAllText(res);

    const chunks = parseSseData(text);
    const argumentFragments = chunks.flatMap((chunk) =>
      (chunk.choices?.[0]?.delta?.tool_calls ?? []).map(
        (call: any) => call.function?.arguments ?? '',
      ),
    );
    expect(argumentFragments.join('')).toBe('{"path":"a.txt"}');

    const finish = chunks.at(-1)?.choices?.[0]?.finish_reason;
    expect(finish).toBe('tool_calls');
  });

  it('surfaces an upstream stream that ends without a completion signal', async () => {
    harness = await setupGateway({
      script: [
        {
          sse: chatSseChunks({ textPieces: ['partial'], includeDone: false }).slice(0, 2),
        },
      ],
    });

    const res = await postChat(harness.url, basicChatBody({ stream: true }));
    const text = await readAllText(res);
    expect(text).toContain('partial');
    expect(text).toContain('upstream stream ended without a completion signal');
  });

  it('turns invalid JSON in the SSE payload into an error event, not a crash', async () => {
    harness = await setupGateway({
      script: [{ sse: ['data: {broken\n\n', 'data: [DONE]\n\n'] }],
    });

    const res = await postChat(harness.url, basicChatBody({ stream: true }));
    const text = await readAllText(res);
    expect(text).toContain('invalid JSON');
  });
});

describe('provider hot swap', () => {
  it('replaces the provider list without restarting the gateway', async () => {
    harness = await setupGateway();
    expect(harness.gateway.stats().providers).toEqual(['fake']);

    const replacement = {
      id: 'second',
      capabilities: defaultCapabilities,
      listModels: async () => [],
      send: async () => ({
        id: 'x',
        model: 'm',
        createdAt: 0,
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'from second' }],
        },
        finishReason: 'stop' as const,
        warnings: [],
      }),
      async *stream() {
        yield { type: 'done' as const, finishReason: 'stop' as const };
      },
    };

    harness.gateway.setProviders([replacement]);
    expect(harness.gateway.stats().providers).toEqual(['second']);

    const res = await postChat(harness.url, {
      model: 'second/m',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.choices[0].message.content).toBe('from second');
  });

  it('rejects a duplicate provider id instead of silently keeping one', async () => {
    harness = await setupGateway();
    const provider = {
      id: 'dup',
      capabilities: defaultCapabilities,
      listModels: async () => [],
      send: async () => {
        throw new Error('unused');
      },
      async *stream() {
        yield { type: 'done' as const, finishReason: 'stop' as const };
      },
    };
    expect(() => harness!.gateway.setProviders([provider, { ...provider }])).toThrow(/duplicate/);
  });
});

describe('resource limits', () => {
  it('rejects bodies above the configured limit with 413', async () => {
    harness = await setupGateway({ maxBodyBytes: 64 });
    const res = await postChat(harness.url, basicChatBody({ pad: 'x'.repeat(500) }));
    expect(res.status).toBe(413);
  });

  it('rejects concurrent requests above the limit with 429', async () => {
    const { createGateway } = await import('@openferry/gateway');
    const { defaultCapabilities } = await import('@openferry/canonical');

    const provider = {
      id: 'slow',
      capabilities: defaultCapabilities,
      listModels: async () => [],
      send: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          id: 'x',
          model: 'm',
          createdAt: 0,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] },
          finishReason: 'stop' as const,
          warnings: [],
        };
      },
      async *stream() {
        yield { type: 'done' as const, finishReason: 'stop' as const };
      },
    };

    const gateway = createGateway({
      providers: [provider],
      token: TOKEN,
      port: 0,
      maxConcurrency: 1,
    });
    const { url } = await gateway.start();

    try {
      const first = postChat(url, basicChatBody());
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await postChat(url, basicChatBody());
      expect(second.status).toBe(429);
      await first;
    } finally {
      await gateway.stop();
    }
  });
});
