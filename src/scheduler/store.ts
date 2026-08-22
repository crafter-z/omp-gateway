/**
 * Job 持久化存储（bun:sqlite）。
 * 三表：jobs / executions / chat_sessions，PRAGMA user_version 版本迁移（v1 起步）。
 * executions 的增删改由 ledger.ts 通过本类的 `db` 句柄操作（台账状态机专属）。
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Job, JobInput } from "./types.ts";

/** jobs 表行（schedule/action/delivery 为 JSON 文本列） */
interface JobRow {
  id: string;
  name: string;
  enabled: number;
  schedule: string;
  action: string;
  delivery: string;
  workdir: string | null;
  max_runs: number | null;
  ttl_s: number | null;
  status: Job["status"];
  next_run: string | null;
  last_run: string | null;
  run_count: number;
  fail_streak: number;
  meta: string;
  created_at: string;
  updated_at: string;
}

const SCHEMA_VERSION = 2;

export class JobStore {
  /** 对外暴露的 db 句柄：ledger（executions）与 chat 模块（chat_sessions）复用同一连接 */
  readonly db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /**
   * 迁移（幂等，按 user_version 分步）：
   * v0→1：建 jobs / executions / chat_sessions 三表 + 索引；
   * v1→2：jobs 增加 meta 列（JSON，记录创建来源等；anti-loop 防绕过依赖它）。
   */
  private migrate(): void {
    const current = this.db
      .query<{ user_version: number }, SQLQueryBindings[]>("PRAGMA user_version")
      .get()!.user_version;
    if (current >= SCHEMA_VERSION) return;
    this.db.transaction(() => {
      if (current < 1) {
        this.createV1Tables();
      }
      if (current < 2) {
        // 已有 v1 库可能已手工加过该列（防御性）：查列存在性
        const cols = this.db.query<{ name: string }, SQLQueryBindings[]>("PRAGMA table_info(jobs)").all();
        if (!cols.some((c) => c.name === "meta")) {
          this.db.run("ALTER TABLE jobs ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'");
        }
      }
      this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }

  private createV1Tables(): void {
    this.db.run(`
        CREATE TABLE IF NOT EXISTS jobs (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL UNIQUE,
          enabled    INTEGER NOT NULL,
          schedule   TEXT NOT NULL,
          action     TEXT NOT NULL,
          delivery   TEXT NOT NULL,
          workdir    TEXT,
          max_runs   INTEGER,
          ttl_s      INTEGER,
          status     TEXT NOT NULL,
          next_run   TEXT,
          last_run   TEXT,
          run_count  INTEGER NOT NULL DEFAULT 0,
          fail_streak INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    this.db.run(`
        CREATE TABLE IF NOT EXISTS executions (
          id           TEXT PRIMARY KEY,
          job_id       TEXT NOT NULL,
          status       TEXT NOT NULL,
          kind         TEXT NOT NULL,
          scheduled_at TEXT NOT NULL,
          claimed_at   TEXT,
          started_at   TEXT,
          finished_at  TEXT,
          exit_code    INTEGER,
          output_ref   TEXT,
          error        TEXT,
          meta         TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        )
      `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_executions_job_status ON executions(job_id, status)",
    );
    this.db.run(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          chat_key       TEXT PRIMARY KEY,
          session_path   TEXT NOT NULL,
          created_at     TEXT NOT NULL,
          last_active_at TEXT NOT NULL
        )
      `);
  }

  list(): Job[] {
    return (
      this.db
        .query<JobRow, SQLQueryBindings[]>("SELECT * FROM jobs ORDER BY created_at ASC, name ASC")
        .all()
        .map(rowToJob)
    );
  }

  get(id: string): Job | undefined {
    const row = this.db.query<JobRow, SQLQueryBindings[]>("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? rowToJob(row) : undefined;
  }

  getByName(name: string): Job | undefined {
    const row = this.db.query<JobRow, SQLQueryBindings[]>("SELECT * FROM jobs WHERE name = ?").get(name);
    return row ? rowToJob(row) : undefined;
  }

  /** 新增 job：生成 id、默认运行时字段；next_run 由调度器算好后传入（缺省 null）。 */
  add(input: JobInput): Job {
    if (this.getByName(input.name)) {
      throw new Error(`job name already exists: ${input.name}`);
    }
    const now = new Date().toISOString();
    const job: Job = {
      id: crypto.randomUUID(),
      name: input.name,
      enabled: input.enabled,
      schedule: input.schedule,
      action: input.action,
      delivery: input.delivery,
      workdir: input.workdir,
      max_runs: input.max_runs,
      ttl_s: input.ttl_s,
      status: "idle",
      next_run: input.next_run ?? null,
      last_run: null,
      run_count: 0,
      fail_streak: 0,
      meta: input.meta ?? {},
      created_at: now,
      updated_at: now,
    };
    this.db
      .query(
        `INSERT INTO jobs (id, name, enabled, schedule, action, delivery, workdir, max_runs, ttl_s,
                           status, next_run, last_run, run_count, fail_streak, meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.name,
        job.enabled ? 1 : 0,
        JSON.stringify(job.schedule),
        JSON.stringify(job.action),
        JSON.stringify(job.delivery),
        job.workdir ?? null,
        job.max_runs ?? null,
        job.ttl_s ?? null,
        job.status,
        job.next_run,
        job.last_run,
        job.run_count,
        job.fail_streak,
        JSON.stringify(job.meta),
        job.created_at,
        job.updated_at,
      );
    return job;
  }

  /** 合并 patch 更新（ledger 回写 last_run/run_count/fail_streak/status 亦走此路径），始终刷新 updated_at。 */
  update(id: string, patch: Partial<Job>): Job {
    const existing = this.get(id);
    if (!existing) throw new Error(`job not found: ${id}`);
    // 过滤 undefined，避免覆盖列值为 null
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) clean[k] = v;
    }
    const merged: Job = { ...existing, ...(clean as Partial<Job>), updated_at: new Date().toISOString() };
    this.db
      .query(
        `UPDATE jobs SET name=?, enabled=?, schedule=?, action=?, delivery=?, workdir=?, max_runs=?, ttl_s=?,
                         status=?, next_run=?, last_run=?, run_count=?, fail_streak=?, meta=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        merged.name,
        merged.enabled ? 1 : 0,
        JSON.stringify(merged.schedule),
        JSON.stringify(merged.action),
        JSON.stringify(merged.delivery),
        merged.workdir ?? null,
        merged.max_runs ?? null,
        merged.ttl_s ?? null,
        merged.status,
        merged.next_run,
        merged.last_run,
        merged.run_count,
        merged.fail_streak,
        JSON.stringify(merged.meta ?? {}),
        merged.updated_at,
        merged.id,
      );
    return merged;
  }

  /** 删除 job（运行中禁止；级联清理其 executions）。 */
  remove(id: string): void {
    const job = this.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    if (job.status === "running") {
      throw new Error(`cannot remove running job: ${id}`);
    }
    this.db.transaction(() => {
      this.db.run("DELETE FROM executions WHERE job_id = ?", [id]);
      this.db.run("DELETE FROM jobs WHERE id = ?", [id]);
    })();
  }

  pause(id: string): Job {
    const job = this.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    // 运行中仅置 enabled=false（状态保持 running 以维持防重叠），完成时由 ledger 回写为 disabled
    return this.update(id, { enabled: false, status: job.status === "running" ? "running" : "disabled" });
  }

  resume(id: string): Job {
    const job = this.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    return this.update(id, { enabled: true, status: job.status === "running" ? "running" : "idle" });
  }
}

/** 行 → Job（JSON 子对象反序列化） */
function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled !== 0,
    schedule: JSON.parse(row.schedule),
    action: JSON.parse(row.action),
    delivery: JSON.parse(row.delivery),
    workdir: row.workdir ?? undefined,
    max_runs: row.max_runs ?? undefined,
    ttl_s: row.ttl_s ?? undefined,
    status: row.status,
    next_run: row.next_run ?? null,
    last_run: row.last_run ?? null,
    run_count: row.run_count,
    fail_streak: row.fail_streak,
    meta: JSON.parse(row.meta ?? "{}"),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
