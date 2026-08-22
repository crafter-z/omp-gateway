import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../../src/util/lock.ts";
import { DefaultExecutor } from "../../src/scheduler/executor.ts";
import type { AgentRunner, Job, RunResult } from "../../src/scheduler/types.ts";

type RunnerCall = { prompt: string; opts: { model?: string; cwd?: string; timeoutMs?: number } };

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "j1",
    name: "test-job",
    enabled: true,
    schedule: { kind: "interval", expr: "5m" },
    action: { type: "agent", prompt: "hello" },
    delivery: { target: "file" },
    status: "idle",
    next_run: "2026-08-20T10:00:00.000Z",
    last_run: null,
    run_count: 0,
    fail_streak: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 记录调用并可按需返回自定义结果的 fake runner */
function makeRunner(impl?: (prompt: string, opts: RunnerCall["opts"]) => Promise<RunResult>): {
  runner: AgentRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: AgentRunner = {
    async run(prompt, opts) {
      calls.push({ prompt, opts });
      if (impl) return impl(prompt, opts);
      return { ok: true, output: `echo:${prompt}` };
    },
  };
  return { runner, calls };
}

describe("DefaultExecutor — agent jobs", () => {
  test("invokes runner with prompt and passes model/cwd/timeoutMs through", async () => {
    const { runner, calls } = makeRunner(async (prompt, opts) => {
      return { ok: true, output: `res:${prompt}`, meta: { model: opts.model } };
    });
    const executor = new DefaultExecutor({ runner });
    const wd = join(tmpdir(), `omp-gw-wd-${crypto.randomUUID()}`);
    await mkdir(wd, { recursive: true });
    const job = makeJob({
      action: { type: "agent", prompt: "do the thing", model: "gpt-4o" },
      workdir: wd,
      ttl_s: 90,
    });

    try {
      const result = await executor.execute(job, new Date("2026-08-20T10:00:00.000Z"));
      expect(calls).toHaveLength(1);
      expect(calls[0].prompt).toBe("do the thing");
      expect(calls[0].opts).toEqual({ model: "gpt-4o", cwd: wd, timeoutMs: 90_000 });
      expect(result).toEqual({ ok: true, output: "res:do the thing", meta: { model: "gpt-4o" } }); // 直通
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  test("omits undefined options when job has no model/workdir/ttl", async () => {
    const { runner, calls } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    await executor.execute(makeJob({ action: { type: "agent", prompt: "x" } }), new Date());
    expect(calls[0].opts).toEqual({});
  });

  test("returns timeout result when runner exceeds ttl_s", async () => {
    const { runner } = makeRunner(() => new Promise<RunResult>(() => {})); // 永不 resolve
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({ action: { type: "agent", prompt: "slow" }, ttl_s: 0.05 });

    const result = await executor.execute(job, new Date());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
  });
});

describe("DefaultExecutor — no-agent jobs", () => {
  test("executes inline script and returns its output", async () => {
    const { runner, calls } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({ action: { type: "no-agent", script: 'console.log("hello-script")' } });

    const result = await executor.execute(job, new Date());
    expect(result.ok).toBe(true);
    expect(result.output.trim()).toBe("hello-script");
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(0); // wake_agent 缺省 → 纯脚本，不调 runner
  });

  test("empty output is a success", async () => {
    const { runner } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({ action: { type: "no-agent", script: "// noop\n" } });

    const result = await executor.execute(job, new Date());
    expect(result.ok).toBe(true);
    expect(result.output).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("non-zero exit is a failure carrying exit code and stderr", async () => {
    const { runner } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({
      action: { type: "no-agent", script: 'console.error("kaboom"); process.exit(7);' },
    });

    const result = await executor.execute(job, new Date());
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.error).toContain("kaboom");
  });

  test("non-zero exit without stderr falls back to exit code message", async () => {
    const { runner } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({ action: { type: "no-agent", script: "process.exit(3)" } });

    const result = await executor.execute(job, new Date());
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.error).toContain("3");
  });

  test("wake_agent=false with empty output: ok and runner not invoked", async () => {
    const { runner, calls } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({
      action: { type: "no-agent", script: "// silent\n", wake_agent: false },
    });

    const result = await executor.execute(job, new Date());
    expect(result.ok).toBe(true);
    expect(result.output).toBe("");
    expect(result.meta).toEqual({ wokeAgent: false });
    expect(calls).toHaveLength(0);
  });

  test("wake_agent=false with non-empty output wakes agent with wrapped script output", async () => {
    const { runner, calls } = makeRunner(async (prompt) => ({ ok: true, output: `agent-says:${prompt}` }));
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({
      action: { type: "no-agent", script: 'console.log("trigger")', wake_agent: false, model: "claude-x" },
    });

    const result = await executor.execute(job, new Date());
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("trigger\n"); // 脚本 stdout 被包装进唤醒 prompt
    expect(calls[0].prompt).toContain("脚本输出：");
    expect(calls[0].opts.model).toBe("claude-x");
    expect(result.ok).toBe(true);
    expect(result.output.startsWith("agent-says:")).toBe(true);
    expect(result.output).toContain("trigger\n");
    expect(result.meta).toMatchObject({ wokeAgent: true, scriptOutput: "trigger\n" });
  });

  test("wake_agent=true always wakes agent with wrapped script output", async () => {
    const { runner, calls } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({ action: { type: "no-agent", script: 'console.log("x")', wake_agent: true } });

    const result = await executor.execute(job, new Date());
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("x\n");
    expect(calls[0].prompt).toContain("脚本输出：");
    expect(result.meta).toMatchObject({ wokeAgent: true });
  });

  test("executes a script file path from workdir", async () => {
    const { runner } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    const scriptPath = join(tmpdir(), `omp-gw-script-${crypto.randomUUID()}.ts`);
    await Bun.write(scriptPath, 'console.log("from-file")');

    try {
      const job = makeJob({ action: { type: "no-agent", script: scriptPath } });
      const result = await executor.execute(job, new Date());
      expect(result.ok).toBe(true);
      expect(result.output.trim()).toBe("from-file");
    } finally {
      await unlink(scriptPath);
    }
  });

  test("missing script is a failure without invoking runner", async () => {
    const { runner, calls } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({ action: { type: "no-agent" } });

    const result = await executor.execute(job, new Date());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("script");
    expect(calls).toHaveLength(0);
  });

  test("script exceeding ttl_s is killed and reported as timeout", async () => {
    const { runner } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({
      action: { type: "no-agent", script: "while (true) {}" },
      ttl_s: 0.1,
    });

    const result = await executor.execute(job, new Date());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
  });
});

describe("DefaultExecutor — workdir serialization", () => {
  async function makeWorkdir(): Promise<string> {
    const wd = join(tmpdir(), `omp-gw-wd-${crypto.randomUUID()}`);
    await mkdir(wd, { recursive: true });
    return wd;
  }

  test("fails without invoking the runner when another job holds the workdir lock", async () => {
    const wd = await makeWorkdir();
    const lock = await acquireLock(wd, { timeoutMs: 5_000 });
    try {
      const { runner, calls } = makeRunner();
      const executor = new DefaultExecutor({ runner });
      const job = makeJob({ workdir: wd, action: { type: "agent", prompt: "x" }, ttl_s: 0.1 });

      const result = await executor.execute(job, new Date());
      expect(result.ok).toBe(false);
      expect(result.output).toBe("");
      expect(result.error).toContain("workdir");
      expect(calls).toHaveLength(0); // 抢锁失败不烧 token
    } finally {
      await lock.release();
    }
    await rm(wd, { recursive: true, force: true });
  });

  test("jobs sharing a workdir run strictly one at a time", async () => {
    const wd = await makeWorkdir();
    const order: string[] = [];
    const { runner } = makeRunner(async (prompt) => {
      order.push(`start:${prompt}`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      order.push(`end:${prompt}`);
      return { ok: true, output: prompt };
    });
    const executor = new DefaultExecutor({ runner });
    const mkJob = (id: string, prompt: string) => makeJob({ id, workdir: wd, action: { type: "agent", prompt } });

    try {
      const [r1, r2] = await Promise.all([
        executor.execute(mkJob("j1", "a"), new Date()),
        executor.execute(mkJob("j2", "b"), new Date()),
      ]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(order).toHaveLength(4);
      expect(order[0].startsWith("start:")).toBe(true);
      expect(order[1]).toBe(`end:${order[0].slice("start:".length)}`); // 前一个先跑完
      expect(order[2].startsWith("start:")).toBe(true);
      expect(order[3]).toBe(`end:${order[2].slice("start:".length)}`);
      expect(order[2]).not.toBe(order[0]); // 第二个 job 才轮到
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  test("releases the workdir lock after execution", async () => {
    const wd = await makeWorkdir();
    const { runner } = makeRunner();
    const executor = new DefaultExecutor({ runner });
    const job = makeJob({ workdir: wd, action: { type: "agent", prompt: "x" } });

    try {
      const result = await executor.execute(job, new Date());
      expect(result.ok).toBe(true);
      expect(existsSync(`${wd}.lock`)).toBe(false); // finally 中已释放并清理
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
