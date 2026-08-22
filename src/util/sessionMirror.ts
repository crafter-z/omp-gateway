/**
 * Continuable session mirroring (hermes mirror_to_session parity).
 *
 * After a cron result is delivered to a QQ chat, the output is appended into
 * that chat's omp session transcript so a later QQ reply in the same chat
 * continues with the cron output in context.
 *
 * Per-chat session files are JSONL (despite the `.json` extension), entry
 * chain verified against the installed omp package and real session files:
 *   {"type":"message","id":"<8-hex>","parentId":"<prev id>","timestamp":"ISO",
 *    "message":{"role":"user","content":[{"type":"text","text":"…"}],
 *               "attribution":"user","timestamp":<ms>}}
 * We append one synthetic user-role message chained to the last entry id.
 * Missing/unparseable files are skipped — mirroring never breaks delivery.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const MAX_MIRROR_CHARS = 64_000;

function randomEntryId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * Append a synthetic message entry to the session transcript. No-op (with an
 * optional log line) when the file is missing or not a parseable entry chain.
 */
export async function mirrorToSession(
  sessionPath: string,
  content: string,
  log?: (msg: string) => void,
): Promise<void> {
  try {
    if (!existsSync(sessionPath)) return; // 会话未创建 → 跳过（不建新文件）
    const raw = readFileSync(sessionPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return;

    // 最后一条带 id 的记录作为 parentId（消息链的尾部）。
    let parentId: string | null = null;
    let parsedAny = false;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { id?: unknown };
        parsedAny = true;
        if (typeof entry.id === "string") parentId = entry.id;
      } catch {
        // 坏行跳过；仍可挂到最后一条好记录的 id 上
      }
    }
    if (!parsedAny) {
      log?.("session mirror skipped: transcript contains no parseable entries");
      return;
    }

    const now = new Date();
    const text =
      content.length > MAX_MIRROR_CHARS
        ? `${content.slice(0, MAX_MIRROR_CHARS)}\n… [truncated]`
        : content;
    const entry = {
      type: "message",
      id: randomEntryId(),
      parentId,
      timestamp: now.toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text }],
        attribution: "user",
        timestamp: now.getTime(),
      },
    };

    // 原子写：同目录 .tmp → rename（Windows 上 rename 覆盖已存在文件）。
    const tmp = `${sessionPath}.tmp`;
    writeFileSync(tmp, raw.endsWith("\n") ? `${raw}${JSON.stringify(entry)}\n` : `${raw}\n${JSON.stringify(entry)}\n`);
    renameSync(tmp, sessionPath);
  } catch (err) {
    log?.(`session mirror skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
