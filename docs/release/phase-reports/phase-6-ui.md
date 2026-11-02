# 阶段 6 报告：日志页、设置页与主题

日期：2026-11-02

## 交付内容

- **日志页**：级别筛选、按事件 / 请求 ID / 字段搜索、脱敏诊断报告导出。
- **设置页**：主题（跟随系统 / 深色 / 浅色，本机持久化）、运行信息（版本、网关地址、schema 版本、密钥存储类型、数据目录、CLI 配置路径）、打开数据目录、导出诊断。
- **浅色主题**：只覆盖令牌，不重写组件；`data-theme` 由 JS 解析「跟随系统」后写死为 dark / light，CSS 不依赖媒体查询。
- **诊断导出**：`~/.openferry/diagnostics-<ts>.json`，内容为版本、平台、网关状态、供应商元数据（不含密钥）、模型数、最近 200 条日志。

## 实际运行结果

```text
$ pnpm test
Test Files  12 passed (12)
Tests       132 passed (132)
```

## 界面验证（CDP）

```json
nav:        [概览, 供应商, 模型, 客户端, 日志, 设置] —— 全部 enabled
logs:       {"heading":"日志","rows":1,"chips":["全部","debug","info","warn","error"],"hasExport":true}
logs-filter-error: {"rows":0}        // 唯一一条是 info，过滤生效
settings:   {"kv":["版本","网关地址","数据库 schema","密钥存储","数据目录","CLI 配置文件"],
             "themes":["跟随系统","深色","浅色"],"theme":"light","bg":"rgb(247, 248, 249)"}
light:      {"theme":"light","bg":"rgb(247, 248, 249)","text":"rgb(26, 29, 32)","stored":"light"}
dark:       {"theme":"dark","bg":"rgb(10, 11, 13)"}
EXCEPTIONS  []
```

初始主题是 `light`，因为本机系统外观是浅色 —— 「跟随系统」按预期解析。

## 未完成

- 端口修改、日志保留策略、开机自启：设置页里明确列为「尚未实现」，没有放假的开关。
- 窗口背景色写死为深色，浅色系统下启动瞬间会闪一下深色。
- 日志页只展示内存环形缓冲（最多 500 条），没有持久化与跨重启查询。
