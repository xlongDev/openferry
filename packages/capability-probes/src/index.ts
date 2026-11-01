import { ProtocolError, toProtocolError } from '@openferry/core';
import type { CanonicalRequest, CanonicalTool } from '@openferry/canonical';
import type { ProviderAdapter } from '@openferry/provider-contract';

/**
 * 能力探测。
 *
 * 探测的是「这一次能不能按协议产生动作」，不是「这个模型的工作流稳不稳」。
 * 结果必须带时间与有效期 —— 上游的能力随时会变，一次成功不是永久结论。
 */

export const PROBE_VERSION = '1.0.0';

export type ProbeKind = 'chat' | 'stream' | 'tool_call' | 'tool_args';
export type ProbeStatus = 'pass' | 'fail' | 'unsupported';

export interface ProbeOutcome {
  probe: ProbeKind;
  status: ProbeStatus;
  durationMs: number;
  errorCode?: string;
  /** 给用户看的证据：首字延迟、返回内容片段、失败原因。 */
  evidence?: string;
}

export interface ProbeOptions {
  /** 单个探测的总超时。默认 30 秒。 */
  timeoutMs?: number;
  /** 外部取消（用户点了取消 / 窗口关闭）。 */
  signal?: AbortSignal;
  requestId?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const TIME_TOOL: CanonicalTool = {
  name: 'get_time',
  description: 'Return the current time for a given timezone.',
  parameters: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'IANA timezone name, e.g. Asia/Shanghai' },
    },
    required: ['timezone'],
    additionalProperties: false,
  },
};

function baseRequest(model: string): CanonicalRequest {
  return {
    model,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }] },
    ],
    stream: false,
    temperature: 0,
    maxOutputTokens: 16,
  };
}

function describeError(error: unknown): { errorCode: string; evidence: string } {
  const protocolError = toProtocolError(error);
  return {
    errorCode: protocolError.code,
    evidence: protocolError.message.slice(0, 200),
  };
}

function textOf(response: {
  message: { content: Array<{ type: string; text?: string }> };
}): string {
  return response.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}

async function withTimeout<T>(
  options: ProbeOptions,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('probe timeout')), timeoutMs);
  timer.unref();

  const onOuter = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onOuter();
  else options.signal?.addEventListener('abort', onOuter, { once: true });

  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuter);
  }
}

function context(options: ProbeOptions, signal: AbortSignal) {
  return {
    signal,
    requestId: options.requestId ?? 'probe',
    timeouts: {
      connectMs: 10_000,
      firstEventMs: 15_000,
      totalMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  };
}

export async function probeChat(
  adapter: ProviderAdapter,
  model: string,
  options: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const started = Date.now();
  try {
    const response = await withTimeout(options, (signal) =>
      adapter.send(baseRequest(model), context(options, signal)),
    );
    const text = textOf(response);
    if (text.length === 0) {
      return {
        probe: 'chat',
        status: 'fail',
        durationMs: Date.now() - started,
        errorCode: 'empty_response',
        evidence: '模型返回了空内容',
      };
    }
    return {
      probe: 'chat',
      status: 'pass',
      durationMs: Date.now() - started,
      evidence: text.slice(0, 60),
    };
  } catch (error) {
    const { errorCode, evidence } = describeError(error);
    return {
      probe: 'chat',
      status: errorCode === 'unsupported' ? 'unsupported' : 'fail',
      durationMs: Date.now() - started,
      errorCode,
      evidence,
    };
  }
}

export async function probeStream(
  adapter: ProviderAdapter,
  model: string,
  options: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const started = Date.now();
  try {
    let deltas = 0;
    let firstDeltaAt: number | null = null;
    let finished = false;

    await withTimeout(options, async (signal) => {
      for await (const event of adapter.stream(
        { ...baseRequest(model), stream: true },
        context(options, signal),
      )) {
        if (event.type === 'text_delta') {
          deltas += 1;
          firstDeltaAt ??= Date.now();
        }
        if (event.type === 'done') {
          finished = true;
          break;
        }
        if (event.type === 'error') {
          throw new ProtocolError('upstream_error', event.error.message, {
            details: { code: event.error.code },
          });
        }
        if (event.type === 'aborted') throw new ProtocolError('aborted', event.reason);
      }
    });

    if (deltas === 0 || !finished) {
      return {
        probe: 'stream',
        status: 'fail',
        durationMs: Date.now() - started,
        errorCode: deltas === 0 ? 'no_stream_delta' : 'incomplete_stream',
        evidence: deltas === 0 ? '没有收到任何文本增量' : '流在完成信号之前结束',
      };
    }

    const firstTokenMs = firstDeltaAt === null ? null : firstDeltaAt - started;
    return {
      probe: 'stream',
      status: 'pass',
      durationMs: Date.now() - started,
      evidence: `首字 ${firstTokenMs ?? '?'}ms，${deltas} 个增量`,
    };
  } catch (error) {
    const { errorCode, evidence } = describeError(error);
    return {
      probe: 'stream',
      status: errorCode === 'unsupported' ? 'unsupported' : 'fail',
      durationMs: Date.now() - started,
      errorCode,
      evidence,
    };
  }
}

/**
 * 工具调用与参数完整性共用一次请求：拆成两次只会多花一次额度，
 * 而「有没有产生动作」和「参数是不是完整 JSON」本来就是同一个响应的两个侧面。
 */
export async function probeTools(
  adapter: ProviderAdapter,
  model: string,
  options: ProbeOptions = {},
): Promise<ProbeOutcome[]> {
  const started = Date.now();
  try {
    const response = await withTimeout(options, (signal) =>
      adapter.send(
        {
          ...baseRequest(model),
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'What time is it in Asia/Shanghai? Use the tool.' }],
            },
          ],
          tools: [TIME_TOOL],
          toolChoice: { name: 'get_time' },
        },
        context(options, signal),
      ),
    );

    const call = response.message.content.find((block) => block.type === 'tool_call');
    if (!call || call.type !== 'tool_call') {
      const duration = Date.now() - started;
      const evidence = '模型只回了文本，没有产生工具调用';
      return [
        {
          probe: 'tool_call',
          status: 'fail',
          durationMs: duration,
          errorCode: 'no_tool_call',
          evidence,
        },
        {
          probe: 'tool_args',
          status: 'fail',
          durationMs: duration,
          errorCode: 'no_tool_call',
          evidence,
        },
      ];
    }

    const toolOutcome: ProbeOutcome = {
      probe: 'tool_call',
      status: 'pass',
      durationMs: Date.now() - started,
      evidence: `调用了 ${call.name}`,
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(call.argumentsJson);
    } catch {
      return [
        toolOutcome,
        {
          probe: 'tool_args',
          status: 'fail',
          durationMs: Date.now() - started,
          errorCode: 'invalid_json',
          evidence: `参数不是合法 JSON：${call.argumentsJson.slice(0, 80)}`,
        },
      ];
    }

    const timezone =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['timezone']
        : undefined;

    if (typeof timezone !== 'string' || timezone.length === 0) {
      return [
        toolOutcome,
        {
          probe: 'tool_args',
          status: 'fail',
          durationMs: Date.now() - started,
          errorCode: 'missing_required_field',
          evidence: `参数缺少 timezone：${call.argumentsJson.slice(0, 80)}`,
        },
      ];
    }

    return [
      toolOutcome,
      {
        probe: 'tool_args',
        status: 'pass',
        durationMs: Date.now() - started,
        evidence: `timezone=${timezone}`,
      },
    ];
  } catch (error) {
    const { errorCode, evidence } = describeError(error);
    const status: ProbeStatus = errorCode === 'unsupported' ? 'unsupported' : 'fail';
    const duration = Date.now() - started;
    return [
      { probe: 'tool_call', status, durationMs: duration, errorCode, evidence },
      { probe: 'tool_args', status, durationMs: duration, errorCode, evidence },
    ];
  }
}

export async function runAllProbes(
  adapter: ProviderAdapter,
  model: string,
  options: ProbeOptions = {},
): Promise<ProbeOutcome[]> {
  const [chat, stream, tools] = await Promise.all([
    probeChat(adapter, model, options),
    probeStream(adapter, model, options),
    probeTools(adapter, model, options),
  ]);
  return [chat, stream, ...tools];
}

/**
 * 结果有效期。
 *  - 成功：6 小时。上游换模型/改权限不会那么快，但也不能当永久结论。
 *  - 限流 / 超时：10 分钟。这是当时的负载，不代表能力。
 *  - 其他失败：1 小时。配置类问题通常要人工介入，但可能自己恢复。
 *  - 明确不支持：6 小时。协议层面的结论比负载稳定。
 */
export function expiresAt(
  status: ProbeStatus,
  errorCode: string | undefined,
  now: Date = new Date(),
): string {
  const minutes =
    status === 'pass' || status === 'unsupported'
      ? 360
      : errorCode === 'rate_limited' || errorCode === 'timeout'
        ? 10
        : 60;
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}
