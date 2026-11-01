# 阶段 4 报告：模型目录与能力探测

日期：2026-11-02
环境：macOS 26 arm64，Node 22.22.2，Electron 45.2.1

## 交付内容

### 迁移 v2

```sql
CREATE TABLE models (
  id TEXT PRIMARY KEY,              -- providerId/upstreamId
  provider_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL,             -- 数据来源，例如 upstream:/models
  observed_at TEXT NOT NULL,        -- 目录观测时间
  created_at INTEGER,
  owned_by TEXT,
  pricing_json TEXT,                -- NULL = 价格未知，不是 0
  last_probed_at TEXT,
  UNIQUE (provider_id, upstream_id)
);

CREATE TABLE probe_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  probe TEXT NOT NULL,              -- chat | stream | tool_call | tool_args
  status TEXT NOT NULL,             -- pass | fail | unsupported
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  evidence TEXT,
  expires_at TEXT NOT NULL,
  probe_version TEXT NOT NULL
);
```

### 新增包

| 包 | 职责 |
| --- | --- |
| `@openferry/capability-probes` | 四类探测、结果有效期策略、`PROBE_VERSION` |
| `@openferry/model-registry` | 目录刷新、`ModelView` 组装（能力 + 过期判断 + 价格状态） |

### 桌面端

- 模型页：刷新目录、按供应商筛选、搜索、单项检测、能力徽章、价格状态、目录更新时间。
- 供应商删除 / 改端点时级联清理模型与探测记录。

## 实际运行的命令与结果

```text
$ pnpm build   # tsc -b
（无输出）

$ pnpm test
Test Files  11 passed (11)
Tests       114 passed (114)
```

新增测试 25 项（探测 13、注册表 8、存储 4）。

## 桌面端端到端证据（CDP 驱动真实 IPC）

```json
create-provider: "[\"local\"]"
refresh:          {"results":[{"providerId":"local","ok":true,"added":2,"removed":0,"total":2}],
                   "models":[{"id":"local/alpha","price":"unknown","accessible":null}, ...]}
models-page:      {"heading":"模型","rows":2,"caps":4,"meta":"local/alpha·价格未知·目录更新 刚刚","chips":["全部","local"]}
probe:            {"accessible":true,"caps":[
                    {"p":"chat","s":"pass","ev":"ok"},
                    {"p":"stream","s":"pass","ev":"首字 5ms，2 个增量"},
                    {"p":"tool_call","s":"pass","ev":"调用了 get_time"},
                    {"p":"tool_args","s":"pass","ev":"timezone=Asia/Shanghai"}]}
after-refresh-click: {"rows":1,"banner":"local：+1 / −0，共 1","caps":4}
after-probe-click:   {"passing":4,"total":4,"label":"检测 刚刚"}
search:           {"rows":1}
cleanup:          {"remaining":0}
EXCEPTIONS        []
```

## 验证到的具体行为

- 刷新返回真实增量（+2 / −0），目录里的 `pricing` 为 `null`，UI 显示「价格未知」而不是「免费」。
- 探测四项全过时，证据分别记录了返回文本、首字延迟与增量数、调用的工具名、参数里的 timezone。
- 上游失败时保留旧目录（有测试断言 `keeps the old catalogue when the upstream fails`）。
- 过期的探测结论不算能力：`buildModelView` 返回 `accessible: null`，UI 徽章变虚线。
- 删除供应商后再用同一 id 加回来，旧结论不会复活（`caps: []`，`accessible: null`）。

## 过程中发现并修掉的问题

1. **假上游按顺序消费脚本，而探测是并发跑的** → `runAllProbes` 的测试会随机错位。
   给 testkit 加了 `route(request)` 按请求内容选响应，测试改为路由模式。
2. **删掉供应商再加回来，旧的探测结论会被「复活」**，而端点可能已经变了。
   修法：`ProbeRepository.deleteForProvider()` 用 `model_id LIKE 'providerId/%'` 前缀清理；
   改 baseUrl / 私网开关时同样作废探测记录。加了前缀误伤测试（`p` 不能匹配 `p2/a`）。

## 未完成

- 客户端配置写入与备份恢复（阶段 5）。
- 探测并发池：目前一次只探测一个模型，批量探测会串行发起。
- 价格来源：`/models` 不返回价格，`pricing` 恒为 null。需要单独的价目表来源才能填。
- 设置页、日志页、打包。

## 已知风险

1. 探测会真实消耗额度（每次 3 个请求，工具与参数共用一次）。UI 上写明了，但没有额度预算控制。
2. `probe_runs` 会随时间增长，目前只有 `prune()` 可用，还没有定时清理。
3. 模型 id 复用 `providerId/upstreamId`，如果上游把同一个 id 指向不同模型，旧结论仍会命中——这是 id 语义本身的限制，不是实现缺陷。
