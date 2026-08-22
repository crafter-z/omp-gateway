/**
 * DeadTargetRegistry (hermes parity: gateway/dead_targets.py).
 * Marks confirmed-unreachable chats (deleted group, kicked bot, deactivated
 * user) so later sends short-circuit instead of re-attempting every tick.
 * Self-heals on any later success. Persisted in the shared sqlite db.
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS dead_targets (
  chat_key  TEXT PRIMARY KEY,
  error_kind TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  last_error TEXT
)`;

export interface DeadTargetRow {
  chatKey: string;
  errorKind: string;
  markedAt: string;
  lastError: string | null;
}

/** QQ send errors that mean "this chat is gone" — not transient. */
const DEAD_HINTS = [
  "not found",
  "forbidden",
  "invalid openid",
  "invalid group",
  "group is not accessible",
  "user is not accessible",
  "bot is not in the group",
  "channel not found",
];

export function isDeadTargetError(message: string): boolean {
  const s = message.toLowerCase();
  return DEAD_HINTS.some((h) => s.includes(h));
}

export class DeadTargetRegistry {
  constructor(private readonly db: Database) {
    db.run(CREATE_SQL);
  }

  /** True when the chat is currently marked dead. */
  isDead(chatKey: string): boolean {
    return (
      this.db
        .query<{ n: number }, SQLQueryBindings[]>("SELECT COUNT(*) AS n FROM dead_targets WHERE chat_key = ?")
        .get(chatKey)!.n > 0
    );
  }

  /** Mark a chat dead (idempotent; keeps the first error detail). */
  markDead(chatKey: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO dead_targets (chat_key, error_kind, marked_at, last_error) VALUES (?, 'qq_unreachable', ?, ?)
         ON CONFLICT(chat_key) DO NOTHING`,
      )
      .run(chatKey, now, error.slice(0, 300));
  }

  /** Clear a dead mark after a successful send. */
  clear(chatKey: string): void {
    this.db.run("DELETE FROM dead_targets WHERE chat_key = ?", [chatKey]);
  }

  list(): DeadTargetRow[] {
    const rows = this.db
      .query<{ chat_key: string; error_kind: string; marked_at: string; last_error: string | null }, SQLQueryBindings[]>(
        "SELECT chat_key, error_kind, marked_at, last_error FROM dead_targets ORDER BY marked_at DESC",
      )
      .all();
    return rows.map((r) => ({
      chatKey: r.chat_key,
      errorKind: r.error_kind,
      markedAt: r.marked_at,
      lastError: r.last_error,
    }));
  }
}
