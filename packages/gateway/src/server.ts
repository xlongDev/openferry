import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
  ProtocolError,
  createLogger,
  newRequestId,
  safeEqual,
  toProtocolError,
  type ErrorCode,
  type LoggerHandle,
} from '@openferry/core';
import type { CanonicalRequest } from '@openferry/canonical';
import {
  ChatChunkEncoder,
  decodeChatRequest,
  encodeChatResponse,
  formatSse,
} from '@openferry/protocol-openai-chat';
import {
  defaultTimeouts,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderTimeouts,
} from '@openferry/provider-contract';
import {
  assertAllowedHost,
  assertNotBrowserRequest,
  bearerToken,
  readBody,
  sendError,
  sendJson,
} from './http.js';

export const VERSION = '0.1.0';

export interface GatewayOptions {
  providers: ProviderAdapter[];
  /** 数据面 Token。为空字符串表示关闭认证（仅测试用，会在日志里告警）。 */
  token: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  maxConcurrency?: number;
  timeouts?: Partial<ProviderTimeouts>;
  logger?: LoggerHandle;
}

export interface GatewayStats {
  startedAt: string | null;
  url: string | null;
  port: number | null;
  requests: number;
  errors: number;
  inFlight: number;
  providers: string[];
}

export interface Gateway {
  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  stats(): GatewayStats;
  readonly logger: LoggerHandle;
}

const ERROR_CODES = new Set<string>([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'rate_limited',
  'timeout',
  'upstream_error',
  'upstream_unavailable',
  'aborted',
  'unsupported',
  'internal',
]);

function toErrorCode(code: string): ErrorCode {
  return ERROR_CODES.has(code) ? (code as ErrorCode) : 'upstream_error';
}

function writeChunk(res: ServerResponse, payload: string): Promise<void> {
  if (res.write(payload)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new ProtocolError('aborted', 'client closed the connection'));
    };
    const cleanup = (): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

export function createGateway(options: GatewayOptions): Gateway {
  const logger = options.logger ?? createLogger({ level: 'info', ringSize: 200, sink: () => {} });
  const timeouts: ProviderTimeouts = { ...defaultTimeouts, ...options.timeouts };
  const host = options.host ?? '127.0.0.1';
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const maxConcurrency = options.maxConcurrency ?? 16;

  const providers = new Map<string, ProviderAdapter>();
  for (const provider of options.providers) {
    if (providers.has(provider.id)) {
      throw new Error(`duplicate provider id "${provider.id}"`);
    }
    providers.set(provider.id, provider);
  }

  let server: Server | null = null;
  let port = options.port ?? 0;
  let startedAt: Date | null = null;
  let requestCount = 0;
  let errorCount = 0;
  let inFlight = 0;
  const sockets = new Set<Socket>();

  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    logger.warn('gateway.exposed', { host, message: 'gateway is listening beyond loopback' });
  }
  if (options.token.length === 0) {
    logger.warn('gateway.auth_disabled', {
      message: 'no token configured; local requests are unauthenticated',
    });
  }

  function resolveProvider(model: string): ProviderAdapter {
    const slash = model.indexOf('/');
    if (slash > 0) {
      const candidate = providers.get(model.slice(0, slash));
      if (candidate) return candidate;
    }
    if (providers.size === 1) {
      const only = [...providers.values()][0];
      if (only) return only;
    }
    throw new ProtocolError('not_found', `no provider configured for model "${model}"`, {
      details: { providers: [...providers.keys()] },
    });
  }

  async function handleChat(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const started = Date.now();
    inFlight += 1;
    try {
      const raw = await readBody(req, maxBodyBytes);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ProtocolError('invalid_request', 'request body is not valid JSON');
      }

      const { request, warnings } = decodeChatRequest(body);
      const provider = resolveProvider(request.model);

      const context: ProviderContext = { signal, requestId, timeouts };

      if (request.stream) {
        await streamChat(provider, request, res, context, requestId, warnings, started);
      } else {
        const response = await provider.send(request, context);
        const headers: Record<string, string> = {
          'x-openferry-request-id': requestId,
          'x-openferry-provider': provider.id,
        };
        if (warnings.length > 0) headers['x-openferry-warnings'] = JSON.stringify(warnings);
        sendJson(res, 200, encodeChatResponse(response), headers);
        logger.info('request.completed', {
          requestId,
          providerId: provider.id,
          model: request.model,
          stream: false,
          status: 200,
          durationMs: Date.now() - started,
        });
      }
    } catch (error) {
      const protocolError = toProtocolError(error);
      errorCount += 1;
      logger.warn('request.failed', {
        requestId,
        code: protocolError.code,
        status: protocolError.httpStatus,
        durationMs: Date.now() - started,
      });
      if (!res.headersSent) sendError(res, protocolError, requestId);
      else if (!res.writableEnded) res.end();
    } finally {
      inFlight -= 1;
      requestCount += 1;
    }
  }

  async function streamChat(
    provider: ProviderAdapter,
    request: CanonicalRequest,
    res: ServerResponse,
    context: ProviderContext,
    requestId: string,
    warnings: { code: string; field: string; message: string }[],
    started: number,
  ): Promise<void> {
    let abortReason: string | null = null;
    const inner = new AbortController();
    const forwardAbort = (): void => inner.abort(context.signal.reason);
    if (context.signal.aborted) forwardAbort();
    else context.signal.addEventListener('abort', forwardAbort, { once: true });

    const firstEventTimer = setTimeout(() => {
      abortReason = 'first event timeout';
      inner.abort(new Error('first event timeout'));
    }, timeouts.firstEventMs);
    firstEventTimer.unref();

    const encoder = new ChatChunkEncoder({
      id: `chatcmpl-${requestId}`,
      model: request.model,
      created: Math.floor(Date.now() / 1000),
    });

    const streamContext: ProviderContext = { ...context, signal: inner.signal };
    let headersSent = false;
    let sawTerminal = false;

    try {
      for await (const event of provider.stream(request, streamContext)) {
        // 适配器可能忽略 signal 继续产出事件；首事件超时后不接受任何事件。
        if (abortReason === 'first event timeout') {
          throw new ProtocolError('timeout', 'upstream did not produce a first event in time', {
            providerId: provider.id,
          });
        }
        if (!headersSent) {
          clearTimeout(firstEventTimer);
          if (event.type === 'error') {
            throw new ProtocolError(toErrorCode(event.error.code), event.error.message, {
              providerId: provider.id,
            });
          }
          if (event.type === 'aborted') {
            throw new ProtocolError('aborted', event.reason, { providerId: provider.id });
          }
          const headers: Record<string, string> = {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            'x-openferry-request-id': requestId,
            'x-openferry-provider': provider.id,
          };
          if (warnings.length > 0) headers['x-openferry-warnings'] = JSON.stringify(warnings);
          res.writeHead(200, headers);
          headersSent = true;
        }

        if (event.type === 'error') {
          await writeChunk(
            res,
            formatSse(
              JSON.stringify({ error: { code: event.error.code, message: event.error.message } }),
            ),
          );
          sawTerminal = true;
          break;
        }
        if (event.type === 'aborted') {
          sawTerminal = true;
          break;
        }

        const chunk = encoder.encode(event);
        if (chunk) await writeChunk(res, formatSse(JSON.stringify(chunk)));
      }

      if (!headersSent) {
        throw new ProtocolError('upstream_error', 'upstream produced no events', {
          providerId: provider.id,
        });
      }

      // [DONE] 只在流真正结束后写：上游可能在 done 之后补一条 usage chunk。
      await writeChunk(res, 'data: [DONE]\n\n');
      res.end();
      logger.info('request.completed', {
        requestId,
        providerId: provider.id,
        model: request.model,
        stream: true,
        status: 200,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const protocolError =
        abortReason === 'first event timeout'
          ? new ProtocolError('timeout', 'upstream did not produce a first event in time', {
              providerId: provider.id,
            })
          : toProtocolError(error);

      if (abortReason === 'client disconnected' || context.signal.aborted) {
        res.destroy();
        return;
      }
      if (!headersSent) {
        sendError(res, protocolError, requestId);
      } else if (!res.writableEnded) {
        try {
          await writeChunk(
            res,
            formatSse(
              JSON.stringify({
                error: { code: protocolError.code, message: protocolError.message },
              }),
            ),
          );
          await writeChunk(res, 'data: [DONE]\n\n');
        } catch {
          // 客户端已经走了，没什么可做的。
        }
        res.end();
      }
      logger.warn('stream.failed', {
        requestId,
        providerId: provider.id,
        code: protocolError.code,
        sawTerminal,
        durationMs: Date.now() - started,
      });
    } finally {
      clearTimeout(firstEventTimer);
      context.signal.removeEventListener('abort', forwardAbort);
    }
  }

  async function handleModels(
    res: ServerResponse,
    requestId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const context: ProviderContext = { signal, requestId, timeouts };
    const results = await Promise.allSettled(
      [...providers.values()].map((provider) => provider.listModels(context)),
    );

    const data: unknown[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        for (const model of result.value) {
          data.push({
            id: model.id,
            object: 'model',
            created: model.createdAt ?? 0,
            owned_by: model.ownedBy ?? model.providerId,
            provider: model.providerId,
            source: model.source,
            observed_at: model.observedAt,
          });
        }
      } else {
        const providerId = [...providers.keys()][index] ?? 'unknown';
        logger.warn('models.provider_failed', { providerId, requestId });
      }
    }

    sendJson(res, 200, { object: 'list', data }, { 'x-openferry-request-id': requestId });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = newRequestId();
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('client disconnected'));
    });

    try {
      assertAllowedHost(req, port);
      assertNotBrowserRequest(req);

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      if (path === '/healthz') {
        if (req.method !== 'GET') {
          throw new ProtocolError('method_not_allowed', 'use GET');
        }
        sendJson(res, 200, {
          status: 'ok',
          version: VERSION,
          uptimeMs: startedAt === null ? 0 : Date.now() - startedAt.getTime(),
        });
        return;
      }

      if (path === '/readyz') {
        if (req.method !== 'GET') {
          throw new ProtocolError('method_not_allowed', 'use GET');
        }
        if (providers.size === 0) {
          sendJson(res, 503, { status: 'not_ready', reason: 'no providers configured' });
          return;
        }
        sendJson(res, 200, { status: 'ready', providers: [...providers.keys()] });
        return;
      }

      if (options.token.length > 0) {
        const token = bearerToken(req);
        if (token === null || !safeEqual(token, options.token)) {
          throw new ProtocolError('unauthorized', 'missing or invalid bearer token');
        }
      }

      if (path === '/v1/models') {
        if (req.method !== 'GET') throw new ProtocolError('method_not_allowed', 'use GET');
        await handleModels(res, requestId, controller.signal);
        return;
      }

      if (path === '/v1/chat/completions') {
        if (req.method !== 'POST') throw new ProtocolError('method_not_allowed', 'use POST');
        if (inFlight >= maxConcurrency) {
          throw new ProtocolError('rate_limited', 'gateway concurrency limit reached', {
            details: { maxConcurrency },
          });
        }
        await handleChat(req, res, requestId, controller.signal);
        return;
      }

      throw new ProtocolError('not_found', `no route for ${path}`);
    } catch (error) {
      const protocolError = toProtocolError(error);
      if (!res.headersSent) sendError(res, protocolError, requestId);
      else if (!res.writableEnded) res.end();
    }
  }

  return {
    logger,
    async start() {
      if (server) throw new Error('gateway already started');
      server = createServer((req, res) => {
        void route(req, res);
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server.keepAliveTimeout = 65_000;
      server.headersTimeout = 70_000;
      server.requestTimeout = 0;

      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(port, host, () => {
          server?.off('error', reject);
          resolve();
        });
      });

      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('gateway failed to bind');
      }
      port = address.port;
      startedAt = new Date();
      logger.info('gateway.started', {
        url: `http://${host}:${port}`,
        providers: [...providers.keys()],
      });
      return { url: `http://${host}:${port}`, port };
    },

    async stop() {
      if (!server) return;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const closing = server;
      server = null;
      startedAt = null;
      await new Promise<void>((resolve, reject) => {
        closing.close((error) => (error ? reject(error) : resolve()));
      });
      logger.info('gateway.stopped', {});
    },

    stats() {
      return {
        startedAt: startedAt?.toISOString() ?? null,
        url: server ? `http://${host}:${port}` : null,
        port: server ? port : null,
        requests: requestCount,
        errors: errorCount,
        inFlight,
        providers: [...providers.keys()],
      };
    },
  };
}
