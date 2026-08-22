import { describe, expect, test } from "bun:test";
import { JobStore } from "../../src/scheduler/store.ts";
import { Ledger } from "../../src/scheduler/ledger.ts";
import type { Job, JobInput } from "../../src/scheduler/types.ts";

function makeInput(overrides: Partial<JobInput> = {}): JobInput {
  return {
    name: `job-${crypto.randomUUID().slice(0, 8)}`,
    enabled: true,
    schedule: { kind: "interval", expr: "5m" },
    action: { type: "agent", prompt: "hello" },
    delivery: { target: "file" },
    next_run: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

/** 手工把 execution 的锚点时间戳回拨（模拟崩溃残留 / 长时间运行） */
function backdate(store: JobStore, execId: string, field: "claimed_at" | "started_at", agoMs: number) {
  const old = new Date(Date.now() - agoMs).toISOString();
  store.db.run(`UPDATE executions SET ${field} = ? WHERE id = ?`, [old, execId]);
}

describe("Ledger.claim", () => {
  let store: JobStore;
  let ledger: Ledger;

  test("first claim succeeds and transitions job to running", () => {
    store = new JobStore(":memory:");
    ledger = new Ledger(store);
    const job = store.add(makeInput());

    const exec = ledger.claim(job);
    expect(exec).not.toBeNull();
    expect(exec!.id).toBe(`${job.id}:1`); // jobId + run 序号
    expect(exec!.job_id).toBe(job.id);
    expect(exec!.status).toBe("claimed");
    expect(exec!.kind).toBe("agent");
    expect(exec!.scheduled_at).toBe(job.next_run!);
    expect(exec!.claimed_at).not.toBeNull();
    expect(exec!.started_at).toBeNull();
    expect(exec!.meta).toEqual({});

    expect(store.get(job.id)!.status).toBe("running");
  });

  test("claim returns null while job.status is running", () => {
    const job = store.get(store.list()[0].id)!;
    expect(ledger.claim(job)).toBeNull();
  });

  test("claim returns null when a recent claimed execution exists even if job status was reset", () => {
    const job = store.add(makeInput());
    const exec = ledger.claim(job)!;
    expect(exec.status).toBe("claimed");
    // 模拟崩溃恢复已把 job 状态复位，但 execution 仍占用且未超时
    store.update(job.id, { status: "idle" });
    expect(ledger.claim(job)).toBeNull();
  });

  test("claim supersedes a stale claimed execution (crash residue)", () => {
    store = new JobStore(":memory:");
    ledger = new Ledger(store, { claimTimeoutMs: 100 });
    const job = store.add(makeInput());

    const first = ledger.claim(job)!;
    backdate(store, first.id, "claimed_at", 5_000);
    store.update(job.id, { status: "idle" }); // 崩溃后状态已复位

    const second = ledger.claim(job);
    expect(second).not.toBeNull();
    expect(second!.id).toBe(`${job.id}:2`);
    // 旧记录被标记 unknown，不再占用
    const old = store.db.query("SELECT status FROM executions WHERE id = ?").get(first.id) as { status: string };
    expect(old.status).toBe("unknown");
  });

  test("claim respects job.ttl_s for stale judgement", () => {
    store = new JobStore(":memory:");
    ledger = new Ledger(store); // 默认 claimTimeoutMs 5 分钟
    const job = store.add(makeInput({ ttl_s: 1 }));
    const first = ledger.claim(job)!;
    backdate(store, first.id, "claimed_at", 5_000); // 远超 ttl=1s
    store.update(job.id, { status: "idle" });
    expect(ledger.claim(job)).not.toBeNull();
  });
});

describe("Ledger state transitions", () => {
  test("claim → markRunning → markCompleted writes execution + job counters", () => {
    const store = new JobStore(":memory:");
    const ledger = new Ledger(store);
    const job = store.add(makeInput());

    const exec = ledger.claim(job)!;
    ledger.markRunning(exec.id);
    const running = store.db
      .query("SELECT status, started_at FROM executions WHERE id = ?")
      .get(exec.id) as { status: string; started_at: string | null };
    expect(running.status).toBe("running");
    expect(running.started_at).not.toBeNull();
    expect(store.get(job.id)!.status).toBe("running");

    ledger.markCompleted(exec.id, null, { wokeAgent: false });
    const done = store.db
      .query("SELECT status, finished_at, output_ref, exit_code, error, meta FROM executions WHERE id = ?")
      .get(exec.id) as {
      status: string; finished_at: string | null; output_ref: string | null;
      exit_code: number | null; error: string | null; meta: string;
    };
    expect(done.status).toBe("completed");
    expect(done.finished_at).not.toBeNull();
    expect(done.output_ref).toBeNull();
    expect(done.exit_code).toBe(0);
    expect(done.error).toBeNull();
    expect(JSON.parse(done.meta)).toEqual({ wokeAgent: false });

    const j = store.get(job.id)!;
    expect(j.status).toBe("idle");
    expect(j.run_count).toBe(1);
    expect(j.fail_streak).toBe(0);
    expect(j.last_run).toBe(done.finished_at);

    // 完成后可再次领取（run 序号递增）
    const second = ledger.claim(j);
    expect(second).not.toBeNull();
    expect(second!.id).toBe(`${job.id}:2`);
  });

  test("markFailed increments fail_streak and stores error", () => {
    const store = new JobStore(":memory:");
    const ledger = new Ledger(store);
    const job = store.add(makeInput());
    const exec = ledger.claim(job)!;
    ledger.markRunning(exec.id);
    ledger.markFailed(exec.id, "boom", 7);

    const done = store.db.query("SELECT status, error, exit_code FROM executions WHERE id = ?").get(exec.id) as {
      status: string; error: string | null; exit_code: number | null;
    };
    expect(done.status).toBe("failed");
    expect(done.error).toBe("boom");
    expect(done.exit_code).toBe(7);

    const j = store.get(job.id)!;
    expect(j.status).toBe("idle");
    expect(j.fail_streak).toBe(1);
    expect(j.run_count).toBe(1);
    expect(j.last_run).not.toBeNull();
  });

  test("markSkipped records a failed execution with skipped meta and bumps fail_streak", () => {
    const store = new JobStore(":memory:");
    const ledger = new Ledger(store);
    const job = store.add(makeInput({ schedule: { kind: "once", expr: "2026-08-20T10:05:00.000Z" } }));
    const exec = ledger.markSkipped(job, "skipped: maxConcurrentJobs reached");

    expect(exec.status).toBe("failed");
    expect(exec.error).toBe("skipped: maxConcurrentJobs reached");
    expect(exec.meta).toEqual({ skipped: true });
    expect(exec.finished_at).not.toBeNull();

    const row = store.db
      .query<{ status: string; error: string | null; claimed_at: string | null; started_at: string | null }, [string]>(
        "SELECT status, error, claimed_at, started_at FROM executions WHERE id = ?",
      )
      .get(exec.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("skipped: maxConcurrentJobs reached");
    expect(row.claimed_at).toBeNull(); // 未经过 claim 状态机
    expect(row.started_at).toBeNull();

    const j = store.get(job.id)!;
    expect(j.fail_streak).toBe(1);
    expect(j.run_count).toBe(1);
    expect(j.last_run).not.toBeNull();
  });

  test("markCompleted on a paused job restores status to disabled", () => {
    const store = new JobStore(":memory:");
    const ledger = new Ledger(store);
    const job = store.add(makeInput());
    const exec = ledger.claim(job)!;
    store.pause(job.id); // 运行中暂停：enabled=false，status 保持 running
    ledger.markCompleted(exec.id, null);
    expect(store.get(job.id)!.status).toBe("disabled");
    expect(store.get(job.id)!.enabled).toBe(false);
  });

  test("markUnknown resets job status without touching counters", () => {
    const store = new JobStore(":memory:");
    const ledger = new Ledger(store);
    const job = store.add(makeInput());
    const exec = ledger.claim(job)!;
    ledger.markRunning(exec.id);

    const marked = ledger.markUnknown(exec.id, "crash");
    expect(marked).not.toBeNull();
    expect(marked!.status).toBe("unknown");
    expect(marked!.finished_at).not.toBeNull();
    expect(marked!.error).toBe("crash");

    const j = store.get(job.id)!;
    expect(j.status).toBe("idle");
    expect(j.run_count).toBe(0);
    expect(j.fail_streak).toBe(0);
    expect(j.last_run).toBeNull();
  });
});

describe("Ledger.scanStale", () => {
  test("marks stale running/claimed executions unknown and returns them", () => {
    const store = new JobStore(":memory:");
    const ledger = new Ledger(store);
    const jobA = store.add(makeInput());
    const jobB = store.add(makeInput());

    const runningA = ledger.claim(jobA)!;
    ledger.markRunning(runningA.id);
    backdate(store, runningA.id, "started_at", 120_000);

    const claimedB = ledger.claim(jobB)!;
    backdate(store, claimedB.id, "claimed_at", 120_000);

    // 一个未超时的对照
    const jobC = store.add(makeInput());
    const freshC = ledger.claim(jobC)!;
    ledger.markRunning(freshC.id);

    const stale = ledger.scanStale(60_000);
    expect(stale.map((e) => e.id).sort()).toEqual([runningA.id, claimedB.id].sort());
    for (const s of stale) {
      expect(s.status).toBe("unknown");
      expect(s.finished_at).not.toBeNull();
      expect(s.error).toContain("stale");
    }
    // 未超时的对照不受影响
    const c = store.db.query("SELECT status FROM executions WHERE id = ?").get(freshC.id) as { status: string };
    expect(c.status).toBe("running");
    // job 状态全部复位为 idle
    expect(store.get(jobA.id)!.status).toBe("idle");
    expect(store.get(jobB.id)!.status).toBe("idle");
    expect(store.get(jobC.id)!.status).toBe("running");
  });

  test("scanStale returns empty when nothing is stale", () => {
    const store = new JobStore(":memory:");
    const ledger = new Ledger(store);
    const job = store.add(makeInput());
    const exec = ledger.claim(job)!;
    ledger.markRunning(exec.id);
    expect(ledger.scanStale(60_000)).toEqual([]);
  });
});
