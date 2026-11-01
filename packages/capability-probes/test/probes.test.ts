import { afterEach, describe, expect, it } from 'vitest';
import {
  expiresAt,
  probeChat,
  probeStream,
  probeTools,
  runAllProbes,
} from '@openferry/capability-probes';
import { OpenAICompatibleProvider } from '@openferry/provider-openai-compatible';
import {
  chatSseChunks,
  startFakeUpstream,
  type FakeStep,
  type FakeUpstream,
} from '@openferry/testkit';

let upstream: FakeUpstream | null = null;

afterEach(async () => {
  await upstream?.close();
  upstream = null;
});

async function providerFor(script: FakeStep[]) {
  upstream = await startFakeUpstream({ script });
  return new OpenAICompatibleProvider({
    id: 'fake',
    baseUrl: upstream.url,
    apiKey: 'sk-test',
    allowPrivateNetwork: true,
  });
}

function completion(content: string | null): Record<string, unknown> {
  return {
    id: 'chatcmpl-probe',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

function toolCompletion(argumentsJson: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-probe',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_time', arguments: argumentsJson },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

describe('probeChat', () => {
  it('passes when the model returns text', async () => {
    const provider = await providerFor([{ json: completion('ok') }]);
    const outcome = await probeChat(provider, 'fake/m');
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence).toContain('ok');
  });

  it('fails on an empty completion', async () => {
    const provider = await providerFor([{ json: completion('') }]);
    const outcome = await probeChat(provider, 'fake/m');
    expect(outcome.status).toBe('fail');
    expect(outcome.errorCode).toBe('empty_response');
  });

  it('reports the upstream error code instead of throwing', async () => {
    const provider = await providerFor([{ status: 401, json: { error: { message: 'bad key' } } }]);
    const outcome = await probeChat(provider, 'fake/m');
    expect(outcome.status).toBe('fail');
    expect(outcome.errorCode).toBe('unauthorized');
  });
});

describe('probeStream', () => {
  it('passes when deltas arrive and the stream completes', async () => {
    const provider = await providerFor([{ sse: chatSseChunks({ textPieces: ['o', 'k'] }) }]);
    const outcome = await probeStream(provider, 'fake/m');
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence).toMatch(/增量/);
  });

  it('fails when the stream ends without a completion signal', async () => {
    const provider = await providerFor([
      { sse: chatSseChunks({ textPieces: ['o'], includeDone: false }).slice(0, 2) },
    ]);
    const outcome = await probeStream(provider, 'fake/m');
    expect(outcome.status).toBe('fail');
    // 适配器已经把「断流」分类成 upstream_error，证据里带具体原因。
    expect(outcome.errorCode).toBe('upstream_error');
    expect(outcome.evidence).toMatch(/completion signal/);
  });
});

describe('probeTools', () => {
  it('passes both tool_call and tool_args on a well formed call', async () => {
    const provider = await providerFor([{ json: toolCompletion('{"timezone":"Asia/Shanghai"}') }]);
    const outcomes = await probeTools(provider, 'fake/m');
    expect(outcomes.map((o) => o.status)).toEqual(['pass', 'pass']);
    expect(outcomes[1]?.evidence).toContain('Asia/Shanghai');
  });

  it('keeps tool_call passing while tool_args fails on broken JSON', async () => {
    const provider = await providerFor([{ json: toolCompletion('{"timezone":') }]);
    const [call, args] = await probeTools(provider, 'fake/m');
    expect(call?.status).toBe('pass');
    expect(args?.status).toBe('fail');
    expect(args?.errorCode).toBe('invalid_json');
  });

  it('fails both when the model only replies with text', async () => {
    const provider = await providerFor([{ json: completion('I cannot use tools') }]);
    const outcomes = await probeTools(provider, 'fake/m');
    expect(outcomes.every((o) => o.status === 'fail')).toBe(true);
    expect(outcomes[0]?.errorCode).toBe('no_tool_call');
  });

  it('fails tool_args when a required field is missing', async () => {
    const provider = await providerFor([{ json: toolCompletion('{"zone":"UTC"}') }]);
    const [, args] = await probeTools(provider, 'fake/m');
    expect(args?.errorCode).toBe('missing_required_field');
  });
});

describe('runAllProbes', () => {
  it('returns one outcome per probe kind', async () => {
    // 三个探测是并发的，必须按请求内容路由，不能靠脚本顺序。
    upstream = await startFakeUpstream({
      route: (request) => {
        const body = JSON.parse(request.body.length > 0 ? request.body : '{}') as Record<
          string,
          unknown
        >;
        if (body['stream'] === true) return { sse: chatSseChunks({ textPieces: ['o', 'k'] }) };
        if (Array.isArray(body['tools']) && body['tools'].length > 0) {
          return { json: toolCompletion('{"timezone":"UTC"}') };
        }
        return { json: completion('ok') };
      },
    });
    const provider = new OpenAICompatibleProvider({
      id: 'fake',
      baseUrl: upstream.url,
      apiKey: 'sk-test',
      allowPrivateNetwork: true,
    });

    const outcomes = await runAllProbes(provider, 'fake/m');
    expect(outcomes.map((o) => o.probe)).toEqual(['chat', 'stream', 'tool_call', 'tool_args']);
    expect(outcomes.every((o) => o.status === 'pass')).toBe(true);
  });
});

describe('expiresAt', () => {
  const now = new Date('2026-11-02T00:00:00.000Z');
  const hours = (iso: string): number => (new Date(iso).getTime() - now.getTime()) / 3_600_000;

  it('gives a long ttl to passes', () => {
    expect(hours(expiresAt('pass', undefined, now))).toBe(6);
  });

  it('gives a short ttl to rate limits and timeouts', () => {
    expect(hours(expiresAt('fail', 'rate_limited', now))).toBeCloseTo(10 / 60, 5);
    expect(hours(expiresAt('fail', 'timeout', now))).toBeCloseTo(10 / 60, 5);
  });

  it('gives an hour to other failures', () => {
    expect(hours(expiresAt('fail', 'invalid_request', now))).toBe(1);
  });
});
