import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * 定长比较。长度不等时也走一次等长比较，避免通过响应时间推断 token 长度。
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
