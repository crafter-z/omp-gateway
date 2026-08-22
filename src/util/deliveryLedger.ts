/**
 * Durable delivery-obligation ledger (hermes parity: gateway/delivery_ledger.py).
 *
 * Every outbound delivery records a row before sending; on daemon restart,
 * sweepRecoverable() re-claims rows owned by dead processes and re-delivers:
 * - pending    → plain redeliver
 * - attempting → redeliver WITH a visible "recovered" marker (honest
 *                at-least-once; the original may or may not have been sent)
 * - failed     → retried up to MAX_ATTEMPTS
 *
 * Best-effort by design: ledger failures never block a real send.
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS deliveries (
  id         TEXT PRIMARY KEY,
  chat_key   TEXT NOT NULL,
  text       TEXT NOT NULL,
  status     TEXT NOT NULL,       -- pending | attempting | delivered | failed
  attempt    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
)`;

export const MAX_ATTEMPTS = 3;
/** Rows older than this are pruned (retention). */
const STALE_AFTER_MS = 24 * 3600_000;
const RETENTION_DAYS_MS = 7 * 24 * 3600_000;
const MAX_ROWS = 500;

export type DeliveryStatus = "pending" | "attempting" | "delivered" | "failed";

export interface DeliveryObligation {
  id: string;
  chatKey: string;
  text: string;
  status: DeliveryStatus;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export class DeliveryLedger {
  constructor(private readonly db: Database) {
    db.run(CREATE_SQL);
  }

  /** Record a pending obligation; returns its id. Never throws (best-effort). */
  record(chatKey: string, text: string): string | null {
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db
        .query(
          "INSERT INTO deliveries (id, chat_key, text, status, attempt, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)",
        )
        .run(id, chatKey, text.slice(0, 64_000), now, now);
      this.prune();
      return id;
    } catch {
      return null;
    }
  }

  markAttempting(id: string): void {
    try {
      this.db
        .query("UPDATE deliveries SET status='attempting', attempt=attempt+1, updated_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
    } catch {
      // best-effort
    }
  }

  markDelivered(id: string): void {
    try {
      this.db
        .query("UPDATE deliveries SET status='delivered', updated_at=?, last_error=NULL WHERE id=?")
        .run(new Date().toISOString(), id);
    } catch {
      // best-effort
    }
  }

  markFailed(id: string, error: string): void {
    try {
      this.db
        .query("UPDATE deliveries SET status='failed', updated_at=?, last_error=? WHERE id=?")
        .run(new Date().toISOString(), error.slice(0, 300), id);
    } catch {
      // best-effort
    }
  }

  /**
   * Rows owned by dead processes (everything not terminal in this
   * single-process design after a restart) are returned for redelivery.
   * pending → plain; attempting → with a duplicate marker; failed → retry
   * only while attempts < MAX_ATTEMPTS.
   */
  sweepRecoverable(olderThanMs = STALE_AFTER_MS): Array<{ id: string; chatKey: string; text: string; recovered: boolean }> {
    try {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const rows = this.db
        .query<
          { id: string; chat_key: string; text: string; status: string; attempt: number; updated_at: string },
          SQLQueryBindings[]
        >(
          `SELECT id, chat_key, text, status, attempt, updated_at FROM deliveries
           WHERE status IN ('pending','attempting','failed') AND updated_at < ?
           ORDER BY created_at ASC`,
        )
        .all(cutoff);
      const out: Array<{ id: string; chatKey: string; text: string; recovered: boolean }> = [];
      for (const row of rows) {
        if (row.status === "failed" && row.attempt >= MAX_ATTEMPTS) continue;
        out.push({
          id: row.id,
          chatKey: row.chat_key,
          text: row.text,
          recovered: row.status === "attempting",
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Drop delivered rows older than retention and cap total rows. */
  prune(): void {
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS_MS).toISOString();
      this.db.run("DELETE FROM deliveries WHERE status='delivered' AND updated_at < ?", [cutoff]);
      this.db.run(
        `DELETE FROM deliveries WHERE id NOT IN (SELECT id FROM deliveries ORDER BY created_at DESC LIMIT ?)`,
        [MAX_ROWS],
      );
    } catch {
      // best-effort
    }
  }
}
