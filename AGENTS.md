# AGENTS.md

给在本仓库工作的 AI Agent（以及新加入的人类）的操作手册。

## 开始任何任务前

1. `git status` —— 确认没有别人的未提交改动。**不得 reset / checkout / 删除**未提交文件。
2. 读相关文档：`docs/architecture/`、`docs/protocols/`、`docs/security/`。
3. 读相关包的 `src/` 与 `test/`，确认要改的行为是否已有实现（先审计，再动手）。
4. 明确验收条件：跑哪条命令、看到什么输出算完成。

## 完成任何任务前

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

四条全绿才算完成。**不得**在报告里写没有实际运行的命令或结果。

## 硬性约束

- **commit / push 前必须获得用户明确确认。** 改动留在工作区。
- 不新增依赖除非：标准库做不到 + 已在 PR 描述中说明理由。
- 不创建没有调用方的包或接口。
- 不在日志里打印 prompt、completion、Authorization、apiKey。
- 不把 `127.0.0.1` 改成 `0.0.0.0`，即使"只是测试"。
- 不声称未验证的平台支持或性能数字。

## 代码风格

- TypeScript strict，`verbatimModuleSyntax`；相对导入带 `.js` 后缀。
- 错误一律是 `ProtocolError`（`@openferry/core`），带 `code`，不用裸 `Error` 跨越模块边界。
- 注释解释**为什么**，不解释**是什么**。被否决的方案值得留一行注释。
- 中文注释与英文标识符混排是正常的，保持一致即可。

## 目录速查

| 想改什么            | 去哪                                   |
| ------------------- | -------------------------------------- |
| 错误码、脱敏、日志  | `packages/core`                        |
| Canonical 类型      | `packages/protocols/canonical`         |
| OpenAI 线格式 / SSE | `packages/protocols/openai-chat`       |
| 上游 HTTP           | `packages/providers/openai-compatible` |
| 路由、认证、限流    | `packages/gateway`                     |
| 假上游              | `packages/testkit`                     |
| 桌面 UI             | `apps/desktop/src/renderer`            |
| 架构决策            | `docs/adr/`（新增，不要改旧的）        |
