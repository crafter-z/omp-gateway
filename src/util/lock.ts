/**
 * Cross-platform directory lock via atomic `mkdir` — EEXIST/EPERM detection
 * works on Windows where flock is unavailable.
 *
 * Invariants:
 * - The lock lives in a sibling directory `<dir>.lock` of the target `dir`.
 * - `acquireLock` resolves only when the caller owns the lock; otherwise it
 *   polls every 50ms until `timeoutMs` elapses, then rejects.
 * - When `staleMs` is set and the lock directory mtime is older than that,
 *   the lock is forcibly taken over (removed and recreated).
 * - `release()` removes the lock directory and is idempotent.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";

export interface LockHandle {
  /** Release the lock (idempotent). */
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  /** Max time to wait for the lock before rejecting. Default 10_000 ms. */
  timeoutMs?: number;
  /** If the lock dir mtime is older than this, force take it over. Default: never. */
  staleMs?: number;
}

const POLL_INTERVAL_MS = 50;

export async function acquireLock(dir: string, opts: AcquireLockOptions = {}): Promise<LockHandle> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs;
  const lockDir = siblingLockPath(dir);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(lockDir); // atomic create; EEXIST/EPERM means "held elsewhere"
      break;
    } catch (err) {
      const code = err !== null && typeof err === "object" && "code" in err ? err.code : undefined;
      if (code !== "EEXIST" && code !== "EPERM") throw err;

      if (staleMs !== undefined) {
        const st = statSync(lockDir, { throwIfNoEntry: false });
        if (st !== undefined && Date.now() - st.mtimeMs > staleMs) {
          rmSync(lockDir, { recursive: true, force: true }); // stale: force takeover
          continue; // retry creation immediately
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms acquiring lock ${lockDir}`);
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, POLL_INTERVAL_MS);
      await promise;
    }
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      rmSync(lockDir, { recursive: true, force: true });
      released = true;
    },
  };
}

/** Strip trailing separators so `<dir>.lock` is a true sibling of `dir`. */
function siblingLockPath(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  return `${trimmed}.lock`;
}
