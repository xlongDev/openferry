import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { LogRecord } from './types.js';

const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;
type LevelFilter = (typeof LEVELS)[number];

const LEVEL_LABEL: Record<LevelFilter, string> = {
  all: '全部',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function fieldsOf(record: LogRecord): string {
  const { ts: _ts, level: _level, event: _event, ...rest } = record;
  return Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('  ');
}

export function Logs({ logs }: { logs: LogRecord[] }): JSX.Element {
  const [level, setLevel] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const [exported, setExported] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter((record) => {
      if (level !== 'all' && record.level !== level) return false;
      if (needle.length === 0) return true;
      return `${record.event} ${fieldsOf(record)}`.toLowerCase().includes(needle);
    });
  }, [logs, level, query]);

  const exportDiagnostics = async (): Promise<void> => {
    setError(null);
    try {
      const result = await window.openferry.exportDiagnostics();
      setExported(result.file);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <h2 className="section-title">日志</h2>
          <p className="section-sub">
            只记录结构化元数据：请求
            ID、供应商、模型、状态、耗时、错误码。不记录提示词、模型输出与凭据。
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void exportDiagnostics()}>
          导出诊断报告
        </button>
      </div>

      {error ? (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
      {exported ? (
        <div className="banner banner-info">
          <span>已导出：{exported}（已在访达中定位）</span>
        </div>
      ) : null}

      <div className="toolbar">
        <input
          className="input toolbar-search"
          placeholder="搜索事件、请求 ID 或字段"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="filter-chips">
          {LEVELS.map((item) => (
            <button
              key={item}
              type="button"
              className={`chip ${level === item ? 'is-on' : ''}`}
              onClick={() => setLevel(item)}
            >
              {LEVEL_LABEL[item]}
            </button>
          ))}
        </div>
        <span className="subtle">
          {visible.length} / {logs.length}
        </span>
      </div>

      <div className="card">
        {visible.length === 0 ? (
          <p className="empty">没有匹配的日志。</p>
        ) : (
          <ul className="log-list log-list-full">
            {visible.map((record, index) => (
              <li key={`${record.ts}-${index}`} className="log-row">
                <span className="log-time">{formatClock(record.ts)}</span>
                <span className={`log-level log-level-${record.level}`}>{record.level}</span>
                <span className="log-event">{record.event}</span>
                <span className="log-fields">{fieldsOf(record)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
