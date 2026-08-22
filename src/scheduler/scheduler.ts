/**
 * 调度器：croner 注册 enabled job（cron/interval/once 三类表达式），触发时走
 * ledger.claim 防重叠 + maxConcurrentJobs 并发闸，执行完成后回写台账与 next_run；
 * 周期 tick 扫描超时台账（→ unknown），并在 misfireGraceS 宽限窗口内对
 * enabled 且未在跑的 job 补跑一次（P5）。
 *
 * 启动时对"宕机期间错过"的 once job 补救：目标时间落在宽限窗口内 → 立即补跑；
 * 超出窗口 → next_run 清空并记日志（明确死亡，不再静默悬挂）。
 *
 * 日志：默认 console.error，可经 opts.log 注入（daemon 接线为 util/logger）。
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import type { Job, RunResult } from "./types.ts";
import type { JobStore } from "./store.ts";
import { Ledger } from "./ledger.ts";
import type { Executor } from "./executor.ts";
import { intervalToCron, onceDate } from "./expr.ts";

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
  /** 日志注入（缺省 console.error）。 */
  log?: (message: string) => void;
  /** liveness 信号目录（hermes ticker_heartbeat/last_success/last_error 对等）；空 = 关闭。 */
  livenessDir?: string;
  /** 输出审计目录（daemon 传 dirname(ledger)/outputs）；空 = 关闭输出裁剪。 */
  outputsDir?: string;
  /** 已完成的 once job 留存天数（超过则清理）；0 = 关闭。 */
  completedOnceRetentionDays?: number;
  /** 每个 job 的 output 文件留存上限（默认 50）；0 = 关闭。 */
  outputRetention?: number;
}

const MAX_TERMINAL_EXECUTIONS = 1000;

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
      if (this.catchUpMissedOnce(job)) continue; // 已补跑或已宣告死亡，不再注册
      this.register(job);
    }
    this.tickHandle = setInterval(() => {
      void this.onTick();
    }, this.opts.tickS * 1000);
  }

  /**
   * 宕机期间错过的 once job 补救（misfire catch-up 覆盖不到"从未触发"的 job）：
   * - 目标时间在宽限窗口内 → 立即补跑一次（走 fire 的 claim/台账/投递全链路），返回 true；
   * - 目标时间已过且超出窗口 → next_run 清空 + 日志，明确死亡而非静默悬挂，返回 true；
   * - 未来时间或非 once → false（正常注册流程）。
   */
  private catchUpMissedOnce(job: Job): boolean {
    if (job.schedule.kind !== "once") return false;
    const target = onceDate(job.schedule.expr);
    if (!target || target.getTime() > Date.now()) return false;
    const missedByMs = Date.now() - target.getTime();
    if (missedByMs <= this.opts.misfireGraceS * 1000) {
      this.log(
        `once job ${job.id} (${job.name}) missed while down ${Math.round(missedByMs / 1000)}s ago — firing now`,
      );
      void this.fire(job.id).then(() => {
        // once 补跑后无 croner 注册（register 会跳过已过期 once），直接清 next_run
        this.store.update(job.id, { next_run: null });
      });
      return true;
    }
    this.store.update(job.id, { next_run: null });
    this.log(
      `once job ${job.id} (${job.name}) expired ${Math.round(missedByMs / 1000)}s ago (beyond grace window) — not firing`,
    );
    return true;
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
          // 已完成（run_count 达上限）的 once job 不再重新武装——交给留存清理。
          if (job.run_count >= (sched.repeat ?? 1)) {
            this.log(`skip job ${job.id} (${job.name}): once job already completed (${job.run_count} run(s))`);
            this.store.update(job.id, { next_run: null });
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
        const outputRef = (result.meta?.output_ref as string | undefined) ?? null;
        this.ledger.markCompleted(execution.id, outputRef, result.meta);
      } else {
        this.ledger.markFailed(execution.id, result.error ?? "execution failed", result.exitCode ?? null, result.meta);
      }
      this.opts.onResult?.(this.store.get(jobId) ?? job, result);
      if (result.ok) this.writeLiveness("ticker_last_success", `${job.name} ok`);
      else this.writeLiveness("ticker_last_error", `${job.name}: ${(result.error ?? "failed").slice(0, 120)}`);
    } catch (e) {
      this.ledger.markFailed(execution.id, e instanceof Error ? e.message : String(e));
      const errText = e instanceof Error ? e.message : String(e);
      this.opts.onResult?.(this.store.get(jobId) ?? job, { ok: false, output: "", error: errText });
      this.writeLiveness("ticker_last_error", `${job.name}: ${errText.slice(0, 120)}`);
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
   * 同时执行维护任务：liveness 心跳、台账/输出清理、once 留存清理。
   */
  private onTick(): void {
    this.writeLiveness("ticker_heartbeat");
    // 稳态维护与 misfire 扫描解耦：即使没有超时台账，裁剪/留存也必须每 tick 执行。
    this.maintain();
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

  /**
   * 后台维护（在 tick 中低频执行）：
   * - executions 终态行裁剪（保留最新 MAX_TERMINAL_EXECUTIONS 行）
   * - 已完成的 once job 留存清理（completedOnceRetentionDays）
   * - per-job output 文件留存裁剪（outputRetention）
   */
  private maintain(): void {
    try {
      this.store.db.run(
        `DELETE FROM executions WHERE status IN ('completed','failed','unknown')
           AND id NOT IN (
             SELECT id FROM executions WHERE status IN ('completed','failed','unknown')
             ORDER BY finished_at DESC LIMIT ?
           )`,
        [MAX_TERMINAL_EXECUTIONS],
      );
    } catch (e) {
      this.log(`execution prune failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const retentionDays = this.opts.completedOnceRetentionDays;
    if (retentionDays && retentionDays > 0) {
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      try {
        for (const job of this.store.list()) {
          if (job.schedule.kind !== "once") continue;
          if (job.next_run !== null) continue; // 未触发完成
          const repeats = job.schedule.repeat ?? 1;
          if (job.run_count < repeats) continue;
          // 留存计时以完成时间（last_run）为准——updated_at 会被管理操作刷新。
          const anchor = job.last_run ?? job.updated_at;
          if (anchor !== null && anchor < cutoff) {
            this.log(`removing completed once job ${job.id} (${job.name}) after ${retentionDays}d retention`);
            this.store.remove(job.id);
            this.sync(job.id);
          }
        }
      } catch (e) {
        this.log(`once retention failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const outputRetention = this.opts.outputRetention ?? 50;
    if (outputRetention > 0 && this.opts.outputsDir) {
      try {
        void pruneOutputs(this.opts.outputsDir, outputRetention);
      } catch {
        // best-effort
      }
    }
  }

  /** 写 liveness 信号文件（ticker_heartbeat / last_success / last_error）。 */
  private writeLiveness(name: "ticker_heartbeat" | "ticker_last_success" | "ticker_last_error", detail = ""): void {
    const dir = this.opts.livenessDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const line = `${new Date().toISOString()} ${detail}`.trim();
      writeFileSync(join(dir, name), line + "\n");
    } catch {
      // best-effort: liveness files never break scheduling
    }
  }

  private log(message: string): void {
    const line = `[scheduler] ${new Date().toISOString()} ${message}`;
    if (this.opts.log) this.opts.log(message);
    else console.error(line);
  }
}

/** 每个 job 子目录只保留最新的 N 个 output 文件（异步 best-effort）。 */
async function pruneOutputs(outputsDir: string, keep: number): Promise<void> {
  let jobDirs: string[];
  try {
    jobDirs = readdirSync(outputsDir);
  } catch {
    return; // 目录不存在 → 无事可做
  }
  for (const dir of jobDirs) {
    const full = join(outputsDir, dir);
    let files: string[];
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      files = readdirSync(full);
    } catch {
      continue;
    }
    const byMtime = files
      .map((f) => ({ f, path: join(full, f) }))
      .sort((a, b) => {
        try {
          return statSync(b.path).mtimeMs - statSync(a.path).mtimeMs;
        } catch {
          return 0;
        }
      });
    for (const { path } of byMtime.slice(keep)) {
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
    }
  }
}
