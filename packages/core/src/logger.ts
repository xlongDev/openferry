import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (record: LogRecord) => void;
  /** 保留最近 N 条，供桌面端「Logs」页读取。0 表示不保留。 */
  ringSize?: number;
  now?: () => Date;
}

export interface LoggerHandle extends Logger {
  recent(limit?: number): LogRecord[];
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 结构化日志。刻意不提供 `logger.info(obj)` 这种整对象重载：
 * 一旦允许任意对象展开，某个调用点迟早会把请求体整个丢进来。
 */
export function createLogger(options: LoggerOptions = {}): LoggerHandle {
  const minLevel = ORDER[options.level ?? 'info'];
  const ringSize = options.ringSize ?? 0;
  const now = options.now ?? (() => new Date());
  const ring: LogRecord[] = [];

  const emit = (
    level: LogLevel,
    bindings: Record<string, unknown>,
    event: string,
    fields?: Record<string, unknown>,
  ) => {
    if (ORDER[level] < minLevel) return;
    const record = redact({
      ...bindings,
      ...fields,
      ts: now().toISOString(),
      level,
      event,
    }) as LogRecord;

    if (ringSize > 0) {
      ring.push(record);
      if (ring.length > ringSize) ring.shift();
    }
    options.sink?.(record);
  };

  const make = (bindings: Record<string, unknown>): LoggerHandle => ({
    debug: (event, fields) => emit('debug', bindings, event, fields),
    info: (event, fields) => emit('info', bindings, event, fields),
    warn: (event, fields) => emit('warn', bindings, event, fields),
    error: (event, fields) => emit('error', bindings, event, fields),
    child: (extra) => make({ ...bindings, ...extra }),
    recent: (limit = 100) => ring.slice(-limit),
  });

  return make({});
}

/** 开发期把日志打到 stdout；生产环境由宿主决定 sink。 */
export function stdoutSink(record: LogRecord): void {
  const { ts, level, event, ...rest } = record;
  const line =
    Object.keys(rest).length > 0
      ? `${ts} ${level} ${event} ${JSON.stringify(rest)}`
      : `${ts} ${level} ${event}`;
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}
