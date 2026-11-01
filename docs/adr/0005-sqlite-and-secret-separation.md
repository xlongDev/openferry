# ADR 0005 — 用 `node:sqlite` 与 `credentialRef` 分开存配置和密钥

- 状态：已接受
- 日期：2026-11-02

## 背景

供应商配置要持久化，密钥不能。两件事必须分开：**配置可备份、可导出、可进诊断报告；密钥不可以。**

候选数据库：`better-sqlite3`（原生模块）、`node:sqlite`（内置，实验性）。

## 决策

1. 用 Node 内置的 `node:sqlite`，不引入原生依赖。
2. 数据库只存 `credentialRef`（一个引用名，通常等于 provider id），密钥放 `SecretStore`。
3. 桌面端 `SecretStore` 用 Electron `safeStorage`（macOS Keychain / Windows DPAPI）；**系统凭据存储不可用时拒绝保存，不退回明文**。
4. 迁移是纯追加的版本列表，每个版本在事务里执行。

## 理由

- `better-sqlite3` 需要为每个平台编译原生模块，Electron 还要匹配 ABI（`electron-rebuild`）。这是发布流水线上最容易坏的一环，而我们只需要一个本地单文件库。
- `node:sqlite` 在 Node 22 已可用（带 ExperimentalWarning），API 与 `better-sqlite3` 接近：`prepare/run/all/get`。代价是 API 可能变动 —— 因此所有 SQLite 调用都收在 `@openferry/storage` 里，将来要换实现只改一个包。
- 明文密钥落盘是**不可接受**的降级。宁可在 Linux 无 keyring 时让用户明确知道「存不了」，也不要悄悄写一个 0600 的明文 JSON 然后让人以为它是加密的。CLI 的 `FileSecretStore` 是显式选择，不是默认路径。

## 后果

- 数据库可以随便复制、导出、贴进 issue。
- 密钥丢失的代价是重新输入，不是泄露。
- `node:sqlite` 的实验性警告会出现在日志里。这是事实，不掩盖；等它稳定后自然消失。
- 迁移不可回滚到旧版本（只支持向前）。回滚策略是「用备份文件覆盖」，由调用方负责。

## 备选方案

- **JSON 文件**（OC Ferry 的做法）：简单，但没有事务、没有索引、并发写要自己加锁。供应商数量少时够用，但请求记录一多就不行。
- **better-sqlite3**：成熟，但要处理原生模块分发。等 `node:sqlite` 出问题再说。
