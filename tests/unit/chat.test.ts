/**
 * Unit tests for ChatStore (chat_key ↔ session file mapping, bun:sqlite).
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatStore } from "../../src/qq/chat.ts";

describe("ChatStore", () => {
  test("creates on first sight, reuses the stored path afterwards", () => {
    const db = new Database(":memory:");
    const store = new ChatStore(db);

    const first = store.getOrCreate("c2c:u1", "/sessions/u1.json");
    expect(first).toEqual({ chatKey: "c2c:u1", sessionPath: "/sessions/u1.json", created: true });

    // A different path passed later must NOT clobber the existing mapping.
    const again = store.getOrCreate("c2c:u1", "/sessions/other.json");
    expect(again).toEqual({ chatKey: "c2c:u1", sessionPath: "/sessions/u1.json", created: false });

    db.close();
  });

  test("touch updates last_active_at and list returns all rows", () => {
    const db = new Database(":memory:");
    const store = new ChatStore(db);
    store.getOrCreate("c2c:u1", "/sessions/u1.json");
    store.getOrCreate("group:g1", "/sessions/g1.json");
    store.touch("c2c:u1");

    const rows = store.list();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ chatKey: "c2c:u1", sessionPath: "/sessions/u1.json" });
    expect(rows[1]).toMatchObject({ chatKey: "group:g1", sessionPath: "/sessions/g1.json" });
    for (const row of rows) {
      expect(typeof row.last_active_at).toBe("string");
      expect(new Date(row.last_active_at).getTime()).not.toBeNaN();
    }
    db.close();
  });

  test("recreating the store on the same db is safe (CREATE TABLE IF NOT EXISTS)", () => {
    const db = new Database(":memory:");
    new ChatStore(db).getOrCreate("group:g1", "/sessions/g1.json");
    const store2 = new ChatStore(db);
    expect(store2.list()).toHaveLength(1);
    db.close();
  });
});
