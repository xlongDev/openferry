# 阶段 5 报告：客户端配置写入

日期：2026-11-02
环境：macOS 26 arm64，Node 22.22.2，Electron 45.2.1

## 这一阶段最容易出事

写别人的配置文件，是这类工具里唯一能造成**用户数据不可逆损失**的操作。所以顺序写死在代码里，不提供绕过：

```
读取 → 校验 → 冲突检测 → 备份 → 临时文件 → 校验 → 原子替换 → 重读校验 → 失败恢复
```

## 交付内容

### 新增包 `@openferry/clients`

| 模块 | 职责 |
| --- | --- |
| `atomic.ts` | 哈希冲突检测、备份、同目录临时文件、原子 rename、写入后重读校验、失败还原 |
| `workbuddy.ts` | 路径解析、条目读取与校验、变更计划、应用、归属判定 |

### 迁移 v3

```sql
CREATE TABLE client_entries (
  client_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  written_at TEXT NOT NULL,
  PRIMARY KEY (client_id, entry_id)
);
```

**为什么归属记在我们自己的库里**：在用户的 `models.json` 里加 `openferry: true` 字段等于污染用户配置；而一旦客户端忽略该字段，我们就失去区分「我们写的」和「用户手写的」的唯一依据。归属是 OpenFerry 的知识，不是客户端的知识。

### 桌面端「客户端」页

- 显示路径、文件是否存在、条目总数、OpenFerry 写入数、备份数。
- 勾选要写入的模型（只列 `accessible !== false` 的）。
- **必须先预览再写入**：选中项一变，预览立即失效。
- 变更按 新增 / 更新 / 移除 / 不变 / 跳过 分组展示。
- 备份列表 + 两步确认恢复。

## 条目字段的来源（重要，也是本阶段最大的不确定性）

`id` / `name` / `url` / `apiKey` / `local` 五个字段来自 WorkBuddy 应用自身的证据：

| 字段 | 证据 |
| --- | --- |
| `url` | 应用报错文案：`Set the "url" field for this model in your model settings (models.json)` |
| `apiKey` | 同上，`Set the "apiKey" field` |
| `local` | 孤儿清理逻辑：`t?.local === true && typeof t?.id === 'string'` |
| `id` | 同上，作为条目主键 |
| `name` | 推断（未在应用代码中直接确认） |

**没有用真实的非空 models.json 验证过应用是否接受我们写出的条目。** 这一点在 UI 底部和本文档里都明确标注。当前机器上的 `~/.workbuddy/models.json` 是空数组 `[]`，无法提供样本。

## 实际运行的命令与结果

```text
$ pnpm test
Test Files  12 passed (12)
Tests       132 passed (132)
```

新增 18 项测试（客户端包）。

## 端到端证据（隔离目录 `/tmp/of-wb`，未触碰真实配置）

场景一：文件里已有一条用户手写条目

```json
state-before: {"path":"/tmp/of-wb/models.json","exists":true,"entries":1,"owned":0,"backups":0}
preview:      {"items":[{"id":"mine","a":"unchanged"},{"id":"local/alpha","a":"add"}],"warnings":[]}
apply:        {"ok":true,"entries":2,"owned":["local/alpha"],"backups":1}
file-after-apply: [
  {"id":"mine","hasUrl":false,"hasKey":false,"custom":"keep-me"},
  {"id":"local/alpha","hasUrl":true,"hasKey":true,"local":false}
]
restore:      {"entries":1,"owned":0}
file-after-restore: [{"id":"mine","name":"用户手写的条目","custom":"keep-me"}]
```

用户条目的 `custom` 字段原样保留，恢复后文件逐字节回到原样。

场景二：文件里已有同 id 但非我们写入的条目

```json
preview: {"items":[{"id":"local/alpha","a":"conflict",
           "note":"同名条目已存在，但不是 OpenFerry 写入的，已跳过"}],
          "warnings":["条目 local/alpha 已存在且不是 OpenFerry 写入的，不会覆盖"],
          "next":"[{\"id\":\"local/alpha\",\"name\":\"用户手写\",\"mine\":true}]"}
apply:   {"entries":1,"owned":[]}
file-after: [{"id":"local/alpha","name":"用户手写","mine":true}]
```

## 过程中发现并修掉的 bug

**`conflict` 条目会被写成删除。** 计划阶段把「跳过」实现成了「不写回」，于是一次写入会删掉用户手写的同 id 条目 —— 正是这个功能最不能犯的错。
是那条断言 `plan.nextContent` 应包含用户条目抓到的。修法：`conflict` 用 `before` 原样写回，`remove` 才是唯一不写回的动作。

## 未完成

- 只支持 WorkBuddy 一个客户端；DSH 等需要单独适配与验证。
- 没有文件监听：外部改动不会实时反映，靠「预览时哈希不一致」兜底。
- 没有写锁：同一时刻两个 OpenFerry 实例同时写，后写者会因哈希不一致被拒绝（安全，但会失败）。
- 打包与签名。

## 已知风险

1. **条目 schema 未验证**（见上）。缓解：预览 + 备份 + 一键恢复。
2. 写入的 `apiKey` 是网关 Token，会以明文出现在 `models.json` 里。这是客户端认证的固有限制，网关 Token 只对本机有效。
3. 备份只保留文件内容，不保留文件权限/属主；恢复用 0600 写入。
4. 备份没有自动清理策略，会随写入次数增长。
