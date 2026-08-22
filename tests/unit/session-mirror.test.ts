import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorToSession } from "../../src/util/sessionMirror.ts";

function makeSessionDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-gw-session-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 仿真实 per-chat 会话文件（JSONL 条目链，.json 扩展名）。 */
function sampleTranscript(): string {
	return [
		JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-08-21T16:28:21.417Z", pad: " " }),
		JSON.stringify({ type: "session", version: 3, id: "sess1", timestamp: "2026-08-21T16:28:21.417Z", cwd: "/tmp" }),
		JSON.stringify({
			type: "message",
			id: "aaaa0001",
			parentId: "sess1",
			timestamp: "2026-08-21T16:28:24.220Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "你好？" }],
				attribution: "user",
				timestamp: 1787329701620,
			},
		}),
	].join("\n") + "\n";
}

describe("mirrorToSession", () => {
	test("appends a chained message entry preserving existing lines", async () => {
		const dir = makeSessionDir();
		const p = join(dir, "chat-x.json");
		writeFileSync(p, sampleTranscript());
		await mirrorToSession(p, "每日简报：今天无异常");
		const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
		// 原有 3 条 + 新增 1 条
		expect(lines).toHaveLength(4);
		const appended = JSON.parse(lines[3]!);
		expect(appended.type).toBe("message");
		expect(appended.parentId).toBe("aaaa0001"); // 挂在最后一条消息 id 上
		expect(appended.message.role).toBe("user");
		expect(appended.message.content[0]).toMatchObject({ type: "text" });
		expect(appended.message.content[0].text).toContain("每日简报：今天无异常");
		// 原有行未被改动
		expect(JSON.parse(lines[0]!).type).toBe("title");
		expect(JSON.parse(lines[2]!).id).toBe("aaaa0001");
	});

	test("missing file is a silent no-op", async () => {
		const dir = makeSessionDir();
		const logs: string[] = [];
		await mirrorToSession(join(dir, "nope.json"), "x", (m) => logs.push(m));
		expect(logs).toHaveLength(0);
		expect(existsSync(join(dir, "nope.json"))).toBe(false);
	});

	test("unparseable file is skipped without touching it", async () => {
		const dir = makeSessionDir();
		const p = join(dir, "broken.json");
		writeFileSync(p, "not json at all\n{also not json");
		const logs: string[] = [];
		await mirrorToSession(p, "x", (m) => logs.push(m));
		expect(logs).toHaveLength(1); // 有日志（跳过原因）
		expect(readFileSync(p, "utf8")).toBe("not json at all\n{also not json"); // 原样保留
	});

	test("truncates very long content", async () => {
		const dir = makeSessionDir();
		const p = join(dir, "chat-y.json");
		writeFileSync(p, sampleTranscript());
		const long = "z".repeat(70_000);
		await mirrorToSession(p, long);
		const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
		const appended = JSON.parse(lines[lines.length - 1]!);
		const text = appended.message.content[0].text as string;
		expect(text.length).toBeLessThan(65_000);
		expect(text.endsWith("[truncated]")).toBe(true);
	});
});
