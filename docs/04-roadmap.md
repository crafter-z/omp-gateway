# 04 — 实施路线图

> 原则：**daemon 为核心，插件壳为增强**；每阶段可独立交付、可独立验证；
> 阶段内按"契约文档（02）"实现，变更回写文档。

## 阶段总览

| 阶段 | 内容 | 交付物 | 验收 |
|---|---|---|---|
| P0 | 项目脚手架 | package.json、tsconfig、目录、测试框架、CI 骨架 | `bun test` 空跑通过 |
| P1 | daemon 骨架 + config + CLI | `omp-gateway start/stop/status`，配置加载校验，日志 | start 起进程、status 正常、bad config 报错退出 |
| P2 | omp 驱动（OmpRpcClient） | spawn `omp --mode rpc`、prompt/事件流、超时/崩溃处理 | CLI 命令触发一次 agent 会话并拿到文本 |
| P3 | scheduler 最小集 | croner 接入、job store、interval/once、executor、台账 v1、防重叠 | `jobs add --every 5m` 周期执行、台账落库、重启不重跑 |
| P4 | qq 模块 | WS inbound + REST outbound、per-chat 映射、allowlist、消息去重 | 私聊消息 → agent 回复回原 chat |
| P5 | scheduler 完整 | cron 表达式、NL 解析、no-agent $0、nudge、misfire、preflight、外泄扫描 | `03-capability-gap.md §4` 验收清单（除 Phase 2 项） |
| P6 | delivery 完整 | file/qq/origin、SILENT、continuable、home channel、流式转发 | cron 结果默认进 home channel；QQ 续聊可用 |
| P7 | 插件壳 | omp 扩展、IPC、/gateway 命令、`qq_send` 工具、会话注入 | `omp plugin install` 后 TUI 内管理 daemon、QQ 消息注入当前会话 |
| P8 | 加固与发布 | 测试补全、单文件打包（`bun build --compile`）、Windows 服务安装、文档定稿 | 打包可执行独立运行；README/docs 与实现一致 |

## 阶段详情

### P0 — 脚手架
- `bun init`（package.json、tsconfig）、目录：
  ```
  src/
    cli/            # omp-gateway 命令行入口
    config/         # 配置加载 + zod schema
    scheduler/      # croner、job store、executor、ledger
    qq/             # QQ Bot v2 客户端（ws/rest/chat-store）
    omp/            # OmpRpcClient
    delivery/       # 投递框架
    admin/          # HTTP 管理面（P7 复用）
    util/           # 日志、锁、密钥解析、扫描
  tests/
  ```
- 测试框架：`bun test`（内置）；lint/typecheck：`tsc --noEmit` + biome（可选）。
- 依赖初选：`croner`、`zod`、`yaml`；QQ WS 用 Bun 原生 WebSocket（免依赖）；SQLite 用
  `bun:sqlite`（零依赖）。P5 再评估 NL 库。

### P1 — daemon 骨架 + config + CLI
- 契约：`02-contracts.md §1`（config schema 全量实现，含 `${VAR}`/`!command` 解析）。
- CLI：`start`（前台/后台）、`stop`（优雅停止：停领取、等运行中 job 完成或超时）、`status`（打印 config 摘要 + 各模块状态）。
- 日志：文件 + stdout，轮转（大小限制，后续）。

### P2 — omp 驱动
- 契约：`02-contracts.md §5`。实现 `OmpRpcClient`：
  - spawn/就绪握手（v1/v2 协商）、prompt/steer/follow_up/abort、set_model/set_thinking_level
  - 事件订阅 → delivery 流式回调；超时/崩溃 → 明确错误与清理（孤儿进程回收）
  - `--no-session` 与 session 文件复用两种模式（P4 起用后者）
- 验收：一个 CLI 子命令 `omp-gateway run-prompt "..."`（开发用）能完成一轮对话。

### P3 — scheduler 最小集
- 契约：`02-contracts.md §2/§3/§4`。
- 先实现 interval/once（cron 表达式 P5 补）；job store（bun:sqlite，schema_version 起步）；
  executor（agent 类型）；ledger 状态机 + 防重叠 + 重启扫描（claimed 超时 → unknown）。
- CLI：`jobs add/list/rm/pause/resume/run`。

### P4 — qq 模块
- 契约：`02-contracts.md §6`。
- 先文本收发：WS 连接（含心跳/重连/去重）→ chat 映射 → omp 驱动 → REST 回发。
- allowlist 先行；媒体/STT P6 补。
- 配置：`qq.app_id/app_secret` 等。冒烟：私聊 → 回复。

### P5 — scheduler 完整
- cron 表达式（croner 6 字段）；NL 解析层（含中文）；no-agent $0（脚本执行器 +
  `wake_agent` 预检门 + 空输出静默 + 非零退出告警）；nudge；misfire；preflight；
  凭据外泄扫描；模型解析顺序 + fail-closed。
- 对齐 `03-capability-gap.md §4` 验收清单（除 Phase 2 项）。

### P6 — delivery 完整
- file/qq/origin 三目标；home channel；SILENT；响应包装；continuable 路由；
  流式转发（message_update → QQ 分段发送，若官方 API 支持）。
- QQ 媒体：图片→视觉输入、文件下载上传、语音 ASR + STT fallback。

### P7 — 插件壳（Phase 2）
- 契约：`02-contracts.md §7`。
- omp 扩展（`registerTool`/`registerCommand`/`pi.on`）：
  - `/gateway status|start|stop|jobs`（管理面）
  - `qq_send` 工具（agent 主动发 QQ，走 admin 出口）
  - QQ 来消息事件 → `pi.sendUserMessage({deliverAs:"steer"})` 注入当前会话
  - `job_add` 等工具（agent 创建 cron job，含防死循环 C15）
- 打包：npm 包 + `omp plugin install`；与 daemon 的 IPC 复用 admin HTTP。

### P8 — 加固与发布
- 单文件打包：`bun build --compile`（daemon 可执行）。
- Windows 服务：`omp-gateway service install/uninstall`（sc.exe 或 NSSM 封装）。
- 测试补全（单元 + 集成冒烟）；文档与实现对齐；CHANGELOG 起步。

## 依赖与风险

- **NL 解析库**：`nl2cron`/`cron-parser` 支持中文程度未知 → P5 评估，失败则自建
  关键词映射表（"每天/每 N 分钟/每周X 9点"）。
- **QQ 官方 API 变化**：沙箱/正式环境差异、Markdown 审核 → 实现期以
  `bot.q.qq.com/wiki` 为准，配置里保留 `portal_host` 切换。
- **Windows 进程守护**：P8 前用 CLI 前台 + 计划任务兜底。
- **omp RPC 协议演进**：以 `docs/rpc.md` 为准，客户端实现集中在 `src/omp/`，协议变化
  影响面可控。
