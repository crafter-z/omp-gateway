# 02 — 接口契约（Contracts）

> 状态：设计稿（v0.1）。本文定义 daemon 内部模块间、daemon 与 omp、daemon 与插件壳的
> 全部契约。实现以本文为准，变更需同步更新本文并记录 ADR。

## 1. 配置 Schema（config.yml）

单文件 `~/.omp-gateway/config.yml`，zod 校验。环境变量以 `OMP_GATEWAY_` 前缀覆盖：
层级用**双下划线**分隔、字段名单下划线保留，如 `OMP_GATEWAY_QQ__APP_ID` → `qq.app_id`、
`OMP_GATEWAY_TIMEZONE` → 顶层 `timezone`；叶值先按 JSON 解析，失败留字符串。

```yaml
# --- 全局 ---
timezone: Asia/Shanghai          # 调度时区（croner 按此求值）
log:
  level: info                    # debug | info | warn | error
  file: ~/.omp-gateway/logs/gateway.log
admin:
  host: 127.0.0.1                # 管理面 HTTP（Phase 2 插件壳 IPC 复用）
  port: 18765
  token: ""                      # 空 = 仅回环、无鉴权（默认）

# --- QQ 官方 Bot API v2 ---
qq:
  app_id: ""                     # q.qq.com AppID（必填）
  app_secret: ""                 # q.qq.com AppSecret（必填，可 ${ENV} 或 !command 解析）
  portal_host: q.qq.com          # sandbox 时 sandbox.q.qq.com
  intents:                       # 事件订阅
    - C2C_MESSAGE_CREATE         # 私聊
    - GROUP_AT_MESSAGE_CREATE    # 群 @
    # - PUBLIC_GUILD_MESSAGES    # 频道（默认关）
    # - DIRECT_MESSAGE_CREATE    # 频道私信
    # - INTERACTION_CREATE       # 互动消息
  allow:
    users: []                    # 空 = 全部（配合 allow_all_users）
    groups: []
    allow_all_users: false
  stt:
    provider: zai                # zai(glm-asr) | openai | none
    base_url: ""
    api_key: ""
    model: glm-asr
  markdown_support: false        # msg_type 2，需 QQ 模板审核
  typing_indicator: true         # C2C 消息处理期间发送"正在输入"（50s debounce）

# --- omp 驱动 ---
omp:
  binary: omp                    # omp 可执行路径
  model: ""                      # 默认模型（provider/model-id）
  thinking: auto                 # off|minimal|low|medium|high|xhigh|max|auto
  approval: yolo                 # yolo | write | always-ask（无人值守必须 yolo）
  rpc_timeout_ms: 300000
  session_dir: ""                # 默认 omp 会话目录（~/.omp/agent/sessions）
  extra_args: []                 # 透传给每个 `omp --mode rpc` 的附加参数

# --- 调度 ---
scheduler:
  enabled: true
  tick_s: 60                     # 台账/补触发扫描间隔（croner 本身事件驱动）
  max_concurrent_jobs: 4
  misfire_grace_s: 300           # 错过窗口宽限
  nudge_after_failures: 3        # 连续失败后向 home channel 提醒
  ledger: ~/.omp-gateway/ledger.db  # bun:sqlite 台账文件
  liveness_dir: ""                 # liveness 信号目录（ticker_heartbeat/last_success/last_error）；空 = 关闭
  completed_once_retention_days: 7 # 已完成的 once job 留存天数（0 = 不清理）
  output_retention: 50             # 每个 job 的输出文件留存上限（0 = 不清理）

# --- 投递 ---
delivery:
  default_target: qq             # file | qq | origin
  home_channel: ""               # cron 结果默认投递目标（对等 hermes QQBOT_HOME_CHANNEL）
  wrap_response: true            # 响应包装（时间戳/来源），可关
  silent_trigger: "[SILENT]"     # prompt 前缀触发静默投递
  filter_silence_narration: true # 投递前过滤静音叙述 token（*(silent)*/🔇/裸 "."/"…"）
```

### 1.1 密钥解析
`${VAR}` / `${VAR:-default}` 展开；`!command` 执行取 stdout（10s 超时，缓存进程生命周期）。
规则与 omp 的 MCP 配置一致。

## 2. Job 模型（job store）

`bun:sqlite` 表 `jobs`。调度表达式四类：cron（croner 6 字段含秒）、interval（如 `5m`）、
once（相对 `+30m` / ISO 时间戳）、自然语言（经 NL 解析层转上述三类，见 §3.1）。

```ts
interface Job {
  id: string;                    // 雪花 id
  name: string;                  // 唯一（防重名）
  enabled: boolean;

  schedule: {
    kind: "cron" | "interval" | "once";
    expr: string;                // cron: "0 */5 * * * *" | interval: "5m" | once: "+30m"/ISO
    repeat?: number;             // 覆盖默认（once=1；interval/cron=永久）
  };

  action: {
    type: "agent" | "no-agent";
    // agent 任务：
    prompt: string;              // 或 $ 开头的模板文件引用
    model?: string;              // per-job 模型 pin（fuzzy 或 provider/model-id）
    skills?: string[];           // 注入技能（空=默认全部）
    tools?: string[];            // 工具白名单（空=默认集）
    system_prompt_append?: string;
    context_from?: string[];     // job 链：这些 job 的最新 completed 输出注入本次 prompt
    // no-agent 任务（$0）：
    script?: string;             // shell 脚本内容或文件路径
    wake_agent?: boolean;        // false = 预检门：先跑脚本，仅非空输出时唤醒 agent
  };

  delivery: {
    target: string;              // "file" | "qq" | "origin" | "all"（home+origin 去重）| chatKey 直发；逗号分隔多目标混合；默认取全局 delivery.default_target
    file?: string;               // target=file 时的输出路径
    qq_chat?: string;            // target=qq 时的显式目标（缺省=home_channel）
    silent?: boolean;
    continuable?: boolean;       // 允许回帖续聊（默认 true）
    wrap_response?: boolean;     // 覆盖全局
    markdown_support?: boolean;  // 投递前剥离 markdown（QQ 非 markdown 模式）
  };

  workdir?: string;              // 执行目录（并发 job 串行化锁粒度）
  max_runs?: number;
  ttl_s?: number;                // 单次执行超时

  // 运行时状态（由 ledger/executor 维护）
  status: "idle" | "running" | "disabled";
  next_run: string | null;       // ISO
  last_run: string | null;
  run_count: number;
  fail_streak: number;
  meta?: Record<string, unknown>;  // provider_snapshot：未 pin 模型的 agent job 创建时记录的全局默认（模型漂移守卫快照）
  created_at: string;
  updated_at: string;
}
```

### 2.1 job 管理 API（内部）
`scheduler.jobs.list() / get(id) / add(job) / update(id, patch) / remove(id) /
pause(id) / resume(id) / run(id) / cleanup()`。
命令行对等：`omp-gateway jobs list|add|rm|pause|resume|run`（Phase 1）。

## 3. 调度语义

### 3.1 自然语言解析（NL 层）
输入 `"every 2h"`、`"every sunday 9am"`、`"daily at midnight"` → 归一为 interval/cron。
候选库：`cron-parser`（解析校验）+ 自建映射表；或用 `nl2cron` 类库（实现期评估，需支持
中文输入）。解析失败 → 明确报错并列出支持格式（不静默）。

### 3.2 执行时序
1. croner 到点 → 尝试领取 job（`claimed`，见 §4 台账）
2. 防重叠：同 job 已在跑 → 本次跳过并记 `skipped_overlap`
3. 类型分派：agent → omp-driver；no-agent → 脚本执行器
4. 完成 → 写台账 + 投递；失败 → 写台账 + `fail_streak++`，达阈值触发 nudge
5. misfire：进程重启后扫描 `claimed` 且超时的记录 → 标记 `unknown`，按 `misfire_grace_s`
   决定是否补触发

## 4. 执行台账（ledger）与崩溃恢复

表 `executions`，状态机对齐 hermes `executions.db`：

```
pending ──claim──▶ claimed ──start──▶ running ──success──▶ completed
   │                  │                  │──error───────▶ failed
   │                  │                  └──超时/进程崩溃─▶ unknown
   └──(重启扫描)─────────────────────────────▶ unknown（claimed/running 且超时）
```

```ts
interface Execution {
  id: string;          // jobId + run 序号
  job_id: string;
  status: "pending" | "claimed" | "running" | "completed" | "failed" | "unknown";
  kind: "agent" | "no-agent";
  scheduled_at: string;
  claimed_at: string | null;      // 领取时间戳（崩溃恢复依据）
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;       // no-agent 脚本退出码
  output_ref: string | null;      // 输出位置（文件路径 / artifact id）
  error: string | null;
  meta: Record<string, unknown>;  // 模型、token 用量、投递目标等
}
```

**防重叠**：`jobs.status = running` + `executions.status IN (claimed, running)` 的独占
检查；同 `workdir` 的 job 串行化（文件锁 `workdir/.omp-gateway.lock`）。

**投递义务 ledger（表 `deliveries`）**：QQ 投递先落表再发送，崩溃重启后未完成行重投
（at-least-once）。状态机 `pending → attempting → delivered / failed`（failed 最多重试
N 次后放弃）；重启重投时 attempting 行带 ♻️ 重复标记（诚实 at-least-once，原消息可能已送达）。

**`dead_targets`**：确认不可达的 chat（群被删/被踢/用户停用）短路后续投递，不再每 tick
重试；任一次发送成功自动自愈清除。

## 5. omp 驱动协议（OmpRpcClient）

### 5.1 子进程生命周期
- spawn 方式（对齐官方 `RpcClient.start()`，见 `rpc-client.ts`）：
  `ptree.spawn(["bun", cliPath, "--mode", "rpc", ...omp.extra_args])`，cwd = job workdir 或全局配置 cwd
- **cliPath 两种解析策略**：
  - `PATH` 中的 `omp`（`omp --mode rpc`，用户安装的全局可执行）
  - 包内 CLI 入口：`node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js` + `bun` 解释器
    （官方默认 `cliPath ?? "dist/cli.js"` 是相对 cwd 的搜索）
  - ⚠️ P8 服务化（sc/NSSM）时子进程可能被剥离 PATH，此时必须用**绝对 cliPath**，
    M1 冒烟测试即钉死此策略
- 读 stdout JSONL：`ready` 帧（含 `supportedProtocolVersions`/`maxFrameBytes`）→
  支持 v2 则发 `negotiate_protocol { protocolVersion: 2 }` 并确认响应 → 命令/事件流
- 会话策略：
  - cron job：`--no-session`（每 job 全新）
  - QQ chat：按 `chat_key` 映射 session 文件，`new_session(parent)` 或复用
- 超时/崩溃：`omp.rpc_timeout_ms` 中止；子进程退出码非 0 → 标记 execution unknown 并重试策略

### 5.2 命令面（协议权威源：`@oh-my-pi/pi-coding-agent/src/modes/rpc/`
`rpc-client.ts` / `rpc-frame.ts` / `rpc-types.ts` / `rpc-messages.ts`，安装包内无 docs/）
- 帧编码：JSONL，`encodeRpcFrame`（v1 单帧 ≤1MB；v2 压缩 + `rpc_chunk` 分块，重组上限 64MB）
- 命令（`RpcCommand`）：`prompt { message, images?, streamingBehavior? }` /
  `steer` / `follow_up` / `abort` / `abort_and_prompt` / `new_session { parentSession? }`
- 配置：`set_model { provider, modelId }`、`set_thinking_level { level }`、
  `set_host_tools { tools }`、`set_todos { phases }`
- 事件：`agent_start/end`（`isTerminal` 判定完成）、`turn_start/end`、
  `message_start/update/end`（text_delta 逐 token）、`tool_execution_*`
- `set_host_tools`（注册宿主工具，如 `qq_send`、`task_status`）
- `get_state`、`get_last_assistant_text`

**输出审计与 job 链**：每次运行输出落盘 `outputs/<jobId>/<ts>.txt`（`scheduler.ledger` 同
目录），路径记入 `executions.output_ref`（取回时 >64KB 截断）；`action.context_from` 所列
job 的最新 completed 输出经 `lastOutput` 注入本次 prompt。模型漂移守卫：未 pin 模型的 agent
job 创建时快照全局默认（`meta.provider_snapshot`），当前默认漂移 → fail-closed 不烧 token，
要求显式 pin。

### 5.3 事件面
- `agent_start/end`（`isTerminal` 判定完成）
- `message_update`（text_delta 逐 token → delivery 流式转发）
- `tool_execution_*`（日志/审计）
- 本地实现参考官方 `rpc-client.ts`；本项目自带精简客户端（不依赖包内部路径）。

## 6. QQ 官方 API 契约（qq 模块）

### 6.1 inbound（WebSocket）
- 端点：`wss://api.sgroup.qq.com/`（经 `portal_host` 推导）；鉴权 `Authorization: QQBot <AppID>.<AppSecret>`（分片签名），`X-Union-Appid`。
- 心跳：op 1 帧携带 `d = lastSeq`（最近一次 dispatch seq），按服务器 interval 的 **80%** 发送
  （抗抖动）；op 7（服务器要求重连）关闭连接走 RESUME，op 9（invalid session）丢弃会话重新
  IDENTIFY；断线指数退避 1s→2s→4s→…上限 60s。
- IDENTIFY：`intents` 掩码（按配置位或合成）+ `shard: [0,1]` + `properties`（$os/$browser/$device）。
- 事件：`C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`（含 `GROUP_MESSAGE_CREATE` 全量群消息
  订阅可选）、`DIRECT_MESSAGE_CREATE`、`INTERACTION_CREATE`、频道事件。事件体含 `id`（消息去重）、
  `author.user_openid`/`group_openid`、`content`、`attachments`。
- 语音/附件：优先取 `voice_wav_url`（QQ 预转 WAV，免 SILK 解码），否则下载原始 SILK/AMR 经
  ffmpeg 转 WAV 再送 STT；转写成功注入 `[语音转写] <text>`，失败标记 `[语音识别失败]`；文件附件
  注入 `[file: name (url)]` 交由 agent 处理。
- 引用消息：`message_type 103` 时从 `msg_elements[0]` 解析被引内容与附件（纯引用回复也可用）。
- 去重：以事件 `id` 维护滑动窗口（防重投）。

### 6.2 outbound（REST）
- `POST /v2/users/{openid}/messages`、`POST /v2/groups/{group_openid}/messages`
- body：`{ content, msg_type: 0|2, msg_id? (被动回复), msg_seq, msg_id? }`
- 媒体：先 `POST /v2/{chat}/files` 上传拿 `file_uuid`，再在消息 body 引用（`content` + `media`）。
- Markdown（msg_type 2）：需 QQ 平台模板审核，`qq.markdown_support: false` 默认纯文本。

### 6.3 会话映射（chat store）
`chat_key = "c2c:{openid}" | "group:{group_openid}"`，映射到 omp session 文件路径。
`bun:sqlite` 表 `chat_sessions`：`chat_key PK, session_path, created_at, last_active_at`。
continuable 续聊 = 同一 chat_key 的消息路由到同一 session（RPC 复用该 session 文件）。

### 6.4 安全
- allowlist：`qq.allow` 先行过滤（users/groups/allow_all_users），命中拒绝则静默丢弃并记日志。
- 凭据外泄扫描：投递前扫描 agent 输出与 job prompt 中的 `app_secret`/已知密钥形态
  （`QQBOT_`/`app_secret`/`sk-` 等）→ 命中则脱敏/阻断并告警（对应 hermes 注入扫描）。
- preflight：job 创建时校验 config 有效性（模型可解析、脚本存在、目标可写），失败
  **不烧 token** 直接报错（对应 hermes `blocked_config`）。
- lifecycle guard：拒绝 prompt/script 含网关生命周期命令（kill/pkill/taskkill/reboot/shutdown、
  `sc|nssm|systemctl|launchctl` 等服务控制作用于网关）的 job，并**递归扫描引用的 shell/python 脚本**。
- 附件 URL 安全（SSRF）：仅放行公网 http(s) URL，拒绝回环/私网/链路本地/保留段。
- 附件下载带 `Authorization: QQBot <token>` 头（QQ 多媒体 CDN 要求）。

## 7. 插件壳 ↔ daemon IPC（Phase 2 契约，先定义）

扩展壳与 daemon 通过回环 HTTP（`admin.host:port`，`Authorization: Bearer admin.token`）通信：

| 方向 | 接口 | 说明 |
|---|---|---|
| 壳→daemon | `GET /api/status` | daemon 存活、QQ 连接、运行中 job |
| 壳→daemon | `GET/POST/PATCH/DELETE /api/jobs` | job CRUD（与 CLI 共用） |
| 壳→daemon | `POST /api/chat/{chat_key}/inject` | 把消息注入对应 omp 会话 |
| daemon→壳 | `POST /api/events`（壳侧 Webhook）或 WS `/api/ws` | 事件推送：QQ 来消息、job 完成、nudge |
| 壳→daemon | `POST /api/outbound/qq` | 壳内 agent 调用 `qq_send` 工具时的出口 |

壳内 `qq_send` 工具 = 扩展 `registerTool`，execute 内 POST 上述出口；QQ 来消息事件 →
壳 `pi.sendUserMessage(..., { deliverAs: "steer" })` 注入当前会话（Phase 2）。

## 8. 变更管理
契约变更流程：改本文 → 标注版本/日期 → 相关模块实现同步 → 若涉及持久化格式，
提供迁移脚本（job/executions 表 v1 起步，预留 `schema_version`）。
