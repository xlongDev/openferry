import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { ClientPlan, ClientState, ModelView, PlanAction } from './types.js';

const ACTION_LABEL: Record<PlanAction, string> = {
  add: '新增',
  update: '更新',
  remove: '移除',
  unchanged: '不变',
  conflict: '跳过',
};

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /Error:\s*(.+)$/.exec(raw);
  return match?.[1]?.trim() ?? raw;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}

export function Clients({ running }: { running: boolean }): JSX.Element {
  const [client, setClient] = useState<ClientState | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<ClientPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState<string | null>(null);

  const api = window.openferry;

  const load = useCallback(async () => {
    try {
      const [nextClient, nextModels] = await Promise.all([api.clients.state(), api.models.list()]);
      setClient(nextClient);
      setModels(nextModels);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = useMemo(() => models.filter((model) => model.accessible !== false), [models]);

  const toggle = (id: string): void => {
    setPlan(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const preview = async (): Promise<void> => {
    setBusy('preview');
    setError(null);
    setNotice(null);
    try {
      setPlan(await api.clients.preview([...selected]));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const apply = async (): Promise<void> => {
    setBusy('apply');
    setError(null);
    try {
      const result = await api.clients.apply([...selected]);
      setClient(result.state);
      setPlan(null);
      setNotice('已写入。原文件已备份，可在下方恢复。');
    } catch (caught) {
      setError(errorMessage(caught));
      setPlan(null);
    } finally {
      setBusy(null);
    }
  };

  const restore = async (name: string): Promise<void> => {
    setBusy(`restore:${name}`);
    setError(null);
    try {
      setClient(await api.clients.restore(name));
      setPlan(null);
      setConfirmingRestore(null);
      setNotice('已从备份恢复。恢复前的状态也做了备份。');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const counts = useMemo(() => {
    const result: Record<PlanAction, number> = {
      add: 0,
      update: 0,
      remove: 0,
      unchanged: 0,
      conflict: 0,
    };
    for (const item of plan?.items ?? []) result[item.action] += 1;
    return result;
  }, [plan]);

  const changed = counts.add + counts.update + counts.remove;

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <h2 className="section-title">客户端</h2>
          <p className="section-sub">
            把网关里的模型写进客户端配置。写之前先备份，写之后重新读取校验；你手写的条目不会被覆盖。
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void load()} disabled={busy !== null}>
          重新读取
        </button>
      </div>

      {error ? (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="banner banner-info">
          <span>{notice}</span>
        </div>
      ) : null}
      {client?.error ? (
        <div className="banner banner-warn">
          <span>{client.error}</span>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>WorkBuddy</h2>
          <span className="mono subtle">{client?.path ?? '—'}</span>
        </div>

        <div className="metrics">
          <div className="metric">
            <span className="metric-label">文件</span>
            <span className="metric-value">{client?.exists ? '存在' : '不存在'}</span>
            <span className="metric-hint">{client?.readable ? '可读' : '无法解析'}</span>
          </div>
          <div className="metric">
            <span className="metric-label">条目总数</span>
            <span className="metric-value">{client?.entryCount ?? 0}</span>
          </div>
          <div className="metric">
            <span className="metric-label">OpenFerry 写入</span>
            <span className="metric-value">{client?.ownedIds.length ?? 0}</span>
            <span className="metric-hint">删除时只动这些</span>
          </div>
          <div className="metric">
            <span className="metric-label">备份</span>
            <span className="metric-value">{client?.backups.length ?? 0}</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>选择要写入的模型</h2>
          <span className="subtle">
            已选 {selected.size} / 可选 {candidates.length}
          </span>
        </div>

        {candidates.length === 0 ? (
          <div className="empty">
            <p>还没有可写入的模型。</p>
            <p className="empty-hint">
              先到「模型」页刷新目录并做一次检测；未通过检测的模型不会出现在这里。
            </p>
          </div>
        ) : (
          <ul className="pick-list">
            {candidates.map((model) => (
              <li key={model.id}>
                <label className="pick-row">
                  <input
                    type="checkbox"
                    checked={selected.has(model.id)}
                    onChange={() => toggle(model.id)}
                  />
                  <span className="pick-name">{model.displayName}</span>
                  <span className="mono subtle">{model.id}</span>
                  <span className={`cap ${model.accessible ? 'cap-pass' : 'cap-none'}`}>
                    {model.accessible ? '已验证' : '未检测'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null || selected.size === 0 || !running}
            onClick={() => void preview()}
          >
            {busy === 'preview' ? '计算中…' : '预览变更'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || plan === null || changed === 0}
            onClick={() => void apply()}
          >
            {busy === 'apply' ? '写入中…' : '写入客户端'}
          </button>
          <span className="spacer" />
          {!running ? <span className="subtle">网关未运行，无法写入</span> : null}
        </div>
      </div>

      {plan ? (
        <div className="card">
          <div className="card-head">
            <h2>变更预览</h2>
            <span className="subtle">
              新增 {counts.add} · 更新 {counts.update} · 移除 {counts.remove} · 不变{' '}
              {counts.unchanged} · 跳过 {counts.conflict}
            </span>
          </div>

          {plan.warnings.length > 0 ? (
            <div className="banner banner-warn">
              <span>{plan.warnings.join('；')}</span>
            </div>
          ) : null}

          <ul className="diff-list">
            {plan.items
              .filter((item) => item.action !== 'unchanged')
              .map((item) => (
                <li key={item.id} className="diff-row">
                  <span className={`diff-tag diff-${item.action}`}>
                    {ACTION_LABEL[item.action]}
                  </span>
                  <span className="mono">{item.id}</span>
                  {item.note ? <span className="subtle">{item.note}</span> : null}
                </li>
              ))}
          </ul>

          {changed === 0 ? (
            <p className="empty">没有需要写入的变更，文件已经是最新的。</p>
          ) : (
            <p className="section-note">
              写入前会把当前文件复制到备份目录。如果你在预览之后改过这个文件，写入会被拒绝，需要重新预览。
            </p>
          )}
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>备份</h2>
          <span className="subtle">{client?.backups.length ?? 0} 份</span>
        </div>

        {client && client.backups.length > 0 ? (
          <ul className="backup-list">
            {client.backups.map((backup) => (
              <li key={backup.name} className="backup-row">
                <span className="mono subtle">{backup.name}</span>
                <span className="subtle">{formatTime(backup.createdAt)}</span>
                <span className="subtle">{backup.size} B</span>
                {confirmingRestore === backup.name ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      disabled={busy !== null}
                      onClick={() => void restore(backup.name)}
                    >
                      确认恢复
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-quiet"
                      onClick={() => setConfirmingRestore(null)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy !== null}
                    onClick={() => setConfirmingRestore(backup.name)}
                  >
                    恢复
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">还没有备份。第一次写入时会自动生成。</p>
        )}
      </div>

      <p className="section-note">
        写入的条目使用网关地址与网关 Token，因此这些模型只能在本机通过 OpenFerry 调用。 条目字段（id
        / name / url / apiKey / local）来自 WorkBuddy 自身的报错与清理逻辑，
        <strong>尚未用真实的非空配置文件验证过应用是否接受</strong> ——
        写入前请先看预览，并保留备份。
      </p>
    </section>
  );
}
