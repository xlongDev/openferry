import {
  ProtocolError,
  assertSafeProviderUrl,
  codeFromUpstreamStatus,
  redactString,
} from '@openferry/core';
import { defaultCapabilities } from '@openferry/canonical';
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalResponse,
  ModelDescriptor,
  ProviderCapabilities,
} from '@openferry/canonical';
import {
  SseParser,
  createStreamDecoderState,
  decodeChatChunk,
  decodeChatResponse,
  modelListWireSchema,
} from '@openferry/protocol-openai-chat';
import type { ProviderAdapter, ProviderContext } from '@openferry/provider-contract';
import { encodeCanonicalRequest } from './encode.js';

export interface OpenAICompatibleOptions {
  id: string;
  /** API 根地址，例如 `https://api.openai.com/v1`；缺少路径时会自动补 `/v1`。 */
  baseUrl: string;
  apiKey?: string;
  allowPrivateNetwork?: boolean;
  capabilities?: Partial<ProviderCapabilities>;
  extraHeaders?: Record<string, string>;
}

function normalizeBaseUrl(raw: string, allowPrivateNetwork: boolean | undefined): string {
  const url = assertSafeProviderUrl(raw, {
    allowPrivateNetwork: allowPrivateNetwork === true,
  });
  const trimmed = url.toString().replace(/\/+$/, '');
  const path = url.pathname.replace(/\/+$/, '');
  return path === '' ? `${trimmed}/v1` : trimmed;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * 通用 OpenAI 兼容供应商。
 *
 * 刻意不做的事：不跟随重定向（防止 Authorization 被带到别的 host）、
 * 不重试（重试策略属于网关，且工具调用请求不能无条件重试）。
 */
export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #extraHeaders: Record<string, string>;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.capabilities = { ...defaultCapabilities, ...options.capabilities };
    this.#baseUrl = normalizeBaseUrl(options.baseUrl, options.allowPrivateNetwork);
    this.#apiKey = options.apiKey;
    this.#extraHeaders = options.extraHeaders ?? {};
  }

  #url(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  #headers(accept: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept,
      'user-agent': 'openferry/0.1',
      ...(this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` }),
      ...this.#extraHeaders,
    };
  }

  #upstreamModel(canonicalModel: string): string {
    const prefix = `${this.id}/`;
    return canonicalModel.startsWith(prefix) ? canonicalModel.slice(prefix.length) : canonicalModel;
  }

  async #open(
    path: string,
    init: RequestInit,
    context: ProviderContext,
  ): Promise<{ res: Response; cleanup: () => void; didTimeout: () => boolean }> {
    const controller = new AbortController();
    let timedOut = false;

    const onOuterAbort = (): void => controller.abort(context.signal.reason);
    if (context.signal.aborted) onOuterAbort();
    else context.signal.addEventListener('abort', onOuterAbort, { once: true });

    const total = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('total timeout'));
    }, context.timeouts.totalMs);
    total.unref();

    const connect = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('connect timeout'));
    }, context.timeouts.connectMs);
    connect.unref();

    const cleanup = (): void => {
      clearTimeout(total);
      clearTimeout(connect);
      context.signal.removeEventListener('abort', onOuterAbort);
    };

    try {
      const res = await fetch(this.#url(path), {
        ...init,
        signal: controller.signal,
        redirect: 'manual',
      });
      clearTimeout(connect);
      return { res, cleanup, didTimeout: () => timedOut };
    } catch (error) {
      cleanup();
      throw this.#mapFetchError(error, context, timedOut);
    }
  }

  #mapFetchError(error: unknown, context: ProviderContext, timedOut: boolean): ProtocolError {
    if (timedOut) {
      return new ProtocolError('timeout', 'upstream request timed out', {
        providerId: this.id,
        cause: error,
      });
    }
    if (context.signal.aborted || isAbortError(error)) {
      return new ProtocolError('aborted', 'request aborted', { providerId: this.id, cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ProtocolError(
      'upstream_unavailable',
      `cannot reach upstream: ${redactString(message)}`,
      {
        providerId: this.id,
        cause: error,
      },
    );
  }

  async #ensureOk(res: Response): Promise<void> {
    if (res.ok) return;
    const code = codeFromUpstreamStatus(res.status);
    // 认证失败时上游常把密钥回显在 body 里，干脆不引用 body。
    const raw =
      code === 'unauthorized' || code === 'forbidden' ? '' : await res.text().catch(() => '');
    const snippet = redactString(raw.replace(/\s+/g, ' ').trim().slice(0, 300));
    throw new ProtocolError(
      code,
      `upstream responded ${res.status}${snippet.length > 0 ? `: ${snippet}` : ''}`,
      { providerId: this.id, upstreamStatus: res.status },
    );
  }

  async listModels(context: ProviderContext): Promise<ModelDescriptor[]> {
    const { res, cleanup } = await this.#open(
      '/models',
      { method: 'GET', headers: this.#headers('application/json') },
      context,
    );
    try {
      await this.#ensureOk(res);
      const parsed = modelListWireSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new ProtocolError('upstream_error', 'upstream model list is malformed', {
          providerId: this.id,
        });
      }
      const observedAt = new Date().toISOString();
      return parsed.data.data.map((model) => ({
        id: `${this.id}/${model.id}`,
        providerId: this.id,
        upstreamId: model.id,
        displayName: model.id,
        ...(model.created === undefined ? {} : { createdAt: model.created }),
        ...(model.owned_by === undefined ? {} : { ownedBy: model.owned_by }),
        source: 'upstream:/models',
        observedAt,
      }));
    } finally {
      cleanup();
    }
  }

  async send(request: CanonicalRequest, context: ProviderContext): Promise<CanonicalResponse> {
    const body = encodeCanonicalRequest(request, {
      model: this.#upstreamModel(request.model),
      stream: false,
    });
    const { res, cleanup } = await this.#open(
      '/chat/completions',
      { method: 'POST', headers: this.#headers('application/json'), body: JSON.stringify(body) },
      context,
    );
    try {
      await this.#ensureOk(res);
      const json: unknown = await res.json();
      return decodeChatResponse(json, request.model);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      if (context.signal.aborted) {
        throw new ProtocolError('aborted', 'request aborted', {
          providerId: this.id,
          cause: error,
        });
      }
      throw new ProtocolError('upstream_error', 'upstream returned invalid JSON', {
        providerId: this.id,
        cause: error,
      });
    } finally {
      cleanup();
    }
  }

  async *stream(
    request: CanonicalRequest,
    context: ProviderContext,
  ): AsyncIterable<CanonicalEvent> {
    const body = encodeCanonicalRequest(request, {
      model: this.#upstreamModel(request.model),
      stream: true,
    });

    let opened: { res: Response; cleanup: () => void; didTimeout: () => boolean };
    try {
      opened = await this.#open(
        '/chat/completions',
        { method: 'POST', headers: this.#headers('text/event-stream'), body: JSON.stringify(body) },
        context,
      );
    } catch (error) {
      yield this.#toErrorEvent(error, context);
      return;
    }

    try {
      await this.#ensureOk(opened.res);
      if (!opened.res.body) {
        yield {
          type: 'error',
          error: { code: 'upstream_error', message: 'upstream returned no body' },
        };
        return;
      }
      yield* this.#decodeSse(opened.res.body, context);
    } catch (error) {
      yield this.#toErrorEvent(error, context);
    } finally {
      opened.cleanup();
    }
  }

  #toErrorEvent(error: unknown, context: ProviderContext): CanonicalEvent {
    if (error instanceof ProtocolError) {
      return { type: 'error', error: { code: error.code, message: error.message } };
    }
    if (context.signal.aborted || isAbortError(error)) {
      return { type: 'aborted', reason: 'client disconnected' };
    }
    return {
      type: 'error',
      error: { code: 'upstream_error', message: redactString(String(error)) },
    };
  }

  async *#decodeSse(
    body: ReadableStream<Uint8Array>,
    context: ProviderContext,
  ): AsyncGenerator<CanonicalEvent> {
    const reader = body.getReader();
    const parser = new SseParser();
    const state = createStreamDecoderState();
    const textDecoder = new TextDecoder();
    let sawDone = false;
    let sawCompletion = false;

    try {
      while (!sawDone) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = textDecoder.decode(value, { stream: true });

        for (const sse of parser.push(text)) {
          if (sse.data.trim() === '[DONE]') {
            sawDone = true;
            break;
          }
          for (const event of this.#decodeSseEvent(sse.data, state)) {
            if (event.type === 'done') sawCompletion = true;
            if (event.type === 'error' || event.type === 'aborted') sawCompletion = true;
            yield event;
            if (event.type === 'error' || event.type === 'aborted') {
              sawDone = true;
              break;
            }
          }
          if (sawDone) break;
        }
      }

      if (!sawDone) {
        for (const sse of parser.end()) {
          if (sse.data.trim() === '[DONE]') {
            sawDone = true;
            break;
          }
          for (const event of this.#decodeSseEvent(sse.data, state)) {
            if (event.type === 'done') sawCompletion = true;
            yield event;
          }
        }
      }

      if (!sawCompletion) {
        yield {
          type: 'error',
          error: {
            code: 'upstream_error',
            message: context.signal.aborted
              ? 'stream aborted before completion'
              : 'upstream stream ended without a completion signal',
          },
        };
      }
    } finally {
      reader.releaseLock();
    }
  }

  #decodeSseEvent(
    data: string,
    state: ReturnType<typeof createStreamDecoderState>,
  ): CanonicalEvent[] {
    const trimmed = data.trim();
    if (trimmed.length === 0) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [
        {
          type: 'error',
          error: {
            code: 'upstream_error',
            message: 'upstream sent invalid JSON in an SSE data field',
          },
        },
      ];
    }
    return decodeChatChunk(parsed, state);
  }
}
