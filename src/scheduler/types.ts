/**
 * scheduler 模块核心类型（严格对齐 docs/02-contracts.md §2 Job 模型 / §4 执行台账）。
 * 本模块与其他模块零文件共享：跨模块类型（如 omp 的 AgentEvent）在此声明本地子集，
 * 由 daemon 接线层适配。
 */

/** 任务调度表达式（cron: 6 字段含秒 | interval: "5m" | once: "+30m"/ISO 时间戳） */
export interface JobSchedule {
  kind: "cron" | "interval" | "once";
  expr: string;
  /** 覆盖默认（once=1；interval/cron=永久），缺省由调度器按 kind 决定 */
  repeat?: number;
}

/** 任务动作：agent（调 omp runner）或 no-agent（脚本 + 可选预检门唤醒） */
export interface JobAction {
  type: "agent" | "no-agent";
  /** agent 任务 prompt（no-agent 唤醒时作为唤醒 prompt 使用） */
  prompt?: string;
  /** per-job 模型 pin */
  model?: string;
  /** 注入技能（空 = 默认全部） */
  skills?: string[];
  /** 工具白名单（空 = 默认集） */
  tools?: string[];
  system_prompt_append?: string;
  /** no-agent 脚本内容或文件路径 */
  script?: string;
  /** false = 预检门：先跑脚本，仅非空输出时唤醒 agent */
  wake_agent?: boolean;
}

/** 投递目标 */
export interface JobDelivery {
  target: "file" | "qq" | "origin";
  /** target=file 时的输出路径 */
  file?: string;
  /** target=qq 时的显式目标（缺省 = home channel） */
  qq_chat?: string;
  silent?: boolean;
  /** 允许回帖续聊（默认 true） */
  continuable?: boolean;
  /** 覆盖全局 wrap_response */
  wrap_response?: boolean;
}

/** Job 模型（docs/02-contracts.md §2）。运行时字段由 ledger/scheduler 维护。 */
export interface Job {
  id: string; // 雪花 id（M1 用 crypto.randomUUID）
  name: string; // 唯一（防重名）
  enabled: boolean;

  schedule: JobSchedule;
  action: JobAction;
  delivery: JobDelivery;

  workdir?: string; // 执行目录
  max_runs?: number;
  ttl_s?: number; // 单次执行超时（秒）

  // 运行时状态（由 ledger/executor 维护）
  status: "idle" | "running" | "disabled";
  next_run: string | null; // ISO；由调度器算好后经 add/update 传入
  last_run: string | null;
  run_count: number;
  fail_streak: number;
  created_at: string;
  updated_at: string;
}

/** add() 入参：去掉 id 与全部运行时字段；next_run 由调度器算好传入（缺省 null） */
export type JobInput = Omit<
  Job,
  "id" | "status" | "next_run" | "last_run" | "run_count" | "fail_streak" | "created_at" | "updated_at"
> & { next_run?: string | null };

export type ExecutionStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "unknown";

/** 执行台账记录（docs/02-contracts.md §4，状态机 pending→claimed→running→completed/failed，崩溃→unknown） */
export interface Execution {
  id: string; // jobId + run 序号
  job_id: string;
  status: ExecutionStatus;
  kind: "agent" | "no-agent";
  scheduled_at: string;
  claimed_at: string | null; // 领取时间戳（崩溃恢复依据）
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null; // no-agent 脚本退出码
  output_ref: string | null; // 输出位置（文件路径 / artifact id）
  error: string | null;
  meta: Record<string, unknown>; // 模型、token 用量、投递目标等
}

/** executor 产出（M1：ok + output；error/exitCode/meta 可选） */
export interface RunResult {
  ok: boolean;
  output: string;
  error?: string;
  exitCode?: number;
  meta?: Record<string, unknown>;
}

/**
 * agent 执行器接口。真实实现由 daemon 用 OmpRpcClient 适配（omp 模块），
 * M1 单元测试用 fake。
 */
export interface AgentRunner {
  run(
    prompt: string,
    opts: { model?: string; cwd?: string; timeoutMs?: number },
  ): Promise<RunResult>;
}

/**
 * omp 协议事件本地子集（omp 模块定义权威版本，此处仅声明调度器需要的字段，
 * 供后续流式投递/审计使用；M1 未被 executor 使用）。
 */
export type AgentEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "agent_end"; isTerminal: boolean }
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "error"; message: string };
