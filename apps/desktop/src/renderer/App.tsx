import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { LogRecord, StatusPayload } from './types.js';

type Tab = 'overview' | 'providers' | 'models' | 'clients' | 'logs' | 'settings';

const NAV: Array<{ id: Tab; label: string; ready: boolean }> = [
  { id: 'overview', label: '概览', ready: true },
  { id: 'providers', label: '供应商', ready: false },
  { id: 'models', label: '模型', ready: false },
  { id: 'clients', label: '客户端', ready: false },
  { id: 'logs', label: '日志', ready: false },
  { id: 'settings', label: '设置', ready: false },
];

const STATE_LABEL: Record<StatusPayload['state'], string> = {
  running: '运行中',
  stopped: '已停止',
  starting: '启动中',
  error: '异常',
};

function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function StatusPill({ state }: { state: StatusPayload['state'] }): JSX.Element {
  return (
    <span className={`pill pill-${state}`}>
      <span className="pill-dot" aria-hidden="true" />
      {STATE_LABEL[state]}
    </span>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {hint ? <span className="metric-hint">{hint}</span> : null}
    </div>
  );
}

function LogTable({ logs }: { logs: LogRecord[] }): JSX.Element {
  if (logs.length === 0) {
    return <p className="empty">还没有日志。启动网关或发一次请求后会出现在这里。</p>;
  }
  return (
    <ul className="log-list">
      {logs.map((record, index) => {
        const { ts, level, event, ...fields } = record;
        const detail = Object.entries(fields)
          .filter(([, value]) => value !== undefined)
          .map(
            ([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
          )
          .join('  ');
        return (
          <li key={`${ts}-${index}`} className="log-row">
            <span className="log-time">{formatClock(ts)}</span>
            <span className={`log-level log-level-${level}`}>{level}</span>
            <span className="log-event">{event}</span>
            {detail ? <span className="log-fields">{detail}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  const api = typeof window === 'undefined' ? undefined : window.openferry;

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [nextStatus, nextLogs] = await Promise.all([api.getStatus(), api.recentLogs(40)]);
      if (!mounted.current) return;
      setStatus(nextStatus);
      setLogs(nextLogs);
    } catch (error) {
      if (!mounted.current) return;
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 1500);
    return () => {
      mounted.current = false;
      clearInterval(poll);
    };
  }, [refresh]);

  const run = useCallback(
    async (action: 'start' | 'stop' | 'restart') => {
      if (!api) return;
      setBusy(action);
      setActionError(null);
      try {
        const next = await api[action]();
        if (mounted.current) setStatus(next);
      } catch (error) {
        if (mounted.current) setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [api],
  );

  const uptime = useMemo(() => {
    if (!status?.startedAt) return '—';
    return formatDuration(now - new Date(status.startedAt).getTime());
  }, [status?.startedAt, now]);

  if (!api) {
    return (
      <div className="boot">
        <p>这个界面需要通过桌面应用打开。</p>
        <p className="boot-hint">在浏览器里直接访问渲染层拿不到网关状态，也没有 IPC 通道。</p>
      </div>
    );
  }

  const state = status?.state ?? 'stopped';
  const running = state === 'running';
  const canStart = state === 'stopped' || state === 'error';

  return (
    <div className="shell">
      <div className="drag-strip" />

      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">OpenFerry</span>
        </div>

        <nav className="nav" aria-label="主导航">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${tab === item.id ? 'is-active' : ''}`}
              disabled={!item.ready}
              onClick={() => item.ready && setTab(item.id)}
              title={item.ready ? undefined : '这一页还没实现'}
            >
              <span>{item.label}</span>
              {item.ready ? null : <span className="nav-tag">未实现</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <span className="mono subtle">v{status?.version ?? '0.1.0'}</span>
        </div>
      </aside>

      <main className="content">
        <header className="page-head">
          <div>
            <h1>概览</h1>
            <p className="page-sub">本机网关的实时状态。每 1.5 秒刷新一次。</p>
          </div>
          <StatusPill state={state} />
        </header>

        {actionError ? (
          <div className="banner banner-error" role="alert">
            <span>操作失败：{actionError}</span>
          </div>
        ) : null}

        {status?.lastError ? (
          <div className="banner banner-error" role="alert">
            <span>网关启动失败：{status.lastError}</span>
          </div>
        ) : null}

        <section className="card" aria-labelledby="gateway-heading">
          <div className="card-head">
            <h2 id="gateway-heading">网关</h2>
            <span className="mono subtle">{status?.url ?? '未监听'}</span>
          </div>

          <div className="metrics">
            <Metric
              label="监听地址"
              value={status?.url ? status.url.replace('http://', '') : '—'}
            />
            <Metric label="运行时长" value={running ? uptime : '—'} />
            <Metric label="请求总数" value={String(status?.requests ?? 0)} />
            <Metric label="处理中" value={String(status?.inFlight ?? 0)} />
            <Metric
              label="失败请求"
              value={String(status?.errors ?? 0)}
              hint={status && status.errors > 0 ? '查看日志定位原因' : undefined}
            />
          </div>

          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canStart || busy !== null}
              onClick={() => void run('start')}
            >
              {busy === 'start' ? '启动中…' : '启动'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!running || busy !== null}
              onClick={() => void run('stop')}
            >
              {busy === 'stop' ? '停止中…' : '停止'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null || state === 'starting'}
              onClick={() => void run('restart')}
            >
              {busy === 'restart' ? '重启中…' : '重启'}
            </button>
            <span className="spacer" />
            <button type="button" className="btn btn-quiet" onClick={() => void api.openDataDir()}>
              打开数据目录
            </button>
          </div>
        </section>

        <div className="columns">
          <section className="card" aria-labelledby="providers-heading">
            <div className="card-head">
              <h2 id="providers-heading">供应商</h2>
              <span className="subtle">{status?.providers.length ?? 0} 个</span>
            </div>

            {status && status.providers.length > 0 ? (
              <ul className="provider-list">
                {status.providers.map((id) => (
                  <li key={id} className="provider-row">
                    <span className="provider-dot" aria-hidden="true" />
                    <span className="mono">{id}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty">
                <p>还没有配置供应商。</p>
                <p className="mono empty-path">
                  {status?.configPath ?? '~/.openferry/config.json'}
                </p>
                <p className="empty-hint">
                  写一个带 providers 数组的 JSON
                  文件后点「重启」。密钥通过环境变量引用，不写进这个文件。
                </p>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="activity-heading">
            <div className="card-head">
              <h2 id="activity-heading">最近活动</h2>
              <span className="subtle">最近 {logs.length} 条</span>
            </div>
            <LogTable logs={logs} />
          </section>
        </div>

        <footer className="page-foot">
          <span className="mono subtle">{status?.dataDir}</span>
          <span className="subtle">日志不记录提示词、模型输出与凭据</span>
        </footer>
      </main>
    </div>
  );
}
