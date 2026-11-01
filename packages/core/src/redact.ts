/**
 * 日志与诊断报告的脱敏。
 *
 * 这是安全关键路径：任何一个漏网的键都可能把 API Key 写进磁盘。
 * 策略是「按值也按形状」——键名匹配、Bearer 前缀匹配、URL query 匹配，三条都做。
 */

const SECRET_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|password|passwd|x-api-key)$/i;

const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/gi;

const URL_QUERY_SECRET =
  /([?&](?:key|api_key|apikey|token|access_token|sig|signature|password)=)[^&#\s"']+/gi;

/**
 * 上游错误体经常回显密钥（"invalid key sk-abc…"）。这里按已知前缀兜底，
 * 但真正的防线是调用方不把上游 body 塞进错误消息（见 provider #ensureOk）。
 */
const PROVIDER_KEY = /\b(?:sk|rk|pk|ghp|gho|ghs|ghu|xoxb|xoxp|AKIA|ASIA)[-_A-Za-z0-9]{10,}\b/g;

const MASK = '***redacted***';
const MAX_DEPTH = 6;
const MAX_STRING = 512;

export function redactString(input: string): string {
  return input
    .replace(AUTH_SCHEME, `$1 ${MASK}`)
    .replace(PROVIDER_KEY, MASK)
    .replace(URL_QUERY_SECRET, `$1${MASK}`);
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/**
 * 深拷贝并掩码。遇到循环引用直接返回占位符而不是抛错 ——
 * 日志路径不允许因为数据结构奇怪而失败。
 */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${redactString(value.slice(0, MAX_STRING))}…`
      : redactString(value);
  }
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? MASK : redact(item, depth + 1, seen);
  }
  return out;
}
