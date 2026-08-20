import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type LogLevel } from "../../src/util/logger.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "omp-gw-logger-"));
}

describe("logger", () => {
  test("filters out levels below the configured level", () => {
    const dir = tempDir();
    const file = join(dir, "out.log");
    const log = createLogger({ level: "warn", file });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[warn] w");
    expect(lines[1]).toContain("[error] e");
    rmSync(dir, { recursive: true, force: true });
  });

  test("error level only emits errors", () => {
    const dir = tempDir();
    const file = join(dir, "out.log");
    const log = createLogger({ level: "error", file });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("boom");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[error] boom");
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes structured lines: ISO timestamp, level, message, json fields", () => {
    const dir = tempDir();
    const file = join(dir, "out.log");
    const log = createLogger({ level: "debug", file });
    log.info("hello", { a: 1, b: "x" });
    const line = readFileSync(file, "utf8").trim();
    expect(line).toMatch(/^\[[^\]]+\] \[info\] hello \{"a":1,"b":"x"\}$/);
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /);
    rmSync(dir, { recursive: true, force: true });
  });

  test("child adds a prefix and inherits level and file", () => {
    const dir = tempDir();
    const file = join(dir, "out.log");
    const log = createLogger({ level: "info", file });
    log.child("sched").warn("busy", { n: 2 });
    log.child("a").child("b").info("nested");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[warn] [sched] busy");
    expect(lines[0]).toContain('{"n":2}');
    expect(lines[1]).toContain("[info] [a.b] nested");
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates missing parent directories of the log file", () => {
    const dir = tempDir();
    const file = join(dir, "nested", "deep", "out.log");
    const log = createLogger({ level: "debug", file });
    log.info("deep");
    expect(readFileSync(file, "utf8").trim()).toContain("[info] deep");
    rmSync(dir, { recursive: true, force: true });
  });

  test("works without a file (stdout only), never throws", () => {
    const log = createLogger({ level: "debug" });
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    for (const lv of levels) {
      expect(() => log[lv](`msg-${lv}`)).not.toThrow();
    }
  });
});
