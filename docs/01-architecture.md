# 01 — 总体架构设计

> 状态：设计稿（v0.1）。决策依据见 `03-capability-gap.md`（hermes 对照）与
> 调研报告（`C:/tmp/omp-migration-report.md`，调研背景）。

## 1. 目标与非目标

### 目标
- 一个**独立常驻进程**（daemon）同时承担：cron 定时调度 + QQ 官方机器人网关。
- 调度与消息处理都通过 `omp --mode rpc` 驱动 omp agent 执行。
- 进程独立于任何 omp 会话存活（跨重启、开机自启），对齐 hermes gateway 的守护形态。
- 全 TS/Bun 技术栈，最终可打包为单文件可执行 + 可 `omp plugin install` 的扩展壳。

### 非目标（本阶段明确不做）
- 20+ IM 平台矩阵（仅 QQ）。
- webhook 入站适配器（hermes 的独立功能，不在 cron+QQ 范围内）。
- 多用户/多租户（个人工作流）。
- QQ 协议号方案（NapCat/OneBot v11）——仅官方 QQ Bot API v2。

## 2. 为什么是"单一 daemon"而不是两个项目

hermes 本身就是单 gateway 进程（cron 调度器 + 平台适配器同进程）。合成单进程消灭了
跨进程投递契约、统一配置与台账、`QQBOT_HOME_CHANNEL` 天然共享。曾拆分为
omp-scheduler / omp-qq-bridge 两个仓库，因联动契约问题合并为本项目（两个旧仓库已归档）。

## 3. 进程模型

```
┌────────────────────────── omp-gateway daemon（TypeScript/Bun，常驻） ──────────────────────────┐
│                                                                                                 │
│  ┌────────────┐   ┌─────────────┐   ┌───────────────┐   ┌───────────────────────────────────┐  │
│  │  config    │   │  scheduler  │   │    qq         │   │  omp-driver                       │  │
│  │  loader    │   │  (croner)   │   │  (QQ Bot v2)  │   │  OmpRpcClient                     │  │
│  │  + zod     │   │  job store  │   │  WS inbound   │   │  spawn `omp --mode rpc`            │  │
│  │            │   │  ledger     │   │  REST outbound│   │  prompt/steer/follow_up           │  │
│  │            │   │  executor   │   │  STT          │   │  event stream → delivery          │  │
│  └────────────┘   └─────┬───────┘   └──────┬────────┘   └───────────────┬───────────────────┘  │
│                         │                  │                            │                      │
│                         ▼                  ▼                            ▼                      │
│                 ┌─────────────────────────────────────────────────────────────┐               │
│                 │  delivery（投递框架）：target = file | qq | origin          │               │
│                 │  home channel 默认目标；SILENT 静默；continuable 续聊路由    │               │
│                 └─────────────────────────────────────────────────────────────┘               │
│                                                                                                 │
│  ┌─────────────────────────────── management 面 ───────────────────────────────┐                │
│  │  CLI: omp-gateway start|stop|status|jobs|logs                              │                │
│  │  HTTP admin (127.0.0.1): /api/status /api/jobs ...（Phase 2 插件壳 IPC 复用）│                │
│  └─────────────────────────────────────────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 与 omp 的关系（两种模式，同一 daemon）

| 模式 | 触发方 | omp 会话 | 用途 |
|---|---|---|---|
| **headless 驱动** | daemon 内部（cron 到点 / QQ 来消息） | daemon spawn `omp --mode rpc --no-session`（或 per-chat 复用 session 文件） | 默认路径，无需用户在场 |
| **会话注入**（Phase 2 插件壳） | 用户在 omp TUI 聊天中 | 插件壳收到 daemon 事件 → `pi.sendUserMessage` 注入当前会话 | QQ 消息进当前 TUI 会话、`/gateway` 管理、`qq_send` 工具 |

headless 驱动是主路径（对齐 hermes）；插件壳是可选增强层，**不是前置依赖**。

## 4. 模块边界与职责

### 4.1 config（配置加载）
- 单文件配置 `~/.omp-gateway/config.yml`（YAML）+ `.env` 兼容环境变量。
- zod 运行时校验，启动时 fail-fast；preflight 校验（不烧 token）见 §6.4。

### 4.2 scheduler（调度核心）
- **调度引擎**：croner（cron 表达式、interval、ISO/相对时间）。自然语言解析另见
  `02-contracts.md §3.1`（cron-parser / 自建 NL 层）。
- **job store**：持久化（`bun:sqlite`），跨重启恢复；job 模型见 `02-contracts.md §2`。
- **executor**：到点执行 → 按 job 类型分派：
  - `agent` 任务：调 omp-driver 开 RPC 会话执行 prompt，结果走 delivery
  - `no-agent` 任务（`$0`）：直接跑脚本，stdout 走 delivery，不烧 token
- **执行语义**：防重叠锁、台账状态机（claimed→running→completed/failed/unknown）、
  misfire catch-up、失败连击 nudge。见 `02-contracts.md §4`。

### 4.3 qq（QQ 官方 Bot API v2 客户端）
- **inbound**：持久 WebSocket 连 QQ Gateway（`wss://api.sgroup.qq.com`），intents 订阅
  （`C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`、频道事件），自动重连（指数退避）。
- **outbound**：REST API（`/v2/users/{openid}/messages`、`/v2/groups/{group_openid}/messages`），
  文本/Markdown（msg_type 2，需模板审核）/图片/文件。
- **多媒体**：图片→视觉（转 prompt 的 images 输入）；语音→QQ 内置 ASR
  （`asr_refer_text`）+ 可配 STT fallback（OpenAI 兼容端点，默认 zai glm-asr）。
- **会话映射**：per-chat 固定 session 文件（`chat_key → session_path`），回复路由
  （continuable 续聊）依赖此映射。允许清单（user/group allowlist）。
- **凭证**：AppID/AppSecret（q.qq.com），支持 sandbox 门户（`sandbox.q.qq.com`）。

### 4.4 omp-driver（omp RPC 客户端）
- spawn `omp --mode rpc` 子进程，JSONL 协议（v1/v2 协商，支持分块）。
- 能力：`prompt`/`steer`/`follow_up`/`abort`、`set_model`、`set_thinking_level`、
  `set_host_tools`（宿主工具）、事件流（`message_update` 逐 token → delivery 流式转发）。
- 会话策略：
  - cron job：`--no-session` 每 job 全新会话（hermes 语义）
  - QQ chat：按 `chat_key` 复用 session 文件（`-r/--resume` 语义），跨重启可续
- 官方 TS `RpcClient`（`packages/coding-agent/src/modes/rpc/rpc-client.ts`）作为参考实现，
  本项目自带轻量客户端（减少对包内部路径的依赖）。

### 4.5 delivery（投递框架）
- 抽象 target：`file`（写文件）、`qq`（发 QQ，默认 home channel）、`origin`（回到触发处）。
- 语义：响应包装（可关）、`[SILENT]` 静默、continuable（回帖续聊路由）、nudge 提醒。
- cron 结果默认投递 `qq.home_channel`（对等 hermes `QQBOT_HOME_CHANNEL`）。

### 4.6 management（管理面）
- CLI：`omp-gateway start|stop|status|jobs|logs`（Phase 1）。
- HTTP admin（127.0.0.1 回环，token 鉴权）：status、jobs CRUD、logs（Phase 2 插件壳复用）。

## 5. 数据流（两条主链路）

### 5.1 QQ 消息链路
```
QQ 用户消息 → QQ Gateway WS → qq.inbound → chat 映射查表
  → 会话已存在? 复用 session 文件 : 新建
  → omp-driver prompt(消息文本) → agent 执行
  → message_update 流式 → delivery(qq, target=原 chat) → REST 发回
```

### 5.2 cron 链路
```
croner 到点 → executor 领取 job（台账 claimed，防重叠锁）
  → 类型 agent：omp-driver 新会话执行 prompt
  → 类型 no-agent：直接跑脚本（$0）
  → delivery(job.target 默认 qq.home_channel) → REST 发 QQ / 写文件
  → 台账 completed/failed
```

## 6. 关键设计决策记录（ADR 摘要）

| # | 决策 | 理由 | 备选 |
|---|---|---|---|
| ADR-1 | 单一 daemon 进程 | 对齐 hermes gateway；消灭跨进程投递契约 | 双进程 HTTP/IPC |
| ADR-2 | 全 TS/Bun | omp 同栈；扩展壳原生形态；Bun 可编译单文件 daemon；`bun:sqlite` 免外部依赖 | Python（omp-rpc 官方客户端） |
| ADR-3 | daemon 为核心，插件壳为 Phase 2 | 插件壳不前置；daemon 独立可跑 | 先做插件 |
| ADR-4 | headless RPC 驱动为主路径 | 无需用户在场；fresh session 对齐 hermes | SDK 进程内嵌入（会绑定会话生命周期） |
| ADR-5 | QQ 官方 API v2，不用 OneBot/NapCat | 无封号风险；hermes 同款；个人可注册（2026-03 起） | NapCat（协议号，有风险） |
| ADR-6 | 会话存储用 omp session 文件 + per-chat 映射 | 复用 omp 会话持久化、resume 语义 | 自建 DB 会话 |
| ADR-7 | 台账用 bun:sqlite | 零依赖、单文件、够用 | Postgres/SQLite 外部库 |

## 7. 边界与风险

- **QQ 官方 API 限制**：群内默认仅 @ 触发；沙箱/发布状态、IP 白名单、审核流程（运营层面）。
- **无人值守安全**：所有 agent 任务以 yolo（`--auto-approve`）运行——用专用低权限 QQ 号 +
  allowlist + preflight 校验 + 凭据外泄扫描（见 `03-capability-gap.md` 缺口 9/10）。
- **omp RPC 子进程生命周期**：daemon 需管理 RPC 子进程（超时、崩溃重启、孤儿回收）。
- **Windows 部署**：`omp-gateway start` 以计划任务/NSSM 常驻；日志落文件。
