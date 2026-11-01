# 安全策略（实现约定）

> 本文件描述**代码里必须遵守的规则**。威胁分析见 [threat-model.md](./threat-model.md)。

## 1. 监听与认证

```ts
// 默认值，不可被配置覆盖成 0.0.0.0 而不给出显式警告
host: '127.0.0.1';
authRequired: true;
```

- 监听地址只允许 `127.0.0.1` 或 `::1`。设为其他值必须在启动日志中输出 `WARN` 级别告警，并在 UI 上显示「已暴露到网络」。
- Token 用 `crypto.randomBytes(32).toString('base64url')` 生成，文件权限 `0600`。
- 比较用 `crypto.timingSafeEqual`，长度不等时也执行一次等长比较以避免时序泄露。
- 数据面 Token 与管理面 Token 分离（阶段 4）。持有数据面 Token 不能调用 `/admin/*`。

## 2. 请求入口检查顺序

顺序不可调整——先便宜的检查，且必须在读 body 之前完成：

1. `Host` 头必须在白名单内（`127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>`）。
2. 存在 `Origin` 或 `Referer` → `403`。
3. `Authorization: Bearer <token>` 校验失败 → `401`。
4. `Content-Length` 超限 → `413`（流式读入时累计超限也 `413` 并销毁连接）。
5. 并发闸门已满 → `429` + `Retry-After: 1`（不是 `503`：这是限流，不是服务不可用）。

## 3. 网络出口

- 所有 `fetch` 必须带 `AbortSignal`，且至少有 `connectTimeoutMs`、`firstEventTimeoutMs`、`totalTimeoutMs` 三层超时。
- 供应商 URL 必须先过 `assertSafeProviderUrl()`。
- **不自动跟随重定向**（`redirect: 'manual'`）。若上游返回 3xx，按 `upstream_error` 处理并记录 `location` 的主机名（不记录完整 URL，可能含 token）。
- 不允许把 `Authorization` 转发到与配置不同的 host。

## 4. 地址守卫规则（`@openferry/core/net-guard`）

拒绝：

- 非 `http:` / `https:` 协议
- 主机名为 `metadata.google.internal`、`metadata.goog`
- IPv4 云元数据：`169.254.169.254`、`169.254.170.2`、`100.100.100.200`
- `0.0.0.0/8`、`169.254.0.0/16`（link-local）
- IPv6 `::1`、`fe80::/10`、`fd00:ec2::254`

需要 `allowPrivateNetwork: true` 才放行：

- `127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`
- `localhost`、`*.local`

**已知缺口**：不做连接时的 DNS 固定，因此 DNS rebinding 未被完全阻断。见威胁模型 T2/T3。

## 5. 日志

允许记录的字段：`ts`、`level`、`event`、`requestId`、`providerId`、`modelId`、`status`、`durationMs`、`errorCode`、`tokens`。

禁止记录：`Authorization`、`Cookie`、`Set-Cookie`、完整 prompt、完整 completion、`apiKey`、任何 `Bearer ` 之后的字符串。

实现约束：`logger.info(event, fields)` 只接受 `Record<string, unknown>`，并在写入前统一过 `redact()`。**不提供** `logger.info(obj)` 这种可以整对象展开的重载。

## 6. Electron

| 配置                          | 值                                                        |
| ----------------------------- | --------------------------------------------------------- |
| `contextIsolation`            | `true`                                                    |
| `sandbox`                     | `true`                                                    |
| `nodeIntegration`             | `false`                                                   |
| `webSecurity`                 | `true`                                                    |
| `allowRunningInsecureContent` | `false`                                                   |
| 导航                          | `will-navigate` / `setWindowOpenHandler` 一律拒绝外部 URL |

IPC 通道必须：

1. 在 preload 中以具名函数暴露，不暴露 `ipcRenderer`；
2. 主进程用 Zod 校验参数；
3. 校验 `event.senderFrame.url` 属于应用自身页面。

## 7. 密钥

- 不写入代码、不写入仓库、不写入日志、不进入渲染进程状态。
- 桌面端使用 `safeStorage`（macOS Keychain / Windows DPAPI）加密后落盘（阶段 3）。
- CLI 从环境变量或 `0600` 配置文件读取，**不回显**。

## 8. 依赖与供应链

- `pnpm audit` 在 CI 中运行，`high` 及以上失败。
- 锁定文件必须提交。
- 新增依赖需在 PR 描述中说明：为什么标准库做不到、体积、维护状态。

## 9. 报告漏洞

见仓库根目录 `SECURITY.md`。
