import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQLQueryBindings } from "bun:sqlite";
import { JobStore } from "../../src/scheduler/store.ts";
import type { JobInput } from "../../src/scheduler/types.ts";

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

describe("JobStore (in-memory)", () => {
  let store: JobStore;

  beforeAll(() => {
    store = new JobStore(":memory:");
  });
  afterAll(() => {
    store.close();
  });

  test("add returns a fully-defaulted Job", () => {
    const job = store.add(makeInput());
    expect(job.id).toBeTypeOf("string");
    expect(job.id.length).toBeGreaterThan(0);
    expect(job.status).toBe("idle");
    expect(job.run_count).toBe(0);
    expect(job.fail_streak).toBe(0);
    expect(job.last_run).toBeNull();
    expect(job.next_run).toBe("2026-08-20T10:00:00.000Z");
    expect(new Date(job.created_at).getTime()).not.toBeNaN();
    expect(job.updated_at).toBe(job.created_at);
  });

  test("add defaults next_run to null when omitted", () => {
    const job = store.add(makeInput({ next_run: undefined }));
    expect(job.next_run).toBeNull();
  });

  test("get round-trips JSON sub-objects", () => {
    const input = makeInput({
      schedule: { kind: "cron", expr: "0 0 9 * * *", repeat: 3 },
      action: { type: "no-agent", script: "process.exit(0)", wake_agent: true },
      delivery: { target: "qq", qq_chat: "group:abc", silent: true },
      workdir: "C:/tmp/wd",
      max_runs: 10,
      ttl_s: 60,
    });
    const job = store.add(input);
    const got = store.get(job.id);
    expect(got).toBeDefined();
    expect(got!.schedule).toEqual(input.schedule);
    expect(got!.action).toEqual(input.action);
    expect(got!.delivery).toEqual(input.delivery);
    expect(got!.workdir).toBe("C:/tmp/wd");
    expect(got!.max_runs).toBe(10);
    expect(got!.ttl_s).toBe(60);
  });

  test("list returns all jobs ordered by creation", () => {
    const a = store.add(makeInput());
    const b = store.add(makeInput());
    const ids = store.list().map((j) => j.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("update merges patch and refreshes updated_at", () => {
    const job = store.add(makeInput());
    const patched = store.update(job.id, { enabled: false, schedule: { kind: "cron", expr: "0 * * * * *" } });
    expect(patched.enabled).toBe(false);
    expect(patched.schedule).toEqual({ kind: "cron", expr: "0 * * * * *" });
    expect(patched.name).toBe(job.name); // 未 patch 字段保留
    expect(new Date(patched.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(job.updated_at).getTime(),
    );
    const reloaded = store.get(job.id)!;
    expect(reloaded.enabled).toBe(false);
    expect(reloaded.schedule).toEqual({ kind: "cron", expr: "0 * * * * *" });
  });

  test("update with undefined patch values keeps stored values", () => {
    const job = store.add(makeInput());
    const patched = store.update(job.id, { workdir: undefined, max_runs: undefined, ttl_s: undefined });
    expect(patched.workdir).toBeUndefined();
    expect(patched.max_runs).toBeUndefined();
    expect(patched.ttl_s).toBeUndefined();
  });

  test("update on missing id throws", () => {
    expect(() => store.update("nope", { enabled: false })).toThrow(/not found/);
  });

  test("remove deletes the job and its executions", () => {
    const job = store.add(makeInput());
    store.db.run(
      "INSERT INTO executions (id, job_id, status, kind, scheduled_at, meta) VALUES (?,?,?,?,?,?)",
      [`${job.id}:1`, job.id, "claimed", "agent", "2026-08-20T09:00:00.000Z", "{}"],
    );
    store.remove(job.id);
    expect(store.get(job.id)).toBeUndefined();
    const left = store.db.query("SELECT COUNT(*) AS n FROM executions WHERE job_id = ?").get(job.id) as { n: number };
    expect(left.n).toBe(0);
  });

  test("remove on running job throws", () => {
    const job = store.add(makeInput());
    store.update(job.id, { status: "running" });
    expect(() => store.remove(job.id)).toThrow(/running/);
  });

  test("remove on missing id throws", () => {
    expect(() => store.remove("nope")).toThrow(/not found/);
  });

  test("add rejects duplicate names", () => {
    const input = makeInput();
    store.add(input);
    expect(() => store.add(makeInput({ name: input.name }))).toThrow(/already exists/);
  });

  test("pause disables and marks disabled; resume re-enables", () => {
    const job = store.add(makeInput());
    const paused = store.pause(job.id);
    expect(paused.enabled).toBe(false);
    expect(paused.status).toBe("disabled");
    const resumed = store.resume(job.id);
    expect(resumed.enabled).toBe(true);
    expect(resumed.status).toBe("idle");
  });

  test("pause on a running job keeps status running", () => {
    const job = store.add(makeInput());
    store.update(job.id, { status: "running" });
    const paused = store.pause(job.id);
    expect(paused.enabled).toBe(false);
    expect(paused.status).toBe("running");
  });
});

describe("JobStore persistence & migration idempotency (file-backed)", () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "omp-gw-store-"));
    dbPath = join(dir, "ledger.db");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("jobs survive reopen; schema migration is idempotent", () => {
    const s1 = new JobStore(dbPath);
    const job = s1.add(makeInput({ name: "persistent-job" }));
    const v1 = s1.db.query<{ user_version: number }, SQLQueryBindings[]>("PRAGMA user_version").get()!.user_version;
    s1.close();

    // 第二次打开：不重建、不报错（幂等），数据仍在
    const s2 = new JobStore(dbPath);
    const v2 = s2.db.query<{ user_version: number }, SQLQueryBindings[]>("PRAGMA user_version").get()!.user_version;
    expect(v2).toBe(v1);
    const reloaded = s2.get(job.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.name).toBe("persistent-job");
    expect(reloaded!.schedule).toEqual(job.schedule);
    s2.close();

    // 第三次打开仍幂等
    const s3 = new JobStore(dbPath);
    expect(s3.db.query<{ user_version: number }, SQLQueryBindings[]>("PRAGMA user_version").get()!.user_version).toBe(v1);
    expect(s3.get(job.id)).toBeDefined();
    s3.close();
  });
});
