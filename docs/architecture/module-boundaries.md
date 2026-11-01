# 模块边界

> 状态：v0.1。规则可执行部分由 ESLint + 代码评审 + 依赖方向检查保证。

## 1. 硬性规则

| 规则                                       | 违反后果                    | 当前保障                                        |
| ------------------------------------------ | --------------------------- | ----------------------------------------------- |
| Renderer 不访问 Node API / 文件系统 / 密钥 | 任意页面脚本可读用户文件    | `contextIsolation` + `sandbox` + preload 白名单 |
| React UI 不直连供应商 API                  | 密钥进入渲染进程，CORS 失效 | 渲染层只能调 preload 暴露的固定方法             |
| 协议层不选择供应商                         | 协议与路由耦合，无法复用    | `protocols/*` 只依赖 `canonical`                |
| 供应商适配器不改客户端配置                 | 越权写用户文件              | `providers/*` 无文件系统依赖                    |
| 客户端集成不做模型生成                     | 逻辑重复、错误处理分叉      | `clients/*`（未实现）只操作配置文件             |
| 网关核心不依赖 Electron                    | 无法无界面运行、无法测试    | `@openferry/gateway` 的依赖图里没有 electron    |
| 存储层不依赖 UI                            | 无法在 CLI 下复用           | `storage/*`（未实现）纯 Node                    |
| 插件默认无 FS / Shell / 网络权限           | 供应链风险                  | 首版不实现动态插件                              |

## 2. 包职责表

| 包                                      | 职责                                            | 允许依赖            | 明确不做                 |
| --------------------------------------- | ----------------------------------------------- | ------------------- | ------------------------ |
| `@openferry/core`                       | 错误分类、日志、脱敏、ID、网络地址守卫          | Node 标准库         | 业务协议、HTTP 框架      |
| `@openferry/canonical`                  | Canonical Model 类型与 Zod Schema               | `core`, `zod`       | 线格式、IO               |
| `@openferry/protocol-openai-chat`       | OpenAI Chat Completions ⇄ Canonical；SSE 编解码 | `canonical`, `core` | 选供应商、发请求         |
| `@openferry/provider-contract`          | `ProviderAdapter` 接口与上下文类型              | `canonical`         | 具体实现                 |
| `@openferry/provider-openai-compatible` | OpenAI 兼容上游实现                             | 上述全部            | 客户端配置、路由         |
| `@openferry/gateway`                    | HTTP 服务、认证、限流、超时、路由               | 上述全部 + `zod`    | UI、Electron、持久化细节 |
| `@openferry/testkit`                    | 假上游服务器、测试夹具                          | Node 标准库         | 生产逻辑                 |
| `apps/desktop`                          | Electron 生命周期、IPC、渲染层                  | `gateway`           | 协议转换                 |
| `apps/gateway-cli`                      | 无界面启动、配置加载                            | `gateway`           | UI                       |

## 3. 边界检查方式

```bash
# 网关包不得出现 electron
grep -rn "electron" packages/gateway/src && exit 1 || true

# 渲染层不得出现 node: 内置模块
grep -rn "from 'node:" apps/desktop/src/renderer && exit 1 || true
```

这两条检查会作为 CI 步骤加入（见 `.github/workflows/ci.yml` 的 `boundaries` job）。

## 4. 新增模块的门槛

一个包只有在同时满足以下三条时才允许创建：

1. 有明确的单一职责，且职责无法塞进现有包而不破坏上表；
2. 有公共接口和至少一个测试；
3. 至少有一个真实调用方（不是"以后会用到"）。

否则不建包 —— 空模块比没有模块更糟，它会让边界图撒谎。
