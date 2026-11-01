import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/**
 * 假上游：所有协议与网关测试的地基。
 *
 * 没有它，测试就只能依赖真实 API Key —— 那等于没有测试。
 * 它必须能复现真实上游的坏行为：分片、断流、慢响应、非法 JSON、限流。
 */

export interface FakeStep {
  status?: number;
  headers?: Record<string, string>;
  /** 非流式响应体。 */
  json?: unknown;
  /** 流式响应：按顺序写出的原始块，用来精确控制分片边界。 */
  sse?: string[];
  /** 收到请求后、开始响应前的延迟。 */
  delayMs?: number;
  /** 每个 SSE 块之间的延迟。 */
  chunkDelayMs?: number;
  /** 写完 N 个块后直接掐断连接。 */
  dropAfterChunks?: number;
  /** 永不响应，用于测超时。 */
  hang?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeUpstream {
  url: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export interface FakeUpstreamOptions {
  /** 依次消费；用完后重复最后一步。 */
  script?: FakeStep[];
  /**
   * 按请求内容选响应，优先于 `script`。
   * 并发请求（比如同时跑多个探测）必须用它，否则脚本顺序会错位。
   */
  route?: (request: RecordedRequest) => FakeStep | undefined;
  /** 期望的 Bearer token；不匹配则返回 401。 */
  requireToken?: string;
}

const DEFAULT_STEP: FakeStep = {
  json: {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'fake-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hello from fake upstream' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
  },
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeUpstream(options: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
  const script = options.script && options.script.length > 0 ? options.script : [DEFAULT_STEP];
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let cursor = 0;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push({
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });

    if (options.requireToken !== undefined) {
      if (req.headers.authorization !== `Bearer ${options.requireToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error' } }),
        );
        return;
      }
    }

    const step =
      options.route?.(requests[requests.length - 1] as RecordedRequest) ??
      script[Math.min(cursor, script.length - 1)] ??
      DEFAULT_STEP;
    cursor += 1;

    if (step.delayMs) await delay(step.delayMs);

    if (step.hang) {
      // 保持连接不响应，由测试侧的超时负责结束。
      return;
    }

    if (step.sse) {
      res.writeHead(step.status ?? 200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...step.headers,
      });
      for (const [index, chunk] of step.sse.entries()) {
        if (step.dropAfterChunks !== undefined && index >= step.dropAfterChunks) {
          res.socket?.destroy();
          return;
        }
        res.write(chunk);
        if (step.chunkDelayMs) await delay(step.chunkDelayMs);
      }
      res.end();
      return;
    }

    const payload = JSON.stringify(step.json ?? {});
    res.writeHead(step.status ?? 200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...step.headers,
    });
    res.end(payload);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake upstream failed to bind');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** 生成一段 OpenAI 风格的流式响应块，便于测试精确控制分片。 */
export function chatSseChunks(parts: {
  id?: string;
  model?: string;
  textPieces?: string[];
  toolCalls?: Array<{ index: number; id: string; name: string; argsPieces: string[] }>;
  finishReason?: string;
  includeDone?: boolean;
}): string[] {
  const id = parts.id ?? 'chatcmpl-fake';
  const model = parts.model ?? 'fake-model';
  const envelope = (choices: unknown[]): string =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1_700_000_000, model, choices })}\n\n`;

  const chunks: string[] = [
    envelope([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
  ];

  for (const piece of parts.textPieces ?? []) {
    chunks.push(envelope([{ index: 0, delta: { content: piece }, finish_reason: null }]));
  }

  for (const call of parts.toolCalls ?? []) {
    chunks.push(
      envelope([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: call.index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ]),
    );
    for (const piece of call.argsPieces) {
      chunks.push(
        envelope([
          {
            index: 0,
            delta: { tool_calls: [{ index: call.index, function: { arguments: piece } }] },
            finish_reason: null,
          },
        ]),
      );
    }
  }

  chunks.push(envelope([{ index: 0, delta: {}, finish_reason: parts.finishReason ?? 'stop' }]));
  if (parts.includeDone !== false) chunks.push('data: [DONE]\n\n');
  return chunks;
}
