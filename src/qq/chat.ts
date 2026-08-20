/**
 * ChatStore — chat_key ↔ omp session file mapping.
 *
 * The bun:sqlite Database instance is injected by the daemon (the scheduler
 * store owns the file); this module never imports another module's store,
 * which would create a dependency cycle. Table `chat_sessions` is created
 * here if absent. `chat_key` = "c2c:<user_openid>" | "group:<group_openid>".
 */
import type { Database } from "bun:sqlite";

export interface ChatSessionRow {
  chatKey: string;
  sessionPath: string;
  last_active_at: string;
}

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS chat_sessions (
  chat_key TEXT PRIMARY KEY,
  session_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
)`;

interface SessionRow {
  chat_key: string;
  session_path: string;
  last_active_at: string;
}

export class ChatStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    db.run(CREATE_SQL);
  }

  /**
   * Return the session mapped to chatKey, creating the mapping with
   * sessionPath on first sight. Existing rows win — continuation keeps
   * routing to the original session file (reuse, not re-create).
   */
  getOrCreate(
    chatKey: string,
    sessionPath: string,
  ): { chatKey: string; sessionPath: string; created: boolean } {
    const row = this.db
      .query(`SELECT session_path FROM chat_sessions WHERE chat_key = ?`)
      .get(chatKey) as { session_path: string } | null;
    const now = new Date().toISOString();
    if (row) {
      this.db.run(`UPDATE chat_sessions SET last_active_at = ? WHERE chat_key = ?`, [now, chatKey]);
      return { chatKey, sessionPath: row.session_path, created: false };
    }
    this.db.run(
      `INSERT INTO chat_sessions (chat_key, session_path, created_at, last_active_at) VALUES (?, ?, ?, ?)`,
      [chatKey, sessionPath, now, now],
    );
    return { chatKey, sessionPath, created: true };
  }

  /** Bump last_active_at for a chat; no-op when the chat is unknown. */
  touch(chatKey: string): void {
    this.db.run(
      `UPDATE chat_sessions SET last_active_at = ? WHERE chat_key = ?`,
      [new Date().toISOString(), chatKey],
    );
  }

  /** All chat sessions, most recently active first. */
  list(): ChatSessionRow[] {
    const rows = this.db
      .query(
        `SELECT chat_key, session_path, last_active_at FROM chat_sessions ORDER BY last_active_at DESC`,
      )
      .all() as unknown as SessionRow[];
    return rows.map((r) => ({
      chatKey: r.chat_key,
      sessionPath: r.session_path,
      last_active_at: r.last_active_at,
    }));
  }
}
