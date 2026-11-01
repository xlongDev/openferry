# Security Policy

## 报告漏洞

请不要开公开 issue。用 GitHub 的 private vulnerability reporting（仓库 Security 标签页）提交，或者直接联系维护者。

请包含：

- 受影响的版本或 commit
- 复现步骤（最小可用）
- 影响范围（能否读取文件、消耗额度、绕过认证等）
- 你的环境（OS、Node 版本）

## 支持范围

只处理最新发布版本。预发布版本按尽力而为处理。

## 已知限制（不是漏洞，但你需要知道）

这些是**有意接受**的风险，已经在 `docs/security/threat-model.md` 里记录：

1. **同机进程可以读取网关 Token 文件。** 我们没有内核级隔离手段。Token 文件权限是 `0600`，但同用户的进程仍可读。
2. **供应商 URL 的 DNS rebinding 防护不完整。** 目前做的是字面量与主机名级别的守卫，没有在连接时固定解析后的 IP。
3. **不做代码签名。** macOS 首次打开需要右键 →「打开」。
4. **不实现插件沙箱。** 首版没有第三方插件机制。

## 设计上的安全承诺

- 默认只监听 `127.0.0.1`。
- 默认要求 Bearer Token。
- 带 `Origin` / `Referer` / `Sec-Fetch-Site` 头的请求一律拒绝（本地端口不给浏览器用）。
- 日志不记录提示词、模型输出、Authorization、API Key。
- 上游返回 401/403 时，不把上游 body 写进错误消息。
- 渲染进程 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
