# ADR 0001 — Monorepo 与构建方式

- 状态：已接受
- 日期：2026-11-02

## 背景

需要一个既能装桌面应用、又能单独跑无界面网关、还能把协议/供应商拆开测试的工程结构。

## 决策

- pnpm workspace，`apps/*` + `packages/*`（含两级 `packages/protocols/*`、`packages/providers/*`）。
- TypeScript `composite` 项目引用，`tsc -b` 一次性按依赖顺序构建。
- 包的 `exports` 指向 `dist`，运行时由 Node 直接加载 ESM。
- 测试用 Vitest，通过 `resolve.alias` 指向源码，因此**测试不需要先构建**。

## 后果

- 好处：类型边界由编译器强制；增量构建快；测试反馈循环短。
- 代价：源码内相对导入必须带 `.js` 后缀（NodeNext 要求）；新增包要同时维护 `tsconfig.json` 的 references 和 vitest 的 alias。
- 代价可接受：包的数量会长期保持在 10 个以内。

## 备选方案

- **单包**：最简单，但协议层与网关层无法在类型层面隔离，且未来 CLI 会拖进 Electron 依赖。
- **Nx / Turborepo**：当前规模不需要任务图缓存，`tsc -b` 已经够快。
