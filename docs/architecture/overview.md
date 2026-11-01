# 架构总览

> 状态：v0.1 骨架实现。最后核对：2026-11-02。

## 1. 一句话定位

OpenFerry 是一个**本地优先**的 AI 编程工具网关：它把多个模型供应商（含本地推理服务）收敛成一条 OpenAI 兼容入口，让多个 AI 编程客户端只需要配置一个地址就能用上全部模型，并且能安全地管理这些客户端自己的配置文件。

与参考项目 [OC Ferry](../research/oc-ferry.md) 的差别：

| 维度     | OC Ferry                            | OpenFerry                                 |
| -------- | ----------------------------------- | ----------------------------------------- |
| 上游来源 | 仅托管的一份隔离 OpenCode           | 任意 OpenAI 兼容供应商 + 本地服务，可并存 |
| 协议     | OpenAI Chat Completions（信封翻译） | Canonical Model + 多协议适配器            |
| 客户端   | WorkBuddy / DSH 二选一写入          | 客户端适配器接口，按客户端独立实现与验证  |
| 状态存储 | JSON 文件 + 判定缓存                | SQLite（版本化迁移）+ 凭据独立存放        |
| 形态     | 托盘应用 + 后台服务                 | 桌面应用 + 可独立运行的 `gateway-cli`     |

## 2. 分层

```
┌──────────────────────────────────────────────────────────┐
│  apps/desktop        Electron main / preload / renderer  │
│  apps/gateway-cli    无界面运行入口                        │
└───────────────┬──────────────────────────────────────────┘
                │ 只经由 @openferry/gateway 的公开接口
┌───────────────▼──────────────────────────────────────────┐
│  @openferry/gateway   路由 / 认证 / 限流 / 超时 / SSE 出口 │
└───────┬───────────────────────────┬──────────────────────┘
        │                           │
┌───────▼─────────┐        ┌────────▼─────────────────────┐
│ protocols/*     │        │ providers/*                  │
│ 线格式 ⇄ Canonical│        │ Canonical ⇄ 上游 HTTP         │
└───────┬─────────┘        └────────┬─────────────────────┘
        │                           │
┌───────▼───────────────────────────▼──────────────────────┐
│  @openferry/canonical   Canonical Model（唯一事实来源）    │
│  @openferry/core        错误分类 / 脱敏 / 日志 / 网络守卫   │
└──────────────────────────────────────────────────────────┘
```

依赖方向是单向的：**越靠下越不知道上层存在**。`core` 与 `canonical` 不依赖任何包以外的运行时（Node 标准库除外），因此可以被任意宿主复用。

## 3. 一次请求的生命周期

1. 客户端 `POST /v1/chat/completions`，带 `Authorization: Bearer <token>`。
2. 网关依次执行：Host 校验 → Origin 拒绝 → Token 校验 → 体积限制 → 并发闸门。
3. `protocols/openai-chat` 把线上 JSON 解析为 `CanonicalRequest`；无法无损表达的字段按[兼容矩阵](../protocols/compatibility-matrix.md)的策略**拒绝或显式降级**，不静默丢弃。
4. 路由表把 `model` 映射到 `(providerId, upstreamModelId)`。
5. 供应商适配器把 `CanonicalRequest` 序列化成上游格式，带 `AbortSignal` 发出。
6. 响应按流式或非流式转回 Canonical，再由 `protocols/openai-chat` 编码成客户端期望的线格式。
7. 客户端断开 → `AbortSignal` 触发 → 上游请求被取消，连接释放。

## 4. 关键设计取舍

- **网关核心不依赖 Electron。** `gateway-cli` 与桌面应用共用同一个 `createGateway()`。
- **Canonical Model 是唯一事实来源。** 任何协议转换都以它为中转，禁止协议之间直接对拷 JSON。
- **流式一旦开始就不换供应商。** 已经向客户端吐出字节之后再故障转移会产生重复文本或重复工具调用，这比失败更糟。
- **错误分类先于错误文案。** 所有上游错误都映射为 `ProtocolError.code`，客户端据此决定是否重试。
- **不记录正文。** 日志只记录结构化元数据（请求 ID、供应商、模型、耗时、token 数、错误码）。

## 5. 当前实现范围（诚实清单）

已实现并有测试：

- `GET /healthz`、`GET /readyz`、`GET /v1/models`、`POST /v1/chat/completions`
- Bearer 认证、Host 校验、Origin 拒绝、请求体上限、并发闸门、上游超时、客户端断开取消
- Canonical Model 与 OpenAI Chat Completions 双向编解码
- SSE 解析（跨块事件、CRLF、多事件合块、`[DONE]`、非法 JSON、断流）
- 工具调用（含参数分片）在 Canonical ⇄ OpenAI 之间往返
- OpenAI 兼容供应商适配器、假上游测试服务器

尚未实现（见[路线图](../roadmap.md)）：

- 持久化（SQLite 迁移）、供应商/模型目录 UI、能力探测、客户端配置写入
- Responses API、Anthropic Messages 适配
- 路由策略、熔断、故障转移
- 桌面端除 Overview 外的页面
