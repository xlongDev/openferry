# 阶段 1 报告：调研与工程骨架

日期：2026-11-02
环境：macOS 26 (Darwin 27.2.0) arm64，Node 22.22.2，pnpm 12.15.0，10 核 / 16 GB

## 起点

工作区为空，只有一个 `writing-block.md`（需求文档），没有 Git 仓库，没有既有代码。

## 交付内容

### 文档

| 文件 | 内容 |
| --- | --- |
| `docs/research/oc-ferry.md` | OC Ferry 的可验证事实、许可证（MIT）、自认限制、对 OpenFerry 的启示。每条都标了来源与验证状态 |
| `docs/architecture/overview.md` | 分层图、请求生命周期、设计取舍、实现范围清单 |
| `docs/architecture/module-boundaries.md` | 8 条硬性规则、包职责表、CI 可执行的边界检查 |
| `docs/protocols/compatibility-matrix.md` | 入口协议能力表、拒绝策略、SSE 边界覆盖表、字段损失策略 |
| `docs/security/threat-model.md` | 8 类威胁、缓解措施、明确接受的风险、复审触发条件 |
| `docs/security/security-policy.md` | 检查顺序、地址守卫规则、日志白名单、Electron 配置表 |
| `docs/testing/test-strategy.md` | 测试分层、每包最低要求、判定标准 |
| `docs/release/platform-support.md` | 平台矩阵（只记录实测）、发布门槛 |
| `docs/roadmap.md` | 6 个阶段 + 技术债优先级 |
| `docs/adr/0001..0004` | monorepo 构建、不用 Web 框架、Canonical 中转、无损失败策略 |

### 代码

11 个 workspace 项目。实际实现（不是空接口）：

- `@openferry/core` — 错误分类与 HTTP 状态映射、脱敏、结构化日志（带环形缓冲）、供应商 URL 守卫、定长比较。
- `@openferry/canonical` — 请求 / 响应 / 事件 / usage / 能力 / 模型描述符的 Zod Schema。
- `@openferry/protocol-openai-chat` — 双向编解码、增量 SSE 解析、流式解码器与编码器。
- `@openferry/provider-contract` — `ProviderAdapter` 与超时上下文。
- `@openferry/provider-openai-compatible` — 请求序列化、错误映射、流式解析、取消传播。
- `@openferry/gateway` — `node:http` 服务、认证、Host/Origin 围栏、体积与并发限制、三层超时、SSE 输出与背压。
- `@openferry/config-manager` — 配置文件解析、供应商构造、缺失凭据告警。
- `@openferry/testkit` — 脚本化假上游。
- `apps/gateway-cli` — 无界面启动入口。
- `apps/desktop` — Electron 主进程（内嵌网关、生命周期、IPC）、沙箱化 preload、React 概览页。

## 实际运行的命令与结果

```text
$ pnpm install
Scope: all 11 workspace projects
Done in 2.2s using pnpm v12.15.0
（Electron 二进制未能下载，见「已知问题」）

$ pnpm build          # tsc -b + vite build
vite v7.3.7 building client environment for production...
✓ 29 modules transformed.
dist/renderer/index.html  0.59 kB
dist/renderer/assets/*.css 7.17 kB
dist/renderer/assets/*.js 229.64 kB
✓ built in 444ms

$ pnpm test           # vitest run
Test Files  7 passed (7)
Tests       72 passed (72)
Duration    3.79s

$ pnpm lint           # eslint .
（0 problems）
```

## 桌面应用运行证据

```text
$ ./node_modules/.bin/electron . --no-sandbox --disable-gpu --remote-debugging-port=9222
DevTools listening on ws://127.0.0.1:9222/devtools/browser/…

$ curl 127.0.0.1:41980/healthz
{"status":"ok","version":"0.1.0","uptimeMs":6662}
```

通过 CDP 读取渲染结果：

```json
{
  "title": "OpenFerry",
  "heading": "概览",
  "statusPill": "运行中",
  "metrics": ["监听地址127.0.0.1:41980", "运行时长6s", "请求总数0", "处理中0", "失败请求0"],
  "nav": ["概览", "供应商未实现", "模型未实现", "客户端未实现", "日志未实现", "设置未实现"],
  "buttons": [
    { "label": "启动", "disabled": true },
    { "label": "停止", "disabled": false },
    { "label": "重启", "disabled": false }
  ],
  "bodyChars": 419
}
```

Console 异常：`[]`（无）。

## 测试覆盖的实际行为

- 非流式代理：内容、usage、上游收到的 `Authorization` 头。
- 流式：文本增量、`[DONE]` 终止、工具参数分片拼接后等于原始 JSON。
- 上游断流（无 `[DONE]`）被识别为错误事件，不是静默成功。
- SSE 非法 JSON 变成错误事件，进程不崩。
- 上游 429 → 429；上游 401 → 401 且响应体不含上游回显的密钥。
- 请求体超限 → 413；并发超限 → 429。
- 上游不响应 → 504（连接超时）。
- 首事件超时 → 504（即使适配器忽略 signal 继续产出事件也不接受）。
- 客户端断开 → 上游 stream 收到 abort，且没有继续完成。
- Origin / Sec-Fetch-Site / 非法 Host → 403。
- 日志与错误响应中不含 token、不含提示词。

## 未完成

- 持久化（SQLite）、凭据加密、供应商 CRUD UI。
- 客户端配置读写、能力探测、路由策略。
- 打包（`.app` / `.dmg` / NSIS）、签名、安装与卸载验证。
- Windows / Linux 任何形式的运行验证（CI 里只有构建尝试）。

## 已知风险

1. Electron 二进制在无法访问 GitHub Releases 的网络里会静默缺失，`pnpm install` 不报错 —— 已在 README 与 CONTRIBUTING 写明补装方式。
2. 受限环境下 Chromium 沙箱无法初始化，验证时用了 `--no-sandbox`。产品默认仍是 `sandbox: true`，但**当前环境无法证明沙箱在正常桌面下工作**。
3. 供应商 URL 未做连接时 DNS 固定，DNS rebinding 未完全阻断（威胁模型 T2/T3）。
4. `writing-block.md` 被 `prettier --write` 顺带格式化过一次（内容未变，仅空白差异），已加入 `.prettierignore`。

## 下一步

阶段 2 的协议与网关部分已随本阶段一并落地（因为只有 `/healthz` 的骨架没有验证价值）。下一步是阶段 3：SQLite 迁移 + 凭据存储 + 供应商 CRUD，把「配置只能靠手写 JSON」这件事解决掉。
