import { isIP } from 'node:net';
import { ProtocolError } from './errors.js';

/**
 * 供应商 URL 是不可信输入：用户可能被诱导填成云元数据地址或内网服务。
 * 这里做的是「字面量 + 主机名」级别的守卫。
 *
 * 已知缺口：不做连接时的 DNS 固定，因此 DNS rebinding 未被完全阻断。
 * 见 docs/security/threat-model.md T2/T3。
 */

export interface UrlGuardPolicy {
  /** 允许访问 loopback / 私网（本地模型服务需要）。 */
  allowPrivateNetwork?: boolean;
  /** 精确放行的主机名，优先级高于 IP 规则。 */
  allowedHosts?: readonly string[];
}

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata',
]);

const METADATA_IPS = new Set([
  '169.254.169.254', // AWS / GCP / Azure / OpenStack
  '169.254.170.2', // ECS task metadata
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IPv6
]);

function reject(message: string, details?: Record<string, unknown>): never {
  throw new ProtocolError('invalid_request', message, { details });
}

/** 把 `2130706433` / `0x7f000001` 这类整型写法还原成点分 IPv4。 */
function normalizeNumericHost(host: string): string {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    }
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = Number.parseInt(host, 16);
    if (Number.isSafeInteger(n) && n <= 0xffffffff) {
      return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    }
  }
  return host;
}

function ipv4ToBytes(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

type AddressClass = 'public' | 'loopback' | 'private' | 'link-local' | 'metadata' | 'reserved';

function classifyIpv4(bytes: number[]): AddressClass {
  const [a, b] = bytes as [number, number, number, number];
  if (a === 169 && b === 254) {
    return bytes.join('.') === '169.254.169.254' ? 'metadata' : 'link-local';
  }
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT
  if (a === 0 || a >= 224) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  return 'public';
}

function classifyIpv6(host: string): AddressClass {
  const h = host.toLowerCase();
  if (METADATA_IPS.has(h)) return 'metadata';
  if (h === '::' || h === '::1') return 'loopback';
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    return 'link-local';
  }
  if (h.startsWith('fc') || h.startsWith('fd')) return 'private';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped?.[1]) {
    const bytes = ipv4ToBytes(mapped[1]);
    if (bytes) return classifyIpv4(bytes);
  }
  return 'public';
}

function classifyHost(hostname: string): AddressClass {
  const host = normalizeNumericHost(hostname.replace(/^\[|\]$/g, '').toLowerCase());
  if (METADATA_HOSTS.has(host)) return 'metadata';
  if (METADATA_IPS.has(host)) return 'metadata';
  if (isIP(host) === 4) {
    const bytes = ipv4ToBytes(host);
    return bytes ? classifyIpv4(bytes) : 'reserved';
  }
  if (isIP(host) === 6) return classifyIpv6(host);
  // 非 IP 主机名：`.local` 是 mDNS，按私网处理；其余留给连接时的解析校验。
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    return 'loopback';
  return 'public';
}

export function assertSafeProviderUrl(raw: string, policy: UrlGuardPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reject('provider url is not a valid absolute URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    reject(`provider url protocol "${url.protocol}" is not allowed`, { protocol: url.protocol });
  }
  if (url.username || url.password) {
    reject('provider url must not embed credentials; use a credential reference instead');
  }

  const hostname = url.hostname;
  if (policy.allowedHosts?.some((h) => h.toLowerCase() === hostname.toLowerCase())) {
    return url;
  }

  const klass = classifyHost(hostname);
  if (klass === 'metadata') {
    reject('provider url points at a cloud metadata endpoint', { host: hostname });
  }
  if (klass === 'link-local') {
    reject('provider url points at a link-local address', { host: hostname });
  }
  if (klass === 'reserved') {
    reject('provider url points at a reserved address', { host: hostname });
  }
  if ((klass === 'loopback' || klass === 'private') && policy.allowPrivateNetwork !== true) {
    reject(
      'provider url points at a private network address; enable allowPrivateNetwork to permit it',
      {
        host: hostname,
      },
    );
  }
  return url;
}
