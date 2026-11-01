import type { JSX } from 'react';
import type { LogRecord, StatusPayload } from './types.js';

const STATE_LABEL: Record<StatusPayload['state'], string> = {
  running: '运行中',
  stopped: '已停止',
  starting: '启动中',
  error: '异常',
};

export function formatDuration(ms: number): string {
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

export function StatusPill({ state }: { state: StatusPayload['state'] }): JSX.Element {
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

interface OverviewProps {
  status: StatusPayload;
  logs: LogRecord[];
  now: number;
  busy: string | null;
  onAction(action: 'start' | 'stop' | 'restart'): void;
  onOpenDataDir(): void;
  onGotoProviders(): void;
}

export function Overview({
  status,
  logs,
  now,
  busy,
  onAction,
  onOpenDataDir,
  onGotoProviders,
}: OverviewProps): JSX.Element {
  const running = status.state === 'running';
  const canStart = status.state === 'stopped' || status.state === 'error';
  const uptime = status.startedAt
    ? formatDuration(now - new Date(status.startedAt).getTime())
    : '—';

  return (
    <>
      <section className="card" aria-labelledby="gateway-heading">
        <div className="card-head">
          <h2 id="gateway-heading">网关</h2>
          <span className="mono subtle">{status.url ?? '未监听'}</span>
        </div>

        <div className="metrics">
          <Metric label="监听地址" value={status.url ? status.url.replace('http://', '') : '—'} />
          <Metric label="运行时长" value={running ? uptime : '—'} />
          <Metric label="请求总数" value={String(status.requests)} />
          <Metric label="处理中" value={String(status.inFlight)} />
          <Metric
            label="失败请求"
            value={String(status.errors)}
            hint={status.errors > 0 ? '查看日志定位原因' : undefined}
          />
        </div>

        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canStart || busy !== null}
            onClick={() => onAction('start')}
          >
            {busy === 'start' ? '启动中…' : '启动'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!running || busy !== null}
            onClick={() => onAction('stop')}
          >
            {busy === 'stop' ? '停止中…' : '停止'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || status.state === 'starting'}
            onClick={() => onAction('restart')}
          >
            {busy === 'restart' ? '重启中…' : '重启'}
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn-quiet" onClick={onOpenDataDir}>
            打开数据目录
          </button>
        </div>
      </section>

      <div className="columns">
        <section className="card" aria-labelledby="providers-heading">
          <div className="card-head">
            <h2 id="providers-heading">已启用供应商</h2>
            <span className="subtle">{status.providers.length} 个</span>
          </div>

          {status.providers.length > 0 ? (
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
              <p>网关当前没有可用供应商。</p>
              <button type="button" className="btn btn-small" onClick={onGotoProviders}>
                去添加
              </button>
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
        <span className="mono subtle">{status.dataDir}</span>
        <span className="subtle">
          schema v{status.schemaVersion} · 密钥存储{' '}
          {status.secretStore === 'encrypted' ? '系统凭据' : status.secretStore}
        </span>
      </footer>
    </>
  );
}
