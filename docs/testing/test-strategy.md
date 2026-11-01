# 测试策略

> 原则：**测试跑过才算完成**。任何"已实现"的声明都必须能指向一个可复现的命令。

## 1. 层级与位置

| 层级           | 位置                                     | 是否联网               | 运行命令                  |
| -------------- | ---------------------------------------- | ---------------------- | ------------------------- |
| 单元           | `packages/*/test/*.test.ts`              | 否                     | `pnpm test`               |
| 协议契约       | `packages/protocols/*/test/`             | 否                     | `pnpm test`               |
| 集成（假上游） | `tests/integration/`                     | 否（只连本机随机端口） | `pnpm test`               |
| 端到端         | `tests/e2e/`（Playwright）               | 否                     | `pnpm test:e2e`（阶段 3） |
| 故障注入       | `tests/fault-injection/`                 | 否                     | `pnpm test`               |
| 安全           | `packages/gateway/test/security.test.ts` | 否                     | `pnpm test`               |

**所有测试默认不联网。** 需要真实供应商的验证单独放在 `tests/live/`，默认跳过，且不得把结果写成 CI 门禁。

## 2. 每个包的最低要求

| 包                           | 必测内容                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `core`                       | 脱敏（嵌套、数组、URL query）、网络地址守卫（元数据/私网/协议）、错误分类映射      |
| `canonical`                  | Zod Schema 接受合法输入、拒绝畸形输入、拒绝策略字段                                |
| `protocol-openai-chat`       | 请求映射、响应映射、finish_reason 映射、usage 缺失时保持 `undefined`、SSE 全部边界 |
| `provider-openai-compatible` | 认证头、错误码映射（401/403/429/5xx）、超时、abort                                 |
| `gateway`                    | 认证、Host、Origin、体积、并发、超时、取消、路由、错误不外泄                       |
| `testkit`                    | 自身作为测试工具的可靠性（假上游能按脚本产出分片/断流/慢响应）                     |

## 3. 假上游（`@openferry/testkit`）

一个基于 `node:http` 的服务器，接受脚本化响应：

```ts
const upstream = await startFakeUpstream({
  script: [{ type: 'sse', chunks: ['data: {...}\n\n', 'data: [DO', 'NE]\n\n'] }],
});
```

支持：分片延迟、断流、非法 JSON、429/500、永不响应（测超时）、记录收到的请求头（用于断言密钥未泄露）。

**这是所有协议测试的地基**：没有它，测试就只能靠真实 API Key，那等于没有测试。

## 4. 判定标准

- 新增功能 → 新增测试；修 bug → 新增回归测试（先红后绿）。
- 覆盖率不作为门禁数字，但以下目录**不允许**有未覆盖分支：`core/redact.ts`、`core/net-guard.ts`、`protocols/openai-chat/sse.ts`、`gateway/auth.ts`。
- 测试里的时间断言使用假时钟或宽阈值，避免 CI 抖动。

## 5. 明确不做

- 不为了覆盖率写「调用一下不断言」的测试。
- 不 mock 到只剩自己跟自己对话 —— 网关测试必须走真实 HTTP（随机端口）。
- 不把「CI 绿了」当成「平台支持已验证」（见 [platform-support.md](../release/platform-support.md)）。
