import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../../src/util/lock.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "omp-gw-lock-"));
}

describe("acquireLock", () => {
  test("creates a sibling <dir>.lock directory and release removes it", async () => {
    const dir = tempDir();
    const workdir = join(dir, "work");
    mkdirSync(workdir);
    const handle = await acquireLock(workdir, { timeoutMs: 500 });
    expect(existsSync(join(dir, "work.lock"))).toBe(true);
    await handle.release();
    expect(existsSync(join(dir, "work.lock"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("second acquire times out while the lock is held", async () => {
    const dir = tempDir();
    const workdir = join(dir, "work");
    mkdirSync(workdir);
    const holder = await acquireLock(workdir);
    const started = Date.now();
    await expect(acquireLock(workdir, { timeoutMs: 150 })).rejects.toThrow(/Timed out/i);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await holder.release();
    rmSync(dir, { recursive: true, force: true });
  });

  test("can re-acquire after release", async () => {
    const dir = tempDir();
    const workdir = join(dir, "work");
    mkdirSync(workdir);
    const first = await acquireLock(workdir, { timeoutMs: 500 });
    await first.release();
    const second = await acquireLock(workdir, { timeoutMs: 500 });
    expect(existsSync(join(dir, "work.lock"))).toBe(true);
    await second.release();
    rmSync(dir, { recursive: true, force: true });
  });

  test("takes over a stale lock whose mtime is old", async () => {
    const dir = tempDir();
    const workdir = join(dir, "work");
    mkdirSync(workdir);
    const lockDir = join(dir, "work.lock");
    mkdirSync(lockDir);
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockDir, past, past);

    const handle = await acquireLock(workdir, { timeoutMs: 500, staleMs: 5_000 });
    expect(existsSync(lockDir)).toBe(true); // recreated, owned by us
    await handle.release();
    expect(existsSync(lockDir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("does not steal a fresh lock even with staleMs set", async () => {
    const dir = tempDir();
    const workdir = join(dir, "work");
    mkdirSync(workdir);
    const holder = await acquireLock(workdir);
    await expect(
      acquireLock(workdir, { timeoutMs: 150, staleMs: 5_000 }),
    ).rejects.toThrow(/Timed out/i);
    await holder.release();
    rmSync(dir, { recursive: true, force: true });
  });

  test("release is idempotent", async () => {
    const dir = tempDir();
    const workdir = join(dir, "work");
    mkdirSync(workdir);
    const handle = await acquireLock(workdir);
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
