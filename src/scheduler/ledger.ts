/**
 * 执行台账（docs/02-contracts.md §4）：状态机 pending→claimed→running→completed/failed，
 * 崩溃/超时→unknown。防重叠：jobs.status===running 或存在未超时的 claimed/running
 * execution 时 claim 返回 null。
 *
 * executions 表由本类独占读写（通过 JobStore.db 句柄）；job 运行时字段回写经 JobStore.update。
 */
import type { SQLQueryBindings } from "bun:sqlite";
import type { Execution, ExecutionStatus, Job } from "./types.ts";
import type { JobStore } from "./store.ts";

/** executions 表行 */
interface ExecRow {
  id: string;
  job_id: string;
  status: ExecutionStatus;
  kind: Execution["kind"];
  scheduled_at: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  output_ref: string | null;
  error: string | null;
  meta: string;
}

export interface LedgerOptions {
  /** claim 防重叠判定中 "claimed 未超时" 的窗口（job.ttl_s 优先，缺省 5 分钟） */
  claimTimeoutMs?: number;
}

const DEFAULT_CLAIM_TIMEOUT_MS = 5 * 60_000;

export class Ledger {
  private readonly claimTimeoutMs: number;

  constructor(
    private readonly store: JobStore,
    opts: LedgerOptions = {},
  ) {
    this.claimTimeoutMs = opts.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  }

  /**
   * 领取 job：防重叠检查通过则插入 pending→claimed 记录并把 jobs.status 置 running。
   * 重叠（jobs.status===running，或存在 claimed/running 且 claimed_at 未超时的 execution）→ null。
   * 崩溃残留（claimed/running 但已超时）会被先标记 unknown 再允许重新领取。
   */
  claim(job: Job): Execution | null {
    if (job.status === "running") return null;

    const nowMs = Date.now();
    const timeoutMs = job.ttl_s !== undefined ? job.ttl_s * 1000 : this.claimTimeoutMs;

    const occupied = this.store.db
      .query<ExecRow, SQLQueryBindings[]>(
        "SELECT * FROM executions WHERE job_id = ? AND status IN ('claimed','running')",
      )
      .all(job.id);

    for (const row of occupied) {
      const anchor = row.status === "running" ? row.started_at : row.claimed_at;
      const anchorMs = anchor ? new Date(anchor).getTime() : nowMs;
      if (nowMs - anchorMs < timeoutMs) {
        // 未超时 → 防重叠
        return null;
      }
      // 超时残留（进程崩溃/重启后未被 scanStale 清理）→ 先标记 unknown 再继续
      this.markUnknown(row.id, "stale claim superseded by new claim");
    }

    const nowIso = new Date(nowMs).toISOString();
    // 执行序号 = 该 job 已有 execution 数 + 1（保证唯一：supersede 残留不占新号）
    const prev = this.store.db
      .query<{ n: number }, SQLQueryBindings[]>("SELECT COUNT(*) AS n FROM executions WHERE job_id = ?")
      .get(job.id)!;
    const id = `${job.id}:${prev.n + 1}`;
    const execution: Execution = {
      id,
      job_id: job.id,
      status: "claimed",
      kind: job.action.type,
      scheduled_at: job.next_run ?? nowIso,
      claimed_at: nowIso,
      started_at: null,
      finished_at: null,
      exit_code: null,
      output_ref: null,
      error: null,
      meta: {},
    };
    this.store.db
      .query(
        `INSERT INTO executions
           (id, job_id, status, kind, scheduled_at, claimed_at, started_at, finished_at, exit_code, output_ref, error, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.id,
        execution.job_id,
        execution.status,
        execution.kind,
        execution.scheduled_at,
        execution.claimed_at,
        null,
        null,
        null,
        null,
        null,
        "{}",
      );
    this.store.update(job.id, { status: "running" });
    return execution;
  }

  /**
   * claimed → running，记 started_at。返回 false 表示该 execution 已不处于
   * claimed（如已被 scanStale 置 unknown）——调用方应放弃后续终态写入。
   */
  markRunning(id: string): boolean {
    const changes = this.store.db
      .query("UPDATE executions SET status = 'running', started_at = ? WHERE id = ? AND status = 'claimed'")
      .run(new Date().toISOString(), id);
    return changes.changes > 0;
  }

  /**
   * running → completed。同步回写 jobs：last_run / run_count+1 / fail_streak=0 / status。
   * 带状态守卫：仅当 execution 仍是 claimed/running 时生效——防止 scanStale 已把
   * 长时间运行标为 unknown 后，迟到的完成写入污染台账历史。
   */
  markCompleted(id: string, outputRef: string | null, meta?: Record<string, unknown>): boolean {
    const row = this.getRow(id);
    if (!row) throw new Error(`execution not found: ${id}`);
    const now = new Date().toISOString();
    const changes = this.store.db
      .query(
        "UPDATE executions SET status='completed', finished_at=?, output_ref=?, exit_code=0, error=NULL, meta=? WHERE id=? AND status IN ('claimed','running')",
      )
      .run(now, outputRef, JSON.stringify(meta ?? {}), id);
    if (changes.changes === 0) return false;
    this.syncJobAfterFinish(row.job_id, "completed", now);
    return true;
  }

  /** running → failed。同步回写 jobs：last_run / run_count+1 / fail_streak+1 / status。同 markCompleted 带守卫。 */
  markFailed(id: string, error: string, exitCode?: number | null, meta?: Record<string, unknown>): boolean {
    const row = this.getRow(id);
    if (!row) throw new Error(`execution not found: ${id}`);
    const now = new Date().toISOString();
    const changes = this.store.db
      .query(
        "UPDATE executions SET status='failed', finished_at=?, error=?, exit_code=?, meta=? WHERE id=? AND status IN ('claimed','running')",
      )
      .run(now, error, exitCode ?? null, JSON.stringify(meta ?? {}), id);
    if (changes.changes === 0) return false;
    this.syncJobAfterFinish(row.job_id, "failed", now);
    return true;
  }

  /**
   * 并发闸满等未真正执行的场景：直接落一条 failed 台账（不经过 claim 状态机），
   * error=reason、meta.skipped=true，并按失败回写 job（fail_streak++、last_run、status 复位）。
   * 用于 once job 被 maxConcurrentJobs 跳过时的诚实记账——否则 once 无下次触发，静默丢失。
   */
  markSkipped(job: Job, reason: string): Execution {
    const nowIso = new Date().toISOString();
    const prev = this.store.db
      .query<{ n: number }, SQLQueryBindings[]>("SELECT COUNT(*) AS n FROM executions WHERE job_id = ?")
      .get(job.id)!;
    const execution: Execution = {
      id: `${job.id}:${prev.n + 1}`,
      job_id: job.id,
      status: "failed",
      kind: job.action.type,
      scheduled_at: job.next_run ?? nowIso,
      claimed_at: null,
      started_at: null,
      finished_at: nowIso,
      exit_code: null,
      output_ref: null,
      error: reason,
      meta: { skipped: true },
    };
    this.store.db
      .query(
        `INSERT INTO executions
           (id, job_id, status, kind, scheduled_at, claimed_at, started_at, finished_at, exit_code, output_ref, error, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.id,
        execution.job_id,
        execution.status,
        execution.kind,
        execution.scheduled_at,
        null,
        null,
        execution.finished_at,
        null,
        null,
        execution.error,
        JSON.stringify(execution.meta),
      );
    this.syncJobAfterFinish(job.id, "failed", nowIso);
    return execution;
  }

  /**
   * 超时/崩溃 → unknown；把 jobs.status 复位为 idle/disabled（不动 last_run/run_count/fail_streak）。
   * 带状态守卫：仅 claimed/running 会被置 unknown；job 状态复位仅在没有其他
   * 占用中的 execution 时执行（防止复位并发新 claim 的 running 状态）。
   */
  markUnknown(id: string, error: string | null = null): Execution | null {
    const row = this.getRow(id);
    if (!row) return null;
    if (row.status !== "claimed" && row.status !== "running") return null;
    const now = new Date().toISOString();
    const changes = this.store.db
      .query("UPDATE executions SET status='unknown', finished_at=?, error=? WHERE id=? AND status IN ('claimed','running')")
      .run(now, error, id);
    if (changes.changes === 0) return null;
    const job = this.store.get(row.job_id);
    if (job && job.status === "running" && !this.hasOccupyingExecution(row.job_id)) {
      this.store.update(row.job_id, { status: job.enabled ? "idle" : "disabled" });
    }
    return { ...rowToExecution(row), status: "unknown", finished_at: now, error };
  }

  /**
   * 扫描超时台账：claimed/running 且其锚点时间戳（running→started_at，claimed→claimed_at）
   * 距今超过 timeoutMs → 置 unknown 并返回这些记录（重启恢复 / misfire 扫描）。
   */
  scanStale(timeoutMs: number): Execution[] {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const rows = this.store.db
      .query<ExecRow, SQLQueryBindings[]>(
        `SELECT * FROM executions WHERE status IN ('claimed','running')
           AND (CASE status WHEN 'running' THEN started_at ELSE claimed_at END) IS NOT NULL
           AND (CASE status WHEN 'running' THEN started_at ELSE claimed_at END) < ?`,
      )
      .all(cutoff);
    const stale: Execution[] = [];
    for (const row of rows) {
      const marked = this.markUnknown(row.id, `stale after ${timeoutMs}ms`);
      if (marked) stale.push(marked);
    }
    return stale;
  }

  /** 完成/失败后回写 job 运行时字段并复位状态（enabled=false 时回写 disabled）。 */
  private syncJobAfterFinish(jobId: string, outcome: "completed" | "failed", finishedAt: string): void {
    const job = this.store.get(jobId);
    if (!job) return;
    this.store.update(jobId, {
      status: job.enabled ? "idle" : "disabled",
      last_run: finishedAt,
      run_count: job.run_count + 1,
      fail_streak: outcome === "completed" ? 0 : job.fail_streak + 1,
    });
  }
  /** 该 job 是否仍存在占用中的 execution（claimed/running）。 */
  private hasOccupyingExecution(jobId: string): boolean {
    const row = this.store.db
      .query<{ n: number }, SQLQueryBindings[]>(
        "SELECT COUNT(*) AS n FROM executions WHERE job_id = ? AND status IN ('claimed','running')",
      )
      .get(jobId)!;
    return row.n > 0;
  }

  private getRow(id: string): ExecRow | null {
    return this.store.db.query<ExecRow, SQLQueryBindings[]>("SELECT * FROM executions WHERE id = ?").get(id) ?? null;
  }
}

/** 行 → Execution（meta 反序列化） */
function rowToExecution(row: ExecRow): Execution {
  return {
    id: row.id,
    job_id: row.job_id,
    status: row.status,
    kind: row.kind,
    scheduled_at: row.scheduled_at,
    claimed_at: row.claimed_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    exit_code: row.exit_code,
    output_ref: row.output_ref,
    error: row.error,
    meta: (() => {
      try {
        return JSON.parse(row.meta) as Record<string, unknown>;
      } catch {
        return {};
      }
    })(),
  };
}
