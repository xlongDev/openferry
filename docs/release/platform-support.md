# 平台支持矩阵

> 最后更新：2026-11-02。**本表只记录实际发生过的验证**。「CI 编译通过」≠「平台支持」。

## 1. 当前状态

| 平台 | 架构 | 构建 | 启动 | 冒烟 | 关键功能 | 发布就绪 |
| --- | --- | --- | --- | --- | --- | --- |
| macOS 26 (Darwin 27.2.0) | arm64 | ✅ | ✅ | ✅ | ✅ | 否（未签名） |
| macOS | x64 | — | — | — | — | 否 |
| Windows | x64 | — | — | — | — | 否 |
| Windows | arm64 | — | — | — | — | 否 |
| Linux | x64 | — | — | — | — | 否 |
| Linux | arm64 | — | — | — | — | 否 |

图例：✅ 已实测通过 ｜ ❌ 实测失败 ｜ — 未验证

### 已实测项（macOS arm64，2026-11-02）

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm install` | 通过 | 11 个 workspace 项目；Electron 二进制需镜像补装（见 README「已知问题」） |
| `pnpm build`（`tsc -b`） | 通过 | 无输出即成功 |
| `pnpm test` | 通过 | 7 个测试文件，72 项全部通过 |
| `pnpm lint` | 通过 | 0 error |
| 桌面应用启动 | 通过 | Electron 45.2.1 启动，窗口加载 `dist/renderer/index.html` |
| 渲染层渲染 | 通过 | CDP 读取到 `h1=概览`、状态徽章`运行中`、5 个指标、无 console 异常 |
| 网关随应用启动 | 通过 | `curl 127.0.0.1:41980/healthz` 返回 `{"status":"ok","version":"0.1.0"}` |
| 网关停止/重启按钮 | 通过 | 状态切换后按钮 disabled 状态正确 |
| 网关端到端（非流式 / 流式 / 工具调用） | 通过 | `tests/integration/gateway.test.ts`，走真实 HTTP + 假上游 |
| 客户端断开取消上游 | 通过 | `tests/integration/cancellation.test.ts` 断言上游收到 abort |

**未验证**：打包成 `.app` / `.dmg`、签名、安装与卸载流程。当前只有开发态 `electron .` 的运行证据。

**环境说明**：本机运行在禁止创建 Chromium 沙箱的受限环境里，启动验证使用了 `--no-sandbox`。这**不是**应用默认配置，正常桌面环境下应保持 `sandbox: true`。

### CI 构建证据（2026-11-02，run 41330937960）

| 平台 | 构建 | 说明 |
| --- | --- | --- |
| ubuntu-latest | ✅ | `pnpm --filter @openferry/desktop build` 通过 |
| macos-latest | ✅ | 同上 |
| windows-latest | ✅ | 同上 |

同一 run 中 `format / typecheck / lint / test` 在 Ubuntu 上全绿，`module boundaries` 与 `dependency audit` 通过。

**这只证明「能在该平台构建」，不证明能启动、能安装、能用。** 上表的「启动 / 冒烟 / 关键功能」列仍然是 `—`。

## 2. 为什么 Windows / Linux 现在是「未验证」

当前开发机是 macOS arm64。Windows 与 Linux 的行为差异集中在三处，这三处都**必须真机验证**：

1. **文件原子替换**：Windows 的 `rename` 在目标文件被占用时失败（`EPERM`/`EBUSY`），需要重试或改用 `ReplaceFile`。
2. **路径**：`%APPDATA%`、`$XDG_CONFIG_HOME`、`~/.workbuddy` 的实际位置与大小写敏感性。
3. **Electron 打包**：NSIS 安装包、开机自启注册表项、卸载清理。

因此 Windows 与 Linux 的构建任务只标记为「CI 构建尝试」，不进入支持矩阵的 ✅ 列。

## 3. 发布门槛

一个平台要进入「发布就绪 = 是」，必须同时满足：

- [ ] CI 在目标平台完成构建并产出安装包
- [ ] 干净机器（或干净用户目录）安装成功
- [ ] 应用能启动，窗口能显示
- [ ] 网关能启动并响应 `/healthz`
- [ ] 完成一次真实客户端请求（非流式 + 流式各一次）
- [ ] 卸载后无残留进程与自启项
- [ ] 安装包有 sha256 校验和

## 4. 架构支持计划

| 阶段 | 目标 |
| --- | --- |
| v0.1 | macOS arm64 本机验证 |
| v0.2 | GitHub Actions 上 macOS arm64 + Ubuntu x64 构建通过 |
| v0.3 | Windows x64 真机验证（需实际 Windows 环境） |
| v1.0 | macOS arm64/x64、Windows x64、Linux x64 四平台发布 |
