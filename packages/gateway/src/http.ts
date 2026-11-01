import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProtocolError } from '@openferry/core';

export const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limitBytes) {
      throw new ProtocolError('payload_too_large', `request body exceeds ${limitBytes} bytes`, {
        details: { limitBytes },
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, error: ProtocolError, requestId?: string): void {
  const headers: Record<string, string> = {};
  if (requestId !== undefined) headers['x-openferry-request-id'] = requestId;
  if (error.code === 'rate_limited') headers['retry-after'] = '1';
  // 体积超限时不要继续复用连接：客户端可能还在写。
  if (error.code === 'payload_too_large') headers['connection'] = 'close';
  sendJson(res, error.httpStatus, error.toWire(), headers);
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * 本地端口的浏览器围栏。
 *
 * 只靠 CORS 不够：CORS 只阻止页面**读取**响应，不阻止请求产生副作用
 * （比如消耗额度）。所以只要看到浏览器特有的头就直接拒绝。
 */
export function assertNotBrowserRequest(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== 'null') {
    throw new ProtocolError(
      'forbidden',
      'requests from browsers are not allowed on the local gateway',
    );
  }
  // 浏览器会带 Referer / Sec-Fetch-Site；Node 的 fetch 只带 sec-fetch-mode: cors，
  // 所以不能拿 sec-fetch-mode 做判断，否则会误杀所有 Node 客户端。
  if (req.headers['referer'] !== undefined || req.headers['sec-fetch-site'] !== undefined) {
    throw new ProtocolError(
      'forbidden',
      'requests from browsers are not allowed on the local gateway',
    );
  }
}

/** Host 头白名单：阻断 DNS rebinding 的第一步。 */
export function assertAllowedHost(req: IncomingMessage, port: number): void {
  const host = req.headers.host;
  if (host === undefined) {
    throw new ProtocolError('forbidden', 'missing Host header');
  }
  const allowed = new Set<string>();
  for (const name of LOCAL_HOSTS) allowed.add(`${name}:${port}`);
  if (!allowed.has(host.toLowerCase())) {
    throw new ProtocolError('forbidden', 'unexpected Host header', { details: { host } });
  }
}
