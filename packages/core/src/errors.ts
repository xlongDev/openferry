/**
 * 跨模块唯一的错误类型。
 *
 * 为什么不用裸 `Error`：网关需要根据错误决定 HTTP 状态码、是否可重试、
 * 以及能否把细节透给客户端。这些判断如果散落在 catch 块里，一定会不一致。
 */

export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_error'
  | 'upstream_unavailable'
  | 'aborted'
  | 'unsupported'
  | 'internal';

const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  rate_limited: 429,
  timeout: 504,
  upstream_error: 502,
  upstream_unavailable: 503,
  aborted: 499,
  unsupported: 501,
  internal: 500,
};

/** 只有这些错误码可以自动重试，且调用方仍需确认请求没有产生副作用。 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'rate_limited',
  'timeout',
  'upstream_unavailable',
]);

export interface ProtocolErrorOptions {
  providerId?: string;
  upstreamStatus?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
  /** 覆盖默认的可重试判断，用于个别供应商的特殊语义。 */
  retryable?: boolean;
}

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly providerId?: string;
  readonly upstreamStatus?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: ProtocolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProtocolError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    if (options.providerId !== undefined) this.providerId = options.providerId;
    if (options.upstreamStatus !== undefined) this.upstreamStatus = options.upstreamStatus;
    if (options.details !== undefined) this.details = options.details;
  }

  /** 给客户端看的形状，永远不包含上游原始 body 或请求头。 */
  toWire(): { error: { type: string; code: ErrorCode; message: string; provider?: string } } {
    return {
      error: {
        type: 'openferry_error',
        code: this.code,
        message: this.message,
        ...(this.providerId === undefined ? {} : { provider: this.providerId }),
      },
    };
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.providerId === undefined ? {} : { providerId: this.providerId }),
      ...(this.upstreamStatus === undefined ? {} : { upstreamStatus: this.upstreamStatus }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isProtocolError(value: unknown): value is ProtocolError {
  return value instanceof ProtocolError;
}

/**
 * 把任意抛出物收敛为 ProtocolError。
 * AbortError 单独识别，因为它在网关里是最常见的一种"错误"，且不是故障。
 */
export function toProtocolError(value: unknown): ProtocolError {
  if (isProtocolError(value)) return value;
  if (value instanceof Error) {
    if (value.name === 'AbortError' || value.name === 'TimeoutError') {
      return new ProtocolError('aborted', 'request aborted', { cause: value });
    }
    return new ProtocolError('internal', value.message, { cause: value });
  }
  return new ProtocolError('internal', String(value));
}

/** 上游 HTTP 状态码 → 错误码。集中在一处，避免每个适配器各写一套。 */
export function codeFromUpstreamStatus(status: number): ErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 501) return 'unsupported';
  if (status >= 500) return 'upstream_unavailable';
  return 'upstream_error';
}
