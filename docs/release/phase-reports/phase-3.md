# 阶段 3 报告：持久化、凭据与供应商管理

日期：2026-11-02
环境：macOS 26 arm64，Node 22.22.2，Electron 45.2.1

## 交付内容

### 新增包

| 包 | 职责 |
| --- | --- |
| `@openferry/storage` | `node:sqlite` 打开/迁移、`ProviderRepository`、`StorageError` |
| `@openferry/secrets` | `SecretStore` 接口、`MemorySecretStore`、`FileSecretStore`（CLI 兜底，明文 + 0600） |

### 改动

- `@openferry/gateway`：新增 `setProviders()`，供应商列表可在运行时替换，进行中的请求不受影响。
- 桌面主进程：打开数据库、用 `safeStorage` 实现 `SecretStore`、供应商 CRUD 的 IPC、连接测试、首次运行从旧 `config.json` 导入一次。
- 渲染层：新增「供应商」页（列表 / 新建 / 编辑 / 停用 / 删除 / 测试连接），概览页拆成独立组件。

### 数据库

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  credential_ref TEXT,          -- 引用名，不是密钥
  allow_private_network INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_providers_enabled ON providers (enabled);
```

迁移版本 1，执行在事务里，失败整体回滚。

## 实际运行的命令与结果

```text
$ pnpm build      # tsc -b
（无输出）

$ pnpm test
Test Files  9 passed (9)
Tests       89 passed (89)
Duration    5.33s
```

新增测试：存储 9 项、凭据 6 项、网关热替换 2 项。

## 桌面端端到端证据（CDP 驱动真实 IPC）

```json
overview:            {"heading":"概览","pill":"运行中","nav":["概览","供应商","模型未实现","客户端未实现","日志未实现","设置未实现"]}
providers-page:      {"heading":"供应商","empty":"还没有供应商。…","rows":0,"addButton":true}
create:              [{"id":"demo","hasCredential":true,"enabled":true}]
providers-after-create: {"rows":1,"title":"Demo 上游demo已存密钥","url":"https://api.example.com/v1","tags":["已存密钥"]}
gateway-providers:   {"state":"running","providers":["demo"],"schema":1,"secrets":"encrypted"}
test-fail:           {"ok":false,"hasError":true}
toggle:              [false]
cleanup:             {"remaining":0}
EXCEPTIONS           []
```

这条链路验证的是：**表单 → IPC（Zod 校验）→ SQLite → safeStorage → 网关热替换 → 列表刷新**，中间没有 mock。

连接测试打的是 `https://127.0.0.1:9/v1`（不可达），返回 `ok:false` 且带错误信息 —— 证明它真的发了请求，不是假装成功。

## 验证到的具体行为

- 迁移在全新库上建表，第二次执行 `applied: []`。
- 迁移中途失败会整体回滚：失败后 `schema_migrations` 里没有任何记录，已建的表也消失。
- 重复 id 抛 `conflict`，非法 id 抛 `invalid` 并点名字段。
- 关闭后重新打开，供应商配置仍在（文件库，非 `:memory:`）。
- 数据库里不出现任何形如 `sk-…` 的字符串（有断言）。
- 密钥文件权限 `0600`；临时文件不会残留。
- 网关 `setProviders` 后，旧供应商立刻不可用，新供应商立刻可用；重复 id 直接抛错。

## 未完成

- 模型目录、能力探测、客户端配置写入。
- 设置页（端口、主题、日志保留）。
- 打包与签名；Windows / Linux 运行验证。

## 已知风险

1. `node:sqlite` 仍是实验性 API，启动时有 ExperimentalWarning。所有调用收在 `@openferry/storage` 一个包里，替换成本可控。
2. Linux 无 keyring 时 `safeStorage` 不可用，密钥存不了。当前行为是**拒绝保存并告警**，没有明文兜底 —— 这是有意的。
3. 删除供应商会连带删除密钥，没有二次确认以外的保护（UI 是两步点击，不是系统对话框）。
4. 旧 `config.json` 只在数据库为空时导入一次；之后配置文件不再影响桌面端。CLI 仍然读它 —— 两套配置源并存，是阶段 4 要收掉的债。
