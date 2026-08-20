import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightJob } from "../../src/scheduler/preflight.ts";
import type { JobInput } from "../../src/scheduler/types.ts";

function makeInput(overrides: Partial<JobInput> = {}): JobInput {
  return {
    name: "test-job",
    enabled: true,
    schedule: { kind: "interval", expr: "5m" },
    action: { type: "agent", prompt: "hello" },
    delivery: { target: "qq" },
    ...overrides,
  };
}

describe("preflightJob — action", () => {
  test("合法 agent job 通过", () => {
    expect(preflightJob(makeInput())).toEqual([]);
  });

  test("agent job 缺 prompt 报错", () => {
    const errors = preflightJob(makeInput({ action: { type: "agent", prompt: "   " } }));
    expect(errors.some((e) => e.includes("prompt"))).toBe(true);
  });

  test("no-agent 内联脚本无需文件存在", () => {
    const errors = preflightJob(makeInput({ action: { type: "no-agent", script: 'console.log("hi")' } }));
    expect(errors).toEqual([]);
  });

  test("no-agent 缺 script 报错", () => {
    const errors = preflightJob(makeInput({ action: { type: "no-agent" } }));
    expect(errors.some((e) => e.includes("script"))).toBe(true);
  });

  test("脚本路径不存在报错", () => {
    const missing = join(tmpdir(), `omp-gw-no-such-${crypto.randomUUID()}.ts`);
    const errors = preflightJob(makeInput({ action: { type: "no-agent", script: missing } }));
    expect(errors.some((e) => e.includes("not found"))).toBe(true);
  });

  test("脚本路径存在通过", () => {
    const p = join(tmpdir(), `omp-gw-ok-${crypto.randomUUID()}.ts`);
    writeFileSync(p, 'console.log("x")');
    try {
      expect(preflightJob(makeInput({ action: { type: "no-agent", script: p } }))).toEqual([]);
    } finally {
      rmSync(p, { force: true });
    }
  });

  test("相对脚本路径相对 workdir 解析", () => {
    const dir = join(tmpdir(), `omp-gw-wd-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.ts"), 'console.log("x")');
    try {
      const errors = preflightJob(makeInput({ action: { type: "no-agent", script: "run.ts" }, workdir: dir }));
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preflightJob — workdir / ttl_s", () => {
  test("workdir 不存在报错", () => {
    const errors = preflightJob(makeInput({ workdir: "C:/definitely/not/a/dir-xyz-123" }));
    expect(errors.some((e) => e.includes("workdir"))).toBe(true);
  });

  test("workdir 存在通过", () => {
    expect(preflightJob(makeInput({ workdir: process.cwd() }))).toEqual([]);
  });

  test("ttl_s 非正数报错", () => {
    expect(preflightJob(makeInput({ ttl_s: 0 })).some((e) => e.includes("ttl_s"))).toBe(true);
    expect(preflightJob(makeInput({ ttl_s: -5 })).some((e) => e.includes("ttl_s"))).toBe(true);
  });

  test("ttl_s 正数通过", () => {
    expect(preflightJob(makeInput({ ttl_s: 60 }))).toEqual([]);
  });
});

describe("preflightJob — delivery", () => {
  test("非法 target 报错", () => {
    const errors = preflightJob(makeInput({ delivery: { target: "email" as never } }));
    expect(errors.some((e) => e.includes("delivery target"))).toBe(true);
  });

  test("target=file 缺 file 路径报错", () => {
    const errors = preflightJob(makeInput({ delivery: { target: "file" } }));
    expect(errors.some((e) => e.includes("file"))).toBe(true);
  });

  test("target=file 父目录不存在但可创建 → 通过", () => {
    const dir = join(tmpdir(), `omp-gw-del-${crypto.randomUUID()}`);
    const errors = preflightJob(makeInput({ delivery: { target: "file", file: join(dir, "out.txt") } }));
    expect(errors).toEqual([]);
    expect(existsSync(dir)).toBe(true); // 预检顺带创建了父目录
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("preflightJob — schedule", () => {
  test("非法 cron 报错", () => {
    const errors = preflightJob(makeInput({ schedule: { kind: "cron", expr: "bad expr" } }));
    expect(errors.some((e) => e.includes("cron"))).toBe(true);
  });

  test("非 6 字段 cron 报错", () => {
    const errors = preflightJob(makeInput({ schedule: { kind: "cron", expr: "0 0 9 * *" } }));
    expect(errors.some((e) => e.includes("cron"))).toBe(true);
  });

  test("合法 cron 通过", () => {
    expect(preflightJob(makeInput({ schedule: { kind: "cron", expr: "0 0 9 * * *" } }))).toEqual([]);
  });

  test("非法 interval 报错", () => {
    expect(preflightJob(makeInput({ schedule: { kind: "interval", expr: "5x" } })).some((e) => e.includes("interval"))).toBe(true);
    expect(preflightJob(makeInput({ schedule: { kind: "interval", expr: "0m" } })).some((e) => e.includes("interval"))).toBe(true);
  });

  test("once 已过期报错", () => {
    const errors = preflightJob(makeInput({ schedule: { kind: "once", expr: "2020-01-01T00:00:00Z" } }));
    expect(errors.some((e) => e.includes("expired"))).toBe(true);
  });

  test("once 相对未来通过", () => {
    expect(preflightJob(makeInput({ schedule: { kind: "once", expr: "+30m" } }))).toEqual([]);
  });

  test("once 非法表达式报错", () => {
    const errors = preflightJob(makeInput({ schedule: { kind: "once", expr: "30m" } }));
    expect(errors.some((e) => e.includes("once"))).toBe(true);
  });
});
