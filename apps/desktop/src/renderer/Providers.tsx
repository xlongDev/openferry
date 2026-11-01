import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ProviderDraft, ProviderTestResult, ProviderView } from './types.js';

const EMPTY_DRAFT: ProviderDraft = {
  id: '',
  displayName: '',
  baseUrl: '',
  apiKey: '',
  allowPrivateNetwork: false,
};

interface EditorState {
  mode: 'create' | 'edit';
  originalId: string;
  draft: ProviderDraft;
}

function draftFrom(provider: ProviderView): ProviderDraft {
  return {
    id: provider.id,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    apiKey: '',
    allowPrivateNetwork: provider.allowPrivateNetwork,
  };
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Electron 把 IPC 的 Error 包成 "Error invoking remote method '...': Error: 真实信息"
  const match = /Error:\s*(.+)$/.exec(raw);
  return match?.[1]?.trim() ?? raw;
}

export function Providers({ running }: { running: boolean }): JSX.Element {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ProviderTestResult>>({});
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const api = window.openferry;

  const refresh = useCallback(async () => {
    try {
      setProviders(await api.providers.list());
    } catch (error) {
      setFormError(errorMessage(error));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openCreate = (): void => {
    setFormError(null);
    setEditor({ mode: 'create', originalId: '', draft: { ...EMPTY_DRAFT } });
  };

  const openEdit = (provider: ProviderView): void => {
    setFormError(null);
    setEditor({ mode: 'edit', originalId: provider.id, draft: draftFrom(provider) });
  };

  const patchDraft = (patch: Partial<ProviderDraft>): void => {
    setEditor((current) =>
      current ? { ...current, draft: { ...current.draft, ...patch } } : current,
    );
  };

  const save = async (): Promise<void> => {
    if (!editor) return;
    setBusy('save');
    setFormError(null);
    try {
      if (editor.mode === 'create') {
        const next = await api.providers.create(editor.draft);
        setProviders(next);
      } else {
        const next = await api.providers.update({
          id: editor.originalId,
          patch: {
            displayName: editor.draft.displayName,
            baseUrl: editor.draft.baseUrl,
            allowPrivateNetwork: editor.draft.allowPrivateNetwork,
          },
          // 留空 = 不改密钥；填了才覆盖。
          ...(editor.draft.apiKey.length > 0 ? { apiKey: editor.draft.apiKey } : {}),
        });
        setProviders(next);
      }
      setEditor(null);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const test = async (
    key: string,
    input: { baseUrl: string; apiKey?: string; allowPrivateNetwork?: boolean },
  ): Promise<void> => {
    setBusy(`test:${key}`);
    try {
      const result = await api.providers.test(input);
      setTests((current) => ({ ...current, [key]: result }));
    } catch (error) {
      setTests((current) => ({
        ...current,
        [key]: { ok: false, models: 0, durationMs: 0, error: errorMessage(error) },
      }));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (provider: ProviderView): Promise<void> => {
    setBusy(`toggle:${provider.id}`);
    try {
      setProviders(
        await api.providers.update({ id: provider.id, patch: { enabled: !provider.enabled } }),
      );
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(`remove:${id}`);
    try {
      setProviders(await api.providers.remove(id));
      setConfirmingDelete(null);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <h2 className="section-title">供应商</h2>
          <p className="section-sub">
            密钥保存在系统凭据存储里，数据库只记引用名。改动即时生效，不需要重启网关。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={openCreate}
          disabled={editor !== null}
        >
          添加供应商
        </button>
      </div>

      {!running ? (
        <div className="banner banner-warn">
          <span>网关未运行。配置可以保存，但要等网关启动后才会被使用。</span>
        </div>
      ) : null}

      {formError ? (
        <div className="banner banner-error" role="alert">
          <span>{formError}</span>
        </div>
      ) : null}

      {editor ? (
        <div className="card form-card">
          <div className="card-head">
            <h3>{editor.mode === 'create' ? '新建供应商' : `编辑 ${editor.originalId}`}</h3>
          </div>

          <div className="form-grid">
            <label className="field">
              <span className="field-label">ID</span>
              <input
                className="input mono"
                value={editor.draft.id}
                disabled={editor.mode === 'edit'}
                placeholder="openai"
                onChange={(event) => patchDraft({ id: event.target.value })}
              />
              <span className="field-hint">
                小写字母、数字、下划线、连字符。模型 ID 会以它为前缀。
              </span>
            </label>

            <label className="field">
              <span className="field-label">显示名称</span>
              <input
                className="input"
                value={editor.draft.displayName}
                placeholder="OpenAI"
                onChange={(event) => patchDraft({ displayName: event.target.value })}
              />
            </label>

            <label className="field field-wide">
              <span className="field-label">Base URL</span>
              <input
                className="input mono"
                value={editor.draft.baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => patchDraft({ baseUrl: event.target.value })}
              />
              <span className="field-hint">
                指向 API 根路径。本地服务（如 Ollama）需要同时打开下面的私网开关。
              </span>
            </label>

            <label className="field field-wide">
              <span className="field-label">API Key</span>
              <input
                className="input mono"
                type="password"
                value={editor.draft.apiKey}
                placeholder={editor.mode === 'edit' ? '留空表示不修改' : 'sk-...'}
                onChange={(event) => patchDraft({ apiKey: event.target.value })}
              />
              <span className="field-hint">
                {editor.mode === 'edit'
                  ? '只有填了新值才会覆盖已保存的密钥。'
                  : '写入系统凭据存储，不进入数据库、日志或诊断报告。'}
              </span>
            </label>

            <label className="checkbox field-wide">
              <input
                type="checkbox"
                checked={editor.draft.allowPrivateNetwork}
                onChange={(event) => patchDraft({ allowPrivateNetwork: event.target.checked })}
              />
              <span>允许访问本机与局域网地址</span>
              <span className="field-hint">默认拒绝，防止供应商地址被指向内网服务。</span>
            </label>
          </div>

          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={busy !== null}
            >
              {busy === 'save' ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null || editor.draft.baseUrl.length === 0}
              onClick={() =>
                void test('draft', {
                  baseUrl: editor.draft.baseUrl,
                  ...(editor.draft.apiKey.length > 0 ? { apiKey: editor.draft.apiKey } : {}),
                  allowPrivateNetwork: editor.draft.allowPrivateNetwork,
                })
              }
            >
              {busy === 'test:draft' ? '测试中…' : '测试连接'}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setEditor(null)}
              disabled={busy !== null}
            >
              取消
            </button>
            <span className="spacer" />
            {tests['draft'] ? <TestBadge result={tests['draft']} /> : null}
          </div>
        </div>
      ) : null}

      <div className="card">
        {providers.length === 0 ? (
          <div className="empty">
            <p>还没有供应商。</p>
            <p className="empty-hint">
              添加一个 OpenAI 兼容端点就能开始转发请求。本地模型选「允许私网」。
            </p>
          </div>
        ) : (
          <ul className="provider-table">
            {providers.map((provider) => {
              const result = tests[provider.id];
              const isBusy = busy?.endsWith(provider.id) === true;
              return (
                <li
                  key={provider.id}
                  className={`provider-item ${provider.enabled ? '' : 'is-off'}`}
                >
                  <div className="provider-main">
                    <span
                      className={`dot ${provider.enabled ? 'dot-on' : 'dot-off'}`}
                      aria-hidden="true"
                    />
                    <div className="provider-text">
                      <div className="provider-title">
                        <span>{provider.displayName}</span>
                        <span className="mono provider-id">{provider.id}</span>
                        {provider.hasCredential ? (
                          <span className="tag">已存密钥</span>
                        ) : (
                          <span className="tag tag-muted">无密钥</span>
                        )}
                        {provider.allowPrivateNetwork ? (
                          <span className="tag tag-muted">私网</span>
                        ) : null}
                      </div>
                      <div className="mono provider-url">{provider.baseUrl}</div>
                    </div>
                  </div>

                  <div className="provider-side">
                    {result ? <TestBadge result={result} /> : null}
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={isBusy}
                      onClick={() =>
                        void test(provider.id, {
                          id: provider.id,
                          baseUrl: provider.baseUrl,
                          allowPrivateNetwork: provider.allowPrivateNetwork,
                        })
                      }
                    >
                      {busy === `test:${provider.id}` ? '测试中…' : '测试'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={isBusy}
                      onClick={() => openEdit(provider)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={isBusy}
                      onClick={() => void toggle(provider)}
                    >
                      {provider.enabled ? '停用' : '启用'}
                    </button>
                    {confirmingDelete === provider.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          disabled={isBusy}
                          onClick={() => void remove(provider.id)}
                        >
                          确认删除
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-quiet"
                          onClick={() => setConfirmingDelete(null)}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-small btn-quiet"
                        disabled={isBusy}
                        onClick={() => setConfirmingDelete(provider.id)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="section-note">
        删除供应商会同时删除它的密钥。测试连接会真实请求上游的 <span className="mono">/models</span>
        ，可能产生少量调用。
      </p>
    </section>
  );
}

function TestBadge({ result }: { result: ProviderTestResult }): JSX.Element {
  if (result.ok) {
    return (
      <span className="test-badge test-ok">
        可用 · {result.models} 个模型 · {result.durationMs}ms
      </span>
    );
  }
  return (
    <span className="test-badge test-fail" title={result.error}>
      失败：{result.error ?? '未知错误'}
    </span>
  );
}
