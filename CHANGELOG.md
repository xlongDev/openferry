# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [Unreleased]

### Added

- `@openferry/clients`：客户端配置的原子写入、备份、冲突检测与失败还原；WorkBuddy 适配器。
- 迁移 v3：`client_entries`，记录哪些条目由 OpenFerry 写入。
- 桌面端「客户端」页：选择模型 → 预览变更 → 写入 → 备份与恢复。
- 写入必须先预览；预览后文件被外部修改会拒绝写入。

- `@openferry/capability-probes`：对话 / 流式 / 工具调用 / 参数完整性四类探测，结果带有效期。
- `@openferry/model-registry`：目录刷新（失败保留旧目录）、`ModelView` 组装（能力 + 过期 + 价格状态）。
- 迁移 v2：`models`、`probe_runs` 表与索引。
- 桌面端「模型」页：刷新目录、按供应商筛选、搜索、单项检测、能力徽章。
- `@openferry/storage`：`node:sqlite` 数据库、版本化迁移（事务 + 失败回滚）、`ProviderRepository`。
- `@openferry/secrets`：`SecretStore` 抽象、内存实现、文件实现（CLI 兜底，0600）。
- 桌面端供应商管理：新建 / 编辑 / 停用 / 删除 / 连接测试，密钥写入系统凭据存储。
- 网关 `setProviders()`：配置变更即时生效，不需要重启网关。
- 首次运行从旧 `config.json` 导入一次供应商（数据库为空时）。

### Changed

- 概览页拆分为独立组件；「供应商」「模型」导航项已启用。
- 删除供应商或修改端点时，级联清理模型目录与探测记录。
- `@openferry/testkit` 支持 `route(request)` 按请求内容选响应（并发测试不再依赖脚本顺序）。
- 密钥 API 改用 Electron 45 的异步变体（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`）。

### Security

- 数据库只存 `credentialRef`，不存密钥；有测试断言表里查不到 `sk-…` 形态的字符串。
- 系统凭据存储不可用时拒绝保存密钥，不退回明文文件。

## [0.1.0] - 2026-11-02

首个骨架版本。目标是把「协议正确 + 安全边界 + 可测试」的地基打好，而不是堆功能。

### Added

- pnpm monorepo：`core`、`protocols/canonical`、`protocols/openai-chat`、`providers/contract`、`providers/openai-compatible`、`config-manager`、`gateway`、`testkit`。
- Canonical Model：请求 / 响应 / 流式事件 / usage / 能力声明 / 模型描述符，带 Zod 校验。
- OpenAI Chat Completions 双向编解码：文本、图像、工具调用、工具结果、结构化输出、结束原因。
- 增量 SSE 解析器：跨块事件、多事件合块、CRLF/LF、注释行、EOF 无空行、多行 data。
- 网关：`/healthz`、`/readyz`、`/v1/models`、`/v1/chat/completions`。
- 安全边界：Bearer 认证（定长比较）、Host 白名单、浏览器来源拦截、1 MiB 体积上限、并发闸门、连接 / 首事件 / 总时长三层超时、客户端断开取消上游。
- 上游地址守卫：拒绝非 http(s)、云元数据、link-local、保留地址；loopback / 私网需显式放行；识别整型与十六进制形式的 loopback。
- 结构化日志与脱敏：键名匹配、Bearer 前缀、URL query、常见供应商密钥前缀。
- 假上游 `@openferry/testkit`：脚本化响应、分片、断流、慢响应、非法 JSON。
- Electron 桌面应用：主进程内嵌网关、沙箱化 preload、受限 IPC（Zod 校验 + 发送方校验）、概览页展示真实状态并可启停。
- 文档：架构总览、模块边界、协议兼容矩阵、威胁模型、安全策略、测试策略、平台支持、路线图、4 篇 ADR、OC Ferry 研究笔记。
- GitHub Actions：格式 / 类型 / lint / 测试、模块边界检查、依赖审计、三平台桌面构建尝试。

### Known limitations

- 无持久化：供应商配置来自 `~/.openferry/config.json`，重启后状态不保留。
- 无客户端配置写入、无能力探测、无路由策略。
- 桌面端只有概览页，其余页面在导航里明确标记为未实现。
- 平台验证只有 macOS arm64。
- 供应商 URL 未做连接时 DNS 固定，DNS rebinding 未被完全阻断。

### Security

- 本地端口默认仅监听 loopback，默认要求 Token。
- 上游 401/403 的响应体不进入错误消息。
- 渲染进程 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，拒绝一切导航与新窗口。
