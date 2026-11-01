import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { CapabilityView, ModelView, ProbeKind, RefreshResult } from './types.js';

const PROBE_LABEL: Record<ProbeKind, string> = {
  chat: '对话',
  stream: '流式',
  tool_call: '工具',
  tool_args: '参数',
};

const PROBE_ORDER: ProbeKind[] = ['chat', 'stream', 'tool_call', 'tool_args'];

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /Error:\s*(.+)$/.exec(raw);
  return match?.[1]?.trim() ?? raw;
}

function timeAgo(iso: string | null): string {
  if (iso === null) return '从未';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function CapabilityChip({
  kind,
  capability,
}: {
  kind: ProbeKind;
  capability: CapabilityView | undefined;
}): JSX.Element {
  if (!capability) {
    return <span className="cap cap-none">{PROBE_LABEL[kind]}</span>;
  }
  const state = capability.expired ? 'stale' : capability.status;
  const title = [
    capability.evidence,
    capability.errorCode ? `错误码 ${capability.errorCode}` : null,
    capability.expired
      ? `结论已过期（${new Date(capability.expiresAt).toLocaleString('zh-CN')}）`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span className={`cap cap-${state}`} title={title}>
      {PROBE_LABEL[kind]}
    </span>
  );
}

export function Models({ running }: { running: boolean }): JSX.Element {
  const [models, setModels] = useState<ModelView[]>([]);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<RefreshResult[] | null>(null);

  const api = window.openferry;

  const load = useCallback(async () => {
    try {
      setModels(await api.models.list());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = useMemo(
    () => [...new Set(models.map((model) => model.providerId))].sort(),
    [models],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models.filter((model) => {
      if (providerFilter !== 'all' && model.providerId !== providerFilter) return false;
      if (needle.length === 0) return true;
      return (
        model.id.toLowerCase().includes(needle) || model.displayName.toLowerCase().includes(needle)
      );
    });
  }, [models, providerFilter, query]);

  const refresh = async (): Promise<void> => {
    setBusy('refresh');
    setError(null);
    try {
      const result = await api.models.refresh();
      setModels(result.models);
      setRefreshSummary(result.results);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const probe = async (modelId: string): Promise<void> => {
    setBusy(`probe:${modelId}`);
    setError(null);
    try {
      setModels(await api.models.probe(modelId));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const capabilityOf = (model: ModelView, kind: ProbeKind): CapabilityView | undefined =>
    model.capabilities.find((capability) => capability.probe === kind);

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <h2 className="section-title">模型目录</h2>
          <p className="section-sub">
            目录来自各供应商的 <span className="mono">/models</span>
            ；能力来自探测结果，带有效期，过期即失效。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void refresh()}
          disabled={busy !== null || !running}
          title={running ? undefined : '网关未运行'}
        >
          {busy === 'refresh' ? '刷新中…' : '刷新目录'}
        </button>
      </div>

      {!running ? (
        <div className="banner banner-warn">
          <span>网关未运行，无法刷新目录或探测能力。先到「概览」启动网关。</span>
        </div>
      ) : null}

      {error ? (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      {refreshSummary ? (
        <div className="banner banner-info">
          <span>
            {refreshSummary
              .map((result) =>
                result.ok
                  ? `${result.providerId}：+${result.added} / −${result.removed}，共 ${result.total}`
                  : `${result.providerId}：刷新失败（保留原有目录）`,
              )
              .join('　')}
          </span>
        </div>
      ) : null}

      {models.length > 0 ? (
        <div className="toolbar">
          <input
            className="input toolbar-search"
            placeholder="搜索模型名或 ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="filter-chips">
            <button
              type="button"
              className={`chip ${providerFilter === 'all' ? 'is-on' : ''}`}
              onClick={() => setProviderFilter('all')}
            >
              全部
            </button>
            {providers.map((id) => (
              <button
                key={id}
                type="button"
                className={`chip ${providerFilter === id ? 'is-on' : ''}`}
                onClick={() => setProviderFilter(id)}
              >
                {id}
              </button>
            ))}
          </div>
          <span className="subtle">
            {visible.length} / {models.length}
          </span>
        </div>
      ) : null}

      <div className="card">
        {models.length === 0 ? (
          <div className="empty">
            <p>目录还是空的。</p>
            <p className="empty-hint">
              先在「供应商」页添加一个端点，然后点「刷新目录」。刷新会真实请求上游的 /models。
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="empty">没有匹配的模型。换个关键词或筛选条件。</p>
        ) : (
          <ul className="model-table">
            {visible.map((model) => (
              <li key={model.id} className="model-item">
                <div className="model-main">
                  <div className="model-title">
                    <span>{model.displayName}</span>
                    <span className="tag tag-muted">{model.providerId}</span>
                  </div>
                  <div className="model-meta mono">
                    {model.id}
                    <span className="model-dot">·</span>
                    {model.priceStatus === 'unknown' ? '价格未知' : '有价格信息'}
                    <span className="model-dot">·</span>
                    目录更新 {timeAgo(model.observedAt)}
                  </div>
                </div>

                <div className="model-caps">
                  {PROBE_ORDER.map((kind) => (
                    <CapabilityChip key={kind} kind={kind} capability={capabilityOf(model, kind)} />
                  ))}
                </div>

                <div className="model-side">
                  <span className="subtle">检测 {timeAgo(model.lastProbedAt)}</span>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy !== null || !running}
                    onClick={() => void probe(model.id)}
                  >
                    {busy === `probe:${model.id}` ? '检测中…' : '检测'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="section-note">
        检测会真实发请求（对话 / 流式 / 工具调用各一次，工具与参数共用一次），会消耗少量额度。
        一次通过只代表「这一次能按协议产生动作」，不代表完整工作流稳定。
      </p>
    </section>
  );
}
