# OpenFerry

[![CI](https://github.com/xlongDev/openferry/actions/workflows/ci.yml/badge.svg)](https://github.com/xlongDev/openferry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4f.svg)](LICENSE)

本地优先的 AI 编程工具网关。把多个模型供应商（含本地推理服务）收敛成一条 OpenAI 兼容入口，让多个 AI 编程客户端只配置一个地址就能用上全部模型。

> **状态：v0.1.0 骨架版本。** 网关核心链路（协议、流式、工具调用、安全边界）已实现并有测试；持久化、客户端配置写入、能力探测与大部分桌面页面尚未实现。下面的「已实现 / 未实现」清单是准确的，请不要按路线图假设功能可用。

## 现在能做什么

- 启动一个只监听 `127.0.0.1` 的网关，带 Bearer 认证、Host 校验、浏览器来源拦截、体积与并发上限。
- 在桌面应用里增删改查供应商、切换启用状态、测试连接；密钥写进系统凭据存储，改动即时生效。
- 代理 OpenAI Chat Completions：非流式、SSE 流式、工具调用（含参数分片）、usage。
- 把上游的认证失败 / 限流 / 超时 / 断流映射成明确的错误码，且不泄露密钥。
- 客户端断开时取消上游请求并释放连接。
- 概览页展示真实网关状态，可启动 / 停止 / 重启，日志只记录结构化元数据。

## 现在还不能做什么

- 模型、客户端、设置页面（导航里标了「未实现」）。
- 模型目录缓存、能力探测、客户端配置导入 / 备份 / 恢复。
- Responses API、Anthropic Messages 适配。
- 路由策略、熔断、故障转移、重试。
- 打包安装包；Windows / Linux 运行验证。

完整清单见 [`docs/roadmap.md`](docs/roadmap.md)。

## 快速开始

```bash
pnpm install
pnpm build
pnpm test
```

需要 Node.js >= 22.12 与 pnpm 12。

### 配置供应商

**桌面应用**：打开「供应商」页，填 Base URL 和 API Key 即可。密钥进系统凭据存储（macOS Keychain / Windows DPAPI），数据库只记引用名。改完立刻生效。

**CLI**：读 `~/.openferry/config.json`（桌面端只在数据库为空时导入一次，之后以数据库为准）。

```json
{
  "port": 41980,
  "providers": [
    {
      "id": "openai",
      "type": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    {
      "id": "ollama",
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "allowPrivateNetwork": true
    }
  ]
}
```

访问本地模型必须显式打开 `allowPrivateNetwork`，这是 SSRF 防护的一部分。配置文件里不写明文密钥，只引用环境变量。

### 启动

```bash
# 桌面应用
pnpm desktop

# 无界面网关
OPENAI_API_KEY=sk-... pnpm gateway --config ~/.openferry/config.json
```

网关启动时会打印监听地址与 Token。Token 也保存在 `~/.openferry/token`（权限 `0600`）。

### 调用

```bash
curl http://127.0.0.1:41980/v1/chat/completions \
  -H "Authorization: Bearer $(cat ~/.openferry/token)" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

模型 ID 形如 `providerId/upstreamModelId`。只配置了一个供应商时可以省略前缀。

## 接口

| 方法 | 路径                   | 认证 | 说明                                   |
| ---- | ---------------------- | ---- | -------------------------------------- |
| GET  | `/healthz`             | 否   | 存活探针                               |
| GET  | `/readyz`              | 否   | 就绪探针（无供应商时 503）             |
| GET  | `/v1/models`           | 是   | 聚合各供应商的模型目录                 |
| POST | `/v1/chat/completions` | 是   | OpenAI Chat Completions，支持 `stream` |

带 `Origin` / `Referer` / `Sec-Fetch-Site` 头的请求一律 `403`：这个端口不给浏览器用。

## 设计要点

- **Canonical Model 是唯一中转。** 协议层与供应商层互不认识，新增协议只需 2 个函数。
- **无法无损转换就报错，不静默丢弃。** `n > 1`、`logprobs`、`audio` 直接 `400` 并点名字段。
- **流式开始后不换供应商。** 已经吐出的字节没法撤回，故障转移会产生重复内容。
- **`undefined ≠ 0`。** 上游没给 usage 时保持缺失，不填 0。
- **网关核心不依赖 Electron。** 同一个 `createGateway()` 跑在 CLI 和桌面主进程里。

更多见 `docs/architecture/overview.md` 与 `docs/adr/`。

## 仓库结构

```
apps/desktop          Electron 主进程 / preload / React 渲染层
apps/gateway-cli      无界面入口
packages/core         错误分类、脱敏、日志、地址守卫
packages/protocols    canonical / openai-chat
packages/providers    contract / openai-compatible
packages/gateway      HTTP 服务、认证、限流、超时
packages/storage      node:sqlite、版本化迁移、供应商仓储
packages/secrets      凭据存储抽象（桌面端接 safeStorage）
packages/config-manager  配置文件解析与供应商构造
packages/testkit      假上游
tests/integration     网关端到端测试
docs/                 架构、协议、安全、ADR、路线图
```

数据目录 `~/.openferry/`：

| 文件           | 内容                                               |
| -------------- | -------------------------------------------------- |
| `openferry.db` | 供应商配置（SQLite，不含密钥）                     |
| `secrets.json` | 加密后的密钥（base64，密钥本体由系统凭据存储保护） |
| `token`        | 网关访问 Token（0600）                             |
| `config.json`  | 可选的 CLI 配置，桌面端仅在首次运行导入            |

## 开发

```bash
pnpm format:check   # prettier
pnpm typecheck      # tsc -b（同时产出 dist）
pnpm lint           # eslint
pnpm test           # vitest，72 项，不联网
```

四条全绿才算完成一次改动。详见 [`AGENTS.md`](AGENTS.md) 与 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 已知问题

- **Electron 二进制下载**：`pnpm install` 在访问不了 GitHub Releases 的网络里会静默跳过 Electron 二进制。用镜像补装：

  ```bash
  cd apps/desktop/node_modules/electron
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
  ```

- **受限环境启动**：在禁止创建 Chromium 沙箱的环境里需要 `--no-sandbox` 才能启动。这是环境限制，不是应用默认值。
- 平台支持矩阵只记录实际验证过的结果，见 [`docs/release/platform-support.md`](docs/release/platform-support.md)。

## 许可

MIT
