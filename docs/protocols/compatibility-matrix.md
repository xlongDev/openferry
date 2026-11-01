# 协议兼容矩阵

> 状态：v0.1。**只列出已实现并通过测试的能力**；未实现的能力标为「未实现」，不做任何兼容性承诺。

## 1. 网关入口协议

| 能力                        | OpenAI Chat Completions | 说明                                                                                 |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| 非流式请求                  | 已实现                  | `POST /v1/chat/completions`，`stream` 缺省或 `false`                                 |
| SSE 流式                    | 已实现                  | `stream: true`，`text/event-stream`                                                  |
| 工具调用                    | 已实现                  | `tools` / `tool_choice` / `tool_calls` / `role: "tool"`                              |
| 工具参数分片                | 已实现                  | `tool_calls[i].function.arguments` 增量拼接                                          |
| 模型列表                    | 已实现                  | `GET /v1/models`，聚合所有启用的供应商                                               |
| 图像输入                    | 部分实现                | `image_url`（`http(s)` 与 `data:`）可解析为 Canonical；上游支持情况由供应商能力决定  |
| 结构化输出                  | 部分实现                | `response_format.json_object` 透传；`json_schema` 透传，上游不支持时报 `unsupported` |
| usage                       | 已实现                  | `prompt_tokens` / `completion_tokens` / `total_tokens` 映射到 `CanonicalUsage`       |
| 请求取消                    | 已实现                  | 客户端断开 → 上游 `AbortSignal`                                                      |
| `n > 1`                     | **拒绝**                | 返回 `invalid_request`，不静默只返回第一条                                           |
| `logprobs`                  | **拒绝**                | 返回 `invalid_request`（无法在 Canonical 中无损表达）                                |
| `audio` / `modalities`      | **拒绝**                | 同上                                                                                 |
| `/v1/responses`             | 未实现                  | 计划阶段 4；与 Chat Completions **不是**同一协议                                     |
| `/v1/messages`（Anthropic） | 未实现                  | 计划阶段 4                                                                           |

### 拒绝策略的语义

「拒绝」= 在解析阶段返回 `400 invalid_request`，并在 `error.message` 中指明字段名。**不静默丢弃**——静默丢弃会让客户端以为功能生效，属于最坏的一类 bug。

## 2. 供应商方向

| 上游类型                                              | 状态   | 备注                                           |
| ----------------------------------------------------- | ------ | ---------------------------------------------- |
| OpenAI 兼容（`/v1/chat/completions`）                 | 已实现 | 含流式、工具调用、错误映射                     |
| 本地推理服务（Ollama / LM Studio 等 OpenAI 兼容模式） | 已实现 | 通过 SSRF 白名单显式放行 `127.0.0.1`/局域网    |
| Anthropic Messages 原生                               | 未实现 | 需要独立适配器，不做字段重命名                 |
| OpenAI Responses 原生                                 | 未实现 | 事件模型与 Chat Completions 不同，需独立适配器 |

## 3. SSE 边界覆盖表

每一条都有对应测试（`packages/protocols/openai-chat/test/sse.test.ts`）。

| 边界                     | 状态                                           |
| ------------------------ | ---------------------------------------------- |
| 一个事件跨多个网络数据块 | 已覆盖                                         |
| 多个事件合并在一个数据块 | 已覆盖                                         |
| CRLF / LF 混用           | 已覆盖                                         |
| 注释行（`:` 开头）忽略   | 已覆盖                                         |
| 非法 JSON 载荷           | 已覆盖（产出 `ProtocolError`，不抛到进程顶层） |
| 工具参数分片             | 已覆盖                                         |
| 重复 `[DONE]`            | 已覆盖（幂等）                                 |
| 上游断流（无 `[DONE]`）  | 已覆盖（判定为 `upstream_error`）              |
| 客户端断开               | 已覆盖（集成测试，断言上游被 abort）           |
| 首事件超时               | 已覆盖（`firstEventTimeoutMs`）                |
| 连接超时                 | 已覆盖（`connectTimeoutMs`）                   |

## 4. Canonical Model 的字段损失策略

| Canonical 字段                   | OpenAI Chat 映射                            | 无法映射时                             |
| -------------------------------- | ------------------------------------------- | -------------------------------------- |
| `text`                           | `content` 字符串 / `content[].text`         | —                                      |
| `image`                          | `image_url`                                 | 上游不支持 → `unsupported`             |
| `tool_call`                      | `assistant.tool_calls[]`                    | —                                      |
| `tool_result`                    | `role: "tool"` 消息                         | 无 `tool_call_id` → `invalid_request`  |
| `finishReason: "tool_calls"`     | `finish_reason: "tool_calls"`               | —                                      |
| `finishReason: "content_filter"` | `finish_reason: "content_filter"`           | —                                      |
| `usage.cachedInputTokens`        | `prompt_tokens_details.cached_tokens`       | 上游缺失 → `undefined`（不填 0）       |
| `extensions`                     | 原样透传至上游 `x_openferry` 之外的未知字段 | 上游不认则丢弃，并在 `warnings` 中记录 |

`usage` 缺失时字段为 `undefined` 而不是 `0`：`0` 是一个断言，`undefined` 是「不知道」，两者不能混用。
