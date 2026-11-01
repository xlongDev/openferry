# 贡献指南

## 环境

- Node.js >= 22.12
- pnpm 12
- macOS / Linux / Windows 均可开发，但平台验证见 `docs/release/platform-support.md`

```bash
pnpm install
pnpm build
pnpm test
```

## 提交前

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

四条全绿。**不要**在 PR 描述里写没有实际运行的命令或结果。

## 代码约定

- TypeScript strict，`verbatimModuleSyntax`；相对导入带 `.js` 后缀（NodeNext 要求）。
- 跨模块的错误只用 `ProtocolError`，并带上 `code`。
- 新增协议：在 `packages/protocols/<name>` 里实现 decode/encode，不要改其他协议。
- 新增供应商：实现 `ProviderAdapter`，并补一个基于 `@openferry/testkit` 的契约测试。
- 不新增依赖，除非标准库做不到；PR 里说明理由、体积、维护状态。

## 测试要求

- 新功能 → 新测试；修 bug → 先写会失败的回归测试。
- 测试默认不联网。需要真实 API Key 的验证放 `tests/live/`，不进 CI 门禁。
- 网关测试必须走真实 HTTP（随机端口），不要 mock 掉传输层。

## 安全红线

- 不把监听地址改成 `0.0.0.0`。
- 不记录 prompt、completion、`Authorization`、API Key。
- 不把上游 401/403 的响应体写进错误消息（上游常在 body 里回显密钥）。
- 渲染进程不引入 Node 内置模块。

## 提交流程

1. 从 `main` 切分支：`feat/*`、`fix/*`、`docs/*`。
2. 一个提交只做一件事，信息写清楚改了什么、为什么。
3. 确认 `git diff` 里没有密钥、临时文件、构建产物。
4. 提交前获得维护者确认（本仓库的协作约定）。

## Electron 安装问题

访问不了 GitHub Releases 时，Electron 二进制不会下载成功，但 `pnpm install` 不会报错。补装：

```bash
cd apps/desktop/node_modules/electron
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
```

## 目录约定

见 `AGENTS.md` 的「目录速查」。新增包之前先读 `docs/architecture/module-boundaries.md` 的准入门槛。
