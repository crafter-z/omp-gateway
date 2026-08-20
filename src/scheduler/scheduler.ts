/**
 * 调度器：croner 注册 enabled job（cron/interval/once 三类表达式），触发时走
 * ledger.claim 防重叠 + maxConcurrentJobs 并发闸，执行完成后回写台账与 next_run；
 * 周期 tick 扫描超时台账（→ unknown），并在 misfireGraceS 宽限窗口内对
 * enabled 且未在跑的 job 补跑一次（P5）。
 *
 * M1 依赖说明：模块间零文件共享，故内部自带轻量日志（console.error），
 * daemon 接线时可替换为 util/logger。
 */
import { Cron } from "croner";
import type { Job, RunResult } from "./types.ts";
import type { JobStore } from "./store.ts";
import { Ledger } from "./ledger.ts";
import type { Executor } from "./executor.ts";

export interface SchedulerOptions {
  /** croner 求值时区（IANA，如 Asia/Shanghai） */
  timezone: string;
  /** 台账/补触发扫描间隔（秒） */
  tickS: number;
  /** 最大并发执行数 */
  maxConcurrentJobs: number;
  /** misfire 宽限窗口（秒）；M1 兼作 scanStale 的默认超时 */
  misfireGraceS: number;
  /** 执行完成回调（daemon 投递 hook）。result 为 executor 原始产出，job 为触发时的快照。 */
  onResult?: (job: Job, result: RunResult) => void;
}

export class Scheduler {
  private readonly ledger: Ledger;
  private readonly crons = new Map<string, Cron>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private activeCount = 0;
  private readonly inFlight = new Set<string>();
  /** 已补跑过的 execution id（防同一 unknown 记录被重复补跑） */
  private readonly misfired = new Set<string>();
  private started = false;

  constructor(
    private readonly store: JobStore,
    private readonly executor: Executor,
    private readonly opts: SchedulerOptions,
    ledger?: Ledger,
  ) {
    // 缺省自建 ledger（与 daemon 共享同一 store，故状态一致）；也允许注入以便测试
    this.ledger = ledger ?? new Ledger(store);
  }

  /** 加载 enabled job 注册 croner；启动周期 tick。幂等。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of this.store.list()) {
      if (!job.enabled) continue;
      if (job.status === "running") {
        this.log(`skip scheduling job ${job.id} (${job.name}): status running, awaiting scanStale recovery`);
        continue;
      }
      this.register(job);
    }
    this.tickHandle = setInterval(() => {
      void this.onTick();
    }, this.opts.tickS * 1000);
  }

  /** 停止全部 croner 并清 tick。 */
  stop(): void {
    this.started = false;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    for (const cron of this.crons.values()) cron.stop();
    this.crons.clear();
  }

  /** 注册单个 job 到 croner，并把计算出的 next_run 持久化。 */
  private register(job: Job): void {
    const sched = job.schedule;
    let pattern: string | Date;
    let maxRuns: number;
    try {
      switch (sched.kind) {
        case "cron":
          pattern = sched.expr;
          maxRuns = sched.repeat ?? Infinity;
          break;
        case "interval":
          pattern = intervalToCron(sched.expr);
          maxRuns = sched.repeat ?? Infinity;
          break;
        case "once": {
          const target = onceDate(sched.expr);
          if (!target) {
            this.log(`skip job ${job.id} (${job.name}): invalid once expression "${sched.expr}"`);
            return;
          }
          if (target.getTime() <= Date.now()) {
            this.log(`skip job ${job.id} (${job.name}): once time already passed`);
            return;
          }
          pattern = target;
          maxRuns = 1;
          break;
        }
      }
    } catch (e) {
      this.log(`skip job ${job.id} (${job.name}): ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    let cron: Cron;
    try {
      cron = new Cron(
        pattern,
        { timezone: this.opts.timezone, maxRuns, protect: false },
        () => {
          void this.fire(job.id);
        },
      );
    } catch (e) {
      this.log(
        `failed to schedule job ${job.id} (${job.name}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    this.crons.set(job.id, cron);

    const next = cron.nextRun();
    if (next) {
      const nextIso = next.toISOString();
      if (nextIso !== job.next_run) {
        this.store.update(job.id, { next_run: nextIso });
      }
    }
  }

  /**
   * croner 触发入口：并发闸 → ledger.claim 防重叠 → markRunning → executor.execute →
   * 按结果 markCompleted/markFailed → 回写 next_run。
   */
  private async fire(jobId: string): Promise<void> {
    const job = this.store.get(jobId);
    if (!job || !job.enabled) return;

    if (this.activeCount >= this.opts.maxConcurrentJobs) {
      this.log(`skip ${jobId}: maxConcurrentJobs (${this.opts.maxConcurrentJobs}) reached`);
      return;
    }
    if (this.inFlight.has(jobId)) return; // 二次防线（claim 层已有防重叠）

    const execution = this.ledger.claim(job);
    if (!execution) {
      this.log(`skip ${jobId}: overlap or already claimed`);
      return;
    }

    this.activeCount += 1;
    this.inFlight.add(jobId);
    try {
      this.ledger.markRunning(execution.id);
      const result = await this.executor.execute(job, new Date(execution.scheduled_at));
      if (result.ok) {
        this.ledger.markCompleted(execution.id, null, result.meta);
      } else {
        this.ledger.markFailed(execution.id, result.error ?? "execution failed", result.exitCode ?? null, result.meta);
      }
      this.opts.onResult?.(this.store.get(jobId) ?? job, result);
    } catch (e) {
      this.ledger.markFailed(execution.id, e instanceof Error ? e.message : String(e));
      this.opts.onResult?.(this.store.get(jobId) ?? job, { ok: false, output: "", error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.activeCount -= 1;
      this.inFlight.delete(jobId);
      this.persistNextRun(jobId);
    }
  }

  /**
   * 动态同步单个 job 的 croner 注册（CLI add/pause/resume/rm 后热更新，无需重启 daemon）。
   * 幂等：已注册先停再按当前状态重注册。
   */
  sync(jobId: string): void {
    const existing = this.crons.get(jobId);
    if (existing) {
      existing.stop();
      this.crons.delete(jobId);
    }
    const job = this.store.get(jobId);
    if (!job || !job.enabled) return;
    if (job.status === "running") {
      this.log(`skip scheduling job ${job.id} (${job.name}): status running, awaiting scanStale recovery`);
      return;
    }
    this.register(job);
  }

  /** 执行结束后把 croner 的下一次触发时间回写 jobs.next_run（once 结束后为 null）。 */
  private persistNextRun(jobId: string): void {
    const cron = this.crons.get(jobId);
    const job = this.store.get(jobId);
    if (!cron || !job) return;
    const next = cron.nextRun();
    this.store.update(jobId, { next_run: next ? next.toISOString() : null });
  }

  /**
   * 周期扫描：超时台账 → unknown；随后对 scheduled_at 落在 misfireGraceS 宽限窗口内、
   * job 仍 enabled 且未在跑的 execution 触发一次补跑（防重复：execution id 记入集合）。
   */
  private onTick(): void {
    const timeoutMs = this.opts.misfireGraceS * 1000;
    const stale = this.ledger.scanStale(timeoutMs);
    for (const s of stale) {
      this.log(`execution ${s.id} (job ${s.job_id}) marked unknown: stale after ${timeoutMs}ms`);
    }
    if (stale.length === 0) return;

    const nowMs = Date.now();
    for (const s of stale) {
      if (this.misfired.has(s.id)) continue; // 已补跑过，防重复
      const scheduledMs = new Date(s.scheduled_at).getTime();
      if (!Number.isFinite(scheduledMs) || nowMs - scheduledMs > this.opts.misfireGraceS * 1000) {
        continue; // 超出宽限窗口，放弃补跑
      }
      const job = this.store.get(s.job_id);
      if (!job || !job.enabled) continue;
      if (job.status === "running" || this.inFlight.has(s.job_id)) continue;
      this.misfired.add(s.id);
      this.log(
        `misfire recovery: re-firing job ${job.id} (${job.name}) for execution ${s.id} scheduled at ${s.scheduled_at}`,
      );
      void this.fire(s.job_id);
    }
  }

  private log(message: string): void {
    // 轻量内部日志（M1），daemon 接线可替换为 util/logger
    console.error(`[scheduler] ${new Date().toISOString()} ${message}`);
  }
}

/** interval 表达式（"5m"）→ croner 6 字段 cron 表达式 */
function intervalToCron(expr: string): string {
  const m = /^(\d+)(s|m|h|d)$/i.exec(expr.trim());
  if (!m) {
    throw new Error(`invalid interval expression "${expr}" (expected e.g. 30s, 5m, 2h, 1d)`);
  }
  const n = parseInt(m[1], 10);
  if (n <= 0) throw new Error(`invalid interval "${expr}": must be positive`);
  switch (m[2].toLowerCase()) {
    case "s":
      return `*/${n} * * * * *`;
    case "m":
      return `0 */${n} * * * *`;
    case "h":
      return `0 0 */${n} * * *`;
    case "d":
      return `0 0 0 */${n} * *`;
    default:
      throw new Error(`unsupported interval unit in "${expr}"`);
  }
}

/** once 表达式 → 目标 Date；"+30m" 相对时间或 ISO 时间戳；非法 → null */
function onceDate(expr: string): Date | null {
  const trimmed = expr.trim();
  if (trimmed.startsWith("+")) {
    const rel = /^(\d+)(s|m|h|d)$/i.exec(trimmed.slice(1).trim());
    if (!rel) return null;
    const n = parseInt(rel[1], 10);
    const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return new Date(Date.now() + n * unitMs[rel[2].toLowerCase()]);
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}
