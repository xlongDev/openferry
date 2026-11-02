import { useState } from 'react';
import type { JSX } from 'react';
import { saveTheme, type ThemePref } from './theme.js';
import type { StatusPayload } from './types.js';

const THEMES: Array<{ id: ThemePref; label: string }> = [
  { id: 'system', label: '跟随系统' },
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' },
];

export function Settings({
  status,
  theme,
  onThemeChange,
}: {
  status: StatusPayload;
  theme: ThemePref;
  onThemeChange(pref: ThemePref): void;
}): JSX.Element {
  const [exported, setExported] = useState<string | null>(null);

  const choose = (pref: ThemePref): void => {
    saveTheme(pref);
    onThemeChange(pref);
  };

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <h2 className="section-title">设置</h2>
          <p className="section-sub">
            这一页只包含已经接上真实逻辑的选项；其余项在实现之前不会出现在这里。
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>外观</h2>
        </div>
        <div className="filter-chips">
          {THEMES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`chip ${theme === item.id ? 'is-on' : ''}`}
              onClick={() => choose(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="section-note">主题选择保存在本机，重启后仍然生效。</p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>运行信息</h2>
        </div>
        <dl className="kv">
          <dt>版本</dt>
          <dd className="mono">{status.version}</dd>
          <dt>网关地址</dt>
          <dd className="mono">{status.url ?? '未监听'}</dd>
          <dt>数据库 schema</dt>
          <dd className="mono">v{status.schemaVersion}</dd>
          <dt>密钥存储</dt>
          <dd>
            {status.secretStore === 'encrypted' ? '系统凭据存储（已加密）' : status.secretStore}
          </dd>
          <dt>数据目录</dt>
          <dd className="mono wrap">{status.dataDir}</dd>
          <dt>CLI 配置文件</dt>
          <dd className="mono wrap">
            {status.configPath} {status.configExists ? '（存在）' : '（不存在）'}
          </dd>
        </dl>
        <div className="actions">
          <button type="button" className="btn" onClick={() => void window.openferry.openDataDir()}>
            打开数据目录
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              void window.openferry
                .exportDiagnostics()
                .then((result) => setExported(result.file))
                .catch(() => setExported(null))
            }
          >
            导出诊断报告
          </button>
        </div>
        {exported ? <p className="section-note">已导出：{exported}</p> : null}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>尚未实现</h2>
        </div>
        <ul className="plain-list">
          <li>网关端口修改（当前来自 `~/.openferry/config.json`，需重启生效）</li>
          <li>日志保留策略与自动清理</li>
          <li>开机自启、关闭窗口行为</li>
          <li>数据备份与整体恢复</li>
        </ul>
      </div>
    </section>
  );
}
