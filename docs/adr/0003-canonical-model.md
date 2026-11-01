# ADR 0003 — 以 Canonical Model 为唯一中转

- 状态：已接受
- 日期：2026-11-02

## 背景

要支持 N 个客户端协议 × M 个供应商协议。直连需要 N×M 个转换器，且每个转换器都要自己处理工具调用、usage、结束原因。

## 决策

所有转换经过 `@openferry/canonical`：

```
客户端线格式 ──decode──▶ CanonicalRequest ──encode──▶ 上游线格式
客户端线格式 ◀──encode── CanonicalResponse/Event ◀──decode── 上游线格式
```

## 关键约束

1. **Canonical 不是最小公分母。** 它保留供应商扩展字段（`extensions`），并在转换时把「无法表达」显式暴露为 `warnings` 或错误，而不是丢掉。
2. **`undefined` ≠ `0`。** 缺失的 usage 字段保持 `undefined`，因为「不知道」和「零」是不同的事实。
3. **流式事件是语义事件，不是线格式事件的别名。** `text_delta` / `tool_call_delta` / `content_block_stop` 的边界由 Canonical 定义，各协议自行映射。
4. 协议层不感知供应商；供应商层不感知客户端。

## 后果

- 新增一个协议 = 2 个函数（decode/encode），不碰其他协议。
- 代价：一次额外的对象分配。相对于网络延迟可以忽略（见阶段 5 基准）。
- 风险：Canonical 设计过窄会逼出「协议特例」。缓解方式是 `extensions` 通道 + 明确的拒绝策略，而不是偷偷加字段。
