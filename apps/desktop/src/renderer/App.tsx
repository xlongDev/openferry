import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Overview, StatusPill } from './Overview.js';
import { Clients } from './Clients.js';
import { Logs } from './Logs.js';
import { Settings } from './Settings.js';
import { Models } from './Models.js';
import { Providers } from './Providers.js';
import { applyTheme, loadTheme, watchSystemTheme, type ThemePref } from './theme.js';
import type { LogRecord, StatusPayload } from './types.js';

type Tab = 'overview' | 'providers' | 'models' | 'clients' | 'logs' | 'settings';

const NAV: Array<{ id: string; label: string; ready: boolean }> = [
  { id: 'overview', label: '概览', ready: true },
  { id: 'providers', label: '供应商', ready: true },
  { id: 'models', label: '模型', ready: true },
  { id: 'clients', label: '客户端', ready: true },
  { id: 'logs', label: '日志', ready: true },
  { id: 'settings', label: '设置', ready: true },
];

const PAGE_META: Record<Tab, { title: string; sub: string }> = {
  overview: { title: '概览', sub: '本机网关的实时状态。每 1.5 秒刷新一次。' },
  providers: { title: '供应商', sub: '上游端点、密钥引用与启用状态。' },
  models: { title: '模型', sub: '从供应商拉到的目录，以及带有效期的能力结论。' },
  clients: { title: '客户端', sub: '把模型写进客户端配置，写前备份、写后可恢复。' },
  logs: { title: '日志', sub: '结构化事件，不含提示词、模型输出与凭据。' },
  settings: { title: '设置', sub: '外观与运行信息。' },
};

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Electron 把 IPC 的 Error 包成 "Error invoking remote method '...': Error: 真实信息"
  const match = /Error:\s*(.+)$/.exec(raw);
  return match?.[1]?.trim() ?? raw;
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [now, setNow] = useState(() => Date.now());
  const [theme, setTheme] = useState<ThemePref>(() => loadTheme());
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
      setActionError(errorMessage(error));
    }
  }, [api]);

  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(() => theme);
  }, [theme]);

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
        if (mounted.current) setActionError(errorMessage(error));
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [api],
  );

  if (!api) {
    return (
      <div className="boot">
        <p>这个界面需要通过桌面应用打开。</p>
        <p className="boot-hint">在浏览器里直接访问渲染层拿不到网关状态，也没有 IPC 通道。</p>
      </div>
    );
  }

  const meta = PAGE_META[tab];
  const state = status?.state ?? 'stopped';

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
              onClick={() => {
                if (
                  ['overview', 'providers', 'models', 'clients', 'logs', 'settings'].includes(
                    item.id,
                  )
                ) {
                  setTab(item.id as Tab);
                }
              }}
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
            <h1>{meta.title}</h1>
            <p className="page-sub">{meta.sub}</p>
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

        {status === null ? (
          <p className="empty">正在读取网关状态…</p>
        ) : tab === 'overview' ? (
          <Overview
            status={status}
            logs={logs}
            now={now}
            busy={busy}
            onAction={(action) => void run(action)}
            onOpenDataDir={() => void api.openDataDir()}
            onGotoProviders={() => setTab('providers')}
          />
        ) : tab === 'providers' ? (
          <Providers running={status.state === 'running'} />
        ) : tab === 'models' ? (
          <Models running={status.state === 'running'} />
        ) : tab === 'clients' ? (
          <Clients running={status.state === 'running'} />
        ) : tab === 'logs' ? (
          <Logs logs={logs} />
        ) : (
          <Settings status={status} theme={theme} onThemeChange={setTheme} />
        )}
      </main>
    </div>
  );
}
