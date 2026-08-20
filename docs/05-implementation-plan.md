# 05 — 具体实现计划

> 状态：定稿。把 `04-roadmap.md` 的 P0–P8 展开到**文件级与接口级**：技术选型、
> 依赖清单、完整文件树、核心 TS 类型草案、每阶段步骤与验收、测试策略、实现期决策点。
> 契约以 `02-contracts.md` 为准，本文件只定义"怎么实现"，不重复定义契约。

## 1. 技术选型定稿

| 关注点 | 选型 | 理由 | 备选 |
|---|---|---|---|
| 运行时 | Bun ≥1.3.14（omp 同栈） | 内置 WebSocket/fetch/SQLite/测试器；`bun build --compile` 单文件 | Node（无内置 sqlite/ws 需装包） |
| 调度 | `croner` | 6 字段含秒、时区、isRunning 查询 | node-cron（5 字段、无时区） |
| 配置校验 | `zod` | 类型即 schema，报错友好 | ajv（无类型推导） |
| YAML | `yaml` | 生态标准 | 手写解析（不现实） |
| CLI | `commander` | 成熟、子命令/参数解析 | 手写 Bun.argv（脆弱） |
| SQLite | `bun:sqlite`（内置） | 零依赖、同步 API、够用 | better-sqlite3（Node 插件，需编译） |
| QQ WS | Bun 原生 `WebSocket` | 标准 API、免依赖 | `ws` 包 / 官方 `@qq/qq-bot-sdk` |
| QQ REST | 原生 `fetch` | Bun 内置 | axios |
| 日志 | 自建轻量 logger（<100 行） | level + stdout/文件 + 轮转预留；少一个依赖 | pino（结构化，后续可换） |
| 文件锁 | 目录原子 `mkdir`（`EEXIST` 判定） | Windows 上 flock 不可用；mkdir 原子跨平台 | proper-lockfile |
| 测试 | `bun test` 内置 | 零依赖，含 mock | vitest |
| CI | GitHub Actions（ubuntu + windows） | 双平台跑测试 | — |
| NL 解析 | **自建关键词映射**（见 §7 决策 D1） | 中文支持可控 | nl2cron / cron-parser |

## 2. 依赖清单

```jsonc
// package.json (草案)
{
  "name": "omp-gateway",
  "version": "0.1.0",
  "type": "module",
  "bin": { "omp-gateway": "./src/index.ts" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "dev": "bun --watch src/index.ts",
    "build": "bun build --compile src/index.ts --outfile dist/omp-gateway"
  },
  "dependencies": {
    "croner": "^9.0.0",
    "zod": "^3.24.0",
    "yaml": "^2.6.0",
    "commander": "^12.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/bun": "latest"
  }
}
```

`omp.extensions` manifest（Phase 2 插件壳用，P7 添加）：
```jsonc
{
  "omp": {
    "extensions": ["./src/extension/index.ts"]
  }
}
```

## 3. 完整文件树

```
omp-gateway/
├── package.json / tsconfig.json / bunfig.toml
├── .github/workflows/ci.yml          # P8
├── src/
│   ├── index.ts                      # CLI 入口（commander 注册全部子命令）
│   ├── daemon.ts                     # Daemon 生命周期编排
│   ├── config/
│   │   ├── schema.ts                 # zod schema（02 §1 全量字段）
│   │   ├── secret.ts                 # ${VAR}/!command 解析
│   │   └── load.ts                   # yaml + env + 校验 + fail-fast
│   ├── util/
│   │   ├── logger.ts                 # 轻量日志（level/stdout/file）
│   │   ├── lock.ts                   # 目录锁（原子 mkdir）
│   │   ├── scan.ts                   # 凭据外泄扫描
│   │   └── time.ts                   # ISO/相对时间解析、格式化
│   ├── scheduler/
│   │   ├── store.ts                  # bun:sqlite：jobs/executions/chat_sessions + migrations
│   │   ├── ledger.ts                 # 台账状态机 + claim 防重叠 + scanStale
│   │   ├── nl.ts                     # NL → schedule 解析（P5）
│   │   ├── executor.ts               # 分派 agent / no-agent
│   │   ├── nudge.ts                  # 失败连击提醒（P5）
│   │   └── scheduler.ts              # croner 注册 + tick 扫描
│   ├── omp/
│   │   ├── protocol.ts               # JSONL 帧编解码 + v1/v2 协商 + 事件分类
│   │   ├── client.ts                 # OmpRpcClient（spawn/命令/事件流/超时/孤儿回收）
│   │   └── session.ts                # --no-session 与 session 文件复用参数构造
│   ├── qq/
│   │   ├── events.ts                 # WS 事件 → InboundMessage 归一
│   │   ├── gateway.ts                # WS 连接/心跳/重连退避/去重窗口
│   │   ├── rest.ts                   # 鉴权 + 文本/媒体 REST 发送
│   │   ├── chat.ts                   # chat_key → session 映射（复用 store）
│   │   └── stt.ts                    # ASR 透传 + STT fallback（P6）
│   ├── delivery/
│   │   ├── index.ts                  # 路由 + 包装 + SILENT + 外泄扫描挂载
│   │   ├── file.ts / qq.ts / origin.ts
│   │   └── format.ts                 # 响应包装、分段
│   ├── admin/
│   │   └── server.ts                 # Bun.serve 管理面 + 事件推送 WS（P7 复用）
│   ├── cli/
│   │   ├── start.ts / stop.ts / status.ts
│   │   ├── jobs.ts                   # add/list/rm/pause/resume/run
│   │   ├── run-prompt.ts             # P2 开发用：手动触发一次 agent 会话
│   │   └── service.ts                # Windows 服务安装/卸载（P8）
│   └── extension/
│       └── index.ts                  # omp 插件壳（P7）：/gateway、qq_send、job_add、事件注入
├── tests/
│   ├── fixtures/
│   │   ├── fake-omp.ts               # 模拟 omp rpc 子进程（回显/流式帧）
│   │   └── ws-server.ts              # 本地 WS server 模拟 QQ Gateway
│   ├── unit/                         # config/secret/nl/ledger/scan/lock/protocol/time
│   ├── integration/                  # executor→fake-omp、qq→ws-server、delivery 路由
│   └── smoke/                        # 端到端：真实 omp 一轮 prompt（P2+）
├── scripts/smoke.ts                  # 冒烟脚本入口
└── docs/01..05
```

## 4. 核心类型草案（实现骨架）

以下为模块公共接口的 TS 签名草案，实现按此展开，契约细节以 02-contracts 为准。

```ts
// ---- config ----
interface GatewayConfig {
  timezone: string;
  log: { level: "debug"|"info"|"warn"|"error"; file: string };
  admin: { host: string; port: number; token: string };
  qq: QqConfig;
  omp: OmpConfig;
  scheduler: SchedulerConfig;
  delivery: DeliveryConfig;
}
type QqConfig = { /* 02 §1 逐字段 */ };
type OmpConfig = { binary: string; model: string; thinking: string;
  approval: "yolo"|"write"|"always-ask"; rpc_timeout_ms: number;
  session_dir: string; extra_args: string[] };

// ---- daemon ----
class Daemon {
  constructor(cfg: GatewayConfig);
  async start(): Promise<void>;   // 装模块 → 连 QQ → 起 scheduler → 挂 admin
  async stop(): Promise<void>;    // 优雅：停领取 → 等运行中 job 完成/超时 → 断连
  status(): DaemonStatus;         // { qq: "connected"|"disconnected", scheduler: "running"|"stopped", running_jobs: number }
}

// ---- scheduler ----
interface JobStore {
  list(): Job[];  get(id: string): Job | undefined;
  add(input: JobInput): Job;  update(id: string, patch: Partial<Job>): Job;
  remove(id: string): void;   // 未运行才允许
}
interface Executor {
  execute(job: Job, scheduledAt: Date): Promise<Execution>;
}
interface Ledger {
  claim(job: Job): Execution | null;   // pending→claimed；已占用返回 null（防重叠）
  markRunning(id: string): void;
  markCompleted(id: string, outputRef: string | null): void;
  markFailed(id: string, error: string): void;
  scanStale(timeoutMs: number): Execution[];  // claimed/running 超时 → unknown（重启恢复）
}
class Scheduler {
  constructor(store: JobStore, executor: Executor, opts: SchedulerConfig);
  start(): void;  stop(): void;
  private onTick(): Promise<void>;   // 扫描未知台账 + misfire 补触发
}

// ---- omp ----
type AgentEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "agent_end"; isTerminal: boolean; usage?: unknown }
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "error"; message: string };
class OmpRpcClient {
  constructor(opts: OmpClientOpts);
  // OmpClientOpts: { cliPath, cwd, model, thinking, approval, extraArgs, timeoutMs, env? }
  // cliPath 解析策略（对应 02 §5.1）：
  //   1) PATH 中的 `omp`：spawn(["bun", "omp", "--mode", "rpc", ...])
  //   2) 包内 cli.js：spawn(["bun", <abs>/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js, "--mode", "rpc", ...])
  //   默认：PATH `omp`；P8 服务化须显式传绝对 cliPath（PATH 可能被剥离）
  async connect(): Promise<void>;     // spawn + ready 握手 + v2 协商（v1 兜底）
  prompt(req: { message: string; images?: string[] }): AsyncIterable<AgentEvent>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setHostTools(defs: HostToolDef[]): Promise<void>;
  close(): Promise<void>;             // 优雅关闭 + 孤儿进程回收（Windows: taskkill /T /F 兜底）
}

// ---- qq ----
interface InboundMessage {
  id: string;  chatKey: string;  authorOpenid: string;
  text: string;
  attachments: { type: "image"|"voice"|"file"; url: string; asrText?: string }[];
  raw: unknown;
}
type ChatRef = { chatKey: string; openid: string };   // c2c: openid; group: group_openid
class QqGateway {
  constructor(cfg: QqConfig, handler: (m: InboundMessage) => Promise<void>);
  async connect(): Promise<void>;     // WS + 心跳 + 指数退避重连 + 去重
  send(chat: ChatRef, text: string): Promise<void>;
  sendMedia(chat: ChatRef, filePath: string, kind: "image"|"file"): Promise<void>;
  async stop(): Promise<void>;
}

// ---- delivery ----
interface Delivery {
  deliver(run: RunResult, job: Job): Promise<void>;
  // 路由 target → file|qq|origin；应用包装/SILENT；挂载外泄扫描
}
```

## 5. 阶段步骤（P0–P8 细化）

### P0 — 脚手架
1. `bun init -y`；写入 §2 依赖；`bun add croner zod yaml commander`
2. 建 §3 目录树（空文件占位 + 每个模块放 `// TODO(P#)` 注释标记归属阶段）
3. tsconfig 用 Bun 默认（`bunx tsc --init` 后按 bunfig 调）
4. 验收：`bun test` 空跑通过；`bun run src/index.ts --help` 输出帮助

### P1 — daemon 骨架 + config + CLI
1. `util/logger.ts`：level 过滤、stdout + 文件双写、轮转预留（大小阈值，后续）
2. `config/schema.ts`：02 §1 全量 zod schema（含 `qq.app_secret` 必填校验）
3. `config/secret.ts`：`${VAR}`/`${VAR:-default}`/`!command`（10s 超时）展开
4. `config/load.ts`：yaml → secret 展开 → env 前缀覆盖 → zod parse → 友好错误（列出字段路径）
5. `cli/start.ts`：前台运行 + `--daemon` 后台（`Bun.spawn` 自身，pid 文件 `~/.omp-gateway/pid`）；
   `cli/stop.ts`：读 pid → 优雅信号 → 超时强杀（Windows 用 `taskkill /T`）；`cli/status.ts`：pid/日志/模块状态
6. `daemon.ts`：模块注册表 + start/stop 编排骨架（各模块 P3/P4 填入）
7. `tests/unit/config.test.ts`、`secret.test.ts`：合法/非法配置、env 覆盖、!command
8. 验收：坏 config 启动报错退出码非 0；`start` 起进程、`status` 正常、`stop` 优雅退出

### P2 — omp 驱动
1. `omp/protocol.ts`：JSONL 帧编解码；`ready` 握手、v1/v2 协商；事件分类（agent_start/end、
   message_update/text_delta、tool_execution_*、error）
2. `omp/client.ts`：spawn（stdin/stdout 管道）→ 握手 → `prompt()` 返回 AsyncIterable；
   `steer/followUp/abort/setModel/setThinkingLevel/setHostTools`；`rpc_timeout_ms` 中止；
   close 时回收孤儿进程（Windows：`taskkill /T /F` 兜底）
3. `omp/session.ts`：`--no-session`（cron）与 `-r <session_path>`（QQ 复用）参数构造
4. `cli/run-prompt.ts`：开发命令 `omp-gateway run-prompt "..."`（前台流式打印）
5. `tests/fixtures/fake-omp.ts`：可执行脚本模拟 rpc 子进程（读 stdin JSONL，按脚本回显
   ready/分块 text_delta/agent_end）；`tests/integration/client.test.ts`
6. 验收：`run-prompt "1+1"` 真实 omp 完成一轮对话拿到文本（冒烟）；超时中止路径测试通过

### P3 — scheduler 最小集（interval/once）
1. `scheduler/store.ts`：`bun:sqlite` 三表（jobs/executions/chat_sessions）+ `schema_version`
   迁移框架（v1 起步）；Job 增删改查
2. `scheduler/ledger.ts`：claim（`jobs.status` + executions 占用双重检查，重叠返回 null）、
   状态机流转、`scanStale(timeoutMs)`（claimed/running 超时 → unknown）
3. `scheduler/executor.ts`：agent 分派 = 新建 OmpRpcClient（`--no-session`）→ prompt →
   结果回传；超时/退出码异常 → markFailed；`util/lock.ts` 目录锁（workdir 串行化）
4. `scheduler/scheduler.ts`：croner 注册 interval/once job；`setInterval(tick_s)` 周期
   `scanStale` + misfire 扫描（P5 完整化）
5. `cli/jobs.ts`：add/list/rm/pause/resume/run
6. `tests/unit/ledger.test.ts`（内存 db：防重叠、状态机、scanStale）、`store.test.ts`
7. 验收：`jobs add --every 5m --prompt "..."` 周期执行、台账落库；重启后 scanStale
   将旧 claimed 标 unknown 且不重复执行

### P4 — qq 模块（文本收发）
1. `qq/events.ts`：C2C/GROUP_AT 事件 → InboundMessage（含附件归一、去重字段）
2. `qq/gateway.ts`：WS 连接（鉴权头、`X-Union-Appid`）、心跳、断线 RESUMED/指数退避重连
   （1s→60s）、消息 id 滑动窗口去重；注入 `handler`
3. `qq/rest.ts`：签名 token、`POST /v2/users|groups/{openid}/messages`（msg_type 0 文本、
   被动回复带 `msg_id`）
4. `qq/chat.ts`：chat_key ↔ session 文件映射（复用 store 表；空=新建，查表=复用）
5. 接线（daemon.ts）：inbound → OmpRpcClient（复用 session）→ prompt → delivery.qq 回原 chat
6. `tests/fixtures/ws-server.ts`：本地 WS server 模拟 QQ Gateway（推送构造 C2C 事件）；
   `tests/integration/gateway.test.ts`（重连、去重）；rest 用 fetch mock
7. 验收：模拟 C2C 消息 → agent 回复回原 chat；断线自动重连；重复事件只处理一次

### P5 — scheduler 完整
1. `scheduler/nl.ts`：中文/英文关键词映射 → cron/interval/once（"每天 9 点"→`0 0 9 * * *`、
   "每 5 分钟"→interval 5m、"every sunday 9am"→`0 0 9 * * 0`）；用 croner 校验产出；
   解析失败返回明确错误（列出支持格式）；用例表驱动
2. executor 增加 no-agent 分派：`script` 执行（Bun.spawn，workdir）、退出码、stdout 捕获、
   空输出静默、非零退出告警、`wake_agent:false` 预检门（非空输出才唤醒 agent 处理）
3. `scheduler/nudge.ts`：fail_streak ≥ 阈值 → delivery 向 home channel 发提醒并清零
4. misfire：scanStale 后对 `misfire_grace_s` 窗口内的 missed 触发补跑（可选执行，默认补跑）
5. preflight：job add 时校验（模型可解析、script 存在、workdir 可写、delivery target 合法）→
   失败零 token 报错；`util/scan.ts` 外泄扫描（app_secret/sk-/Bearer/QQBOT_ 等模式）挂到
   delivery 出口与 prompt 注入前
6. 模型解析顺序 fail-closed：`job.action.model` → `omp.model` → 报错（不静默回退会话默认）
7. `tests/unit/nl.test.ts`（用例表）、`scan.test.ts`、executor no-agent 用例
8. 验收：对齐 `03-capability-gap.md §4` 验收清单（除 P7 插件项）

### P6 — delivery 完整
1. `delivery/file.ts|qq.ts|origin.ts` + `index.ts`：target 路由、home channel 默认、
   SILENT 前缀、响应包装（时间戳/来源）、continuable 路由（回复回原 chat）
2. 流式转发：message_update 文本增量 → 缓冲分段发送（QQ 单条限制内聚合，超限分批）
3. qq 媒体：图片下载 → omp prompt `images` 入参（视觉）；语音 `asr_refer_text` 透传 +
   `stt.ts` fallback（zai glm-asr / openai 兼容端点）；文件上传 REST（`POST /v2/{chat}/files` → file_uuid → 消息引用）
4. `tests/integration/delivery.test.ts`：三 target 路由、SILENT、外泄扫描拦截
5. 验收：cron 结果默认进 home channel；`[SILENT]` 静默；QQ 续聊回原 chat；图片可入视觉

### P7 — 插件壳（Phase 2）
1. `admin/server.ts`：Bun.serve（127.0.0.1:18765），`Authorization: Bearer` 鉴权，
   GET/POST/PATCH/DELETE /api/jobs、GET /api/status、POST /api/outbound/qq、
   WS /api/ws 事件推送（QQ 来消息、job 完成、nudge）
2. `extension/index.ts`（omp 扩展）：
   - `registerCommand`：`/gateway status|start|stop|jobs`
   - `registerTool`：`qq_send`（execute → POST /api/outbound/qq）、`job_add/list/rm`
   - `pi.on` 事件（admin WS 推送）→ `sendUserMessage({ deliverAs: "steer" })` 注入当前会话
   - job 防死循环：agent 创建的 job 不得再创建调度 job（来源标记 + 环检测）
3. package.json 加 `omp.extensions` manifest；发布为 npm 包可 `omp plugin install`
4. 验收：`omp plugin install omp-gateway` 后 TUI 内 `/gateway status` 可用；QQ 消息注入
   当前会话；agent 调 `qq_send` 发出消息

### P8 — 加固与发布
1. `bun build --compile` 单文件（daemon 可执行，dist/omp-gateway）
2. `cli/service.ts`：Windows 服务（`sc create` 或 NSSM 封装）install/uninstall/status
3. CI：`.github/workflows/ci.yml`（ubuntu + windows，`bun install && bun test && tsc --noEmit`）
4. 测试补全至覆盖 §6 策略矩阵；README/docs 与实现对齐；CHANGELOG 起步
5. 验收：打包可执行独立运行（含 QQ 冒烟）；双平台 CI 绿

## 6. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元 | `bun test` | config 解析/secret 展开、NL 用例表、ledger 状态机（内存 sqlite）、scan 模式、lock 并发、protocol 编解码、time 解析 |
| 集成 | fixtures（fake-omp / ws-server / fetch mock） | executor→omp 分派与超时、QQ 重连与去重、delivery 路由与外泄拦截、rest 发送 |
| 冒烟 | `scripts/smoke.ts` | P2 起真实 omp 一轮 prompt；P4 起真实 QQ（需要凭证，用 sandbox 环境变量注入） |

原则：协议边界（omp rpc、QQ API）全部用 fixture mock，不依赖外部网络跑单元/集成；
冒烟层才触真实服务。契约变更先改 docs/02 再改实现与 fixture。

## 7. 实现期决策点（默认已定，遇反例再改）

| # | 决策点 | 默认 | 触发改判条件 |
|---|---|---|---|
| D1 | NL 解析 | 自建关键词映射（中英文），croner 校验 | 输入形态超出映射表容忍度时评估 nl2cron |
| D2 | QQ 客户端 | 自建（Bun 原生 WS/fetch） | 官方 API 出现签名/协议复杂化，评估 @qq/qq-bot-sdk |
| D3 | rpc 协议版本 | v2 优先，v1 兜底；权威源 = 安装包 `src/modes/rpc/*.ts`（无 docs/） | 实际 omp 版本行为与源码不符时以实测为准并回写文档 |
| D4 | Windows 后台 | pid 文件 + `taskkill /T` | 不稳定则提前 sc/NSSM（P8 内容前移） |
| D5 | 流式转发 | 缓冲分段发送 | 若 QQ 对逐 token 消息限流明显，改为最终结果一次性发送（保留流式日志） |

## 8. 里程碑

- M1（P0–P2）：可手动触发 agent 会话的 daemon 骨架 —— 首个可演示里程碑
- M2（P3–P4）：cron interval + QQ 文本收发闭环 —— 双核心能力通
- M3（P5–P6）：scheduler 全量语义 + delivery 完整 —— 对齐 hermes 验收清单
- M4（P7–P8）：插件壳 + 打包发布 —— 可 `omp plugin install` 的完整交付
