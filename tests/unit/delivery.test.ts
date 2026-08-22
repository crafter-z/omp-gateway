import { describe, expect, test } from "bun:test";
import { Delivery, parseSilent, segment, wrapResult, type DeliveryDeps, type DeliveryJob } from "../../src/delivery/index.ts";

function makeDeps(overrides: Partial<DeliveryDeps> = {}): DeliveryDeps & { sent: { chat: string; text: string }[]; files: [string, string][] } {
	const sent: { chat: string; text: string }[] = [];
	const files: [string, string][] = [];
	return {
		qqSend: async (chat, text) => void sent.push({ chat, text }),
		fileSink: async (path, text) => void files.push([path, text]),
		defaultTarget: "qq",
		homeChannel: "home",
		wrapResponse: true,
		silentTrigger: "[SILENT]",
		...overrides,
		sent,
		files,
	};
}

const job = (partial: Partial<DeliveryJob> = {}): DeliveryJob => ({
	name: "test-job",
	delivery: { target: "qq" },
	...partial,
});

describe("parseSilent", () => {
	test("detects trigger prefix", () => {
		expect(parseSilent("[SILENT] hello", "[SILENT]")).toEqual({ text: "hello", silent: true });
	});
	test("no trigger leaves text", () => {
		expect(parseSilent("hello", "[SILENT]")).toEqual({ text: "hello", silent: false });
	});
});

describe("wrapResult", () => {
	test("wraps ok", () => {
		const w = wrapResult({ ok: true, output: "out" }, "j", true);
		expect(w).toContain("[j]");
		expect(w).toContain("ok");
		expect(w).toContain("out");
	});
	test("wraps failure with error", () => {
		const w = wrapResult({ ok: false, output: "", error: "boom" }, "j", false);
		expect(w).toContain("FAILED");
		expect(w).toContain("boom");
	});
});

describe("Delivery", () => {
	test("routes to home channel by default", async () => {
		const d = makeDeps();
		const delivery = new Delivery(d);
		const res = await delivery.deliver({ ok: true, output: "x" }, job());
		expect(res[0].target).toBe("qq");
		expect(res[0].chatKey).toBe("home");
		expect(d.sent[0]!.chat).toBe("home");
		expect(d.sent[0]!.text).toContain("x");
	});
	test("routes to explicit qq_chat", async () => {
		const d = makeDeps();
		const delivery = new Delivery(d);
		await delivery.deliver({ ok: true, output: "x" }, job({ delivery: { target: "qq", qq_chat: "c2c:u1" } }));
		expect(d.sent[0]!.chat).toBe("c2c:u1");
	});
	test("file target writes and skips qq", async () => {
		const d = makeDeps();
		const delivery = new Delivery(d);
		const res = await delivery.deliver(
			{ ok: true, output: "data" },
			job({ delivery: { target: "file", file: "out.txt" } }),
		);
		expect(res[0].path).toBe("out.txt");
		expect(d.files[0]).toEqual(["out.txt", expect.stringContaining("data")]);
		expect(d.sent.length).toBe(0);
	});
	test("SILENT suppresses qq", async () => {
		const d = makeDeps();
		const delivery = new Delivery(d);
		await delivery.deliver({ ok: true, output: "[SILENT] hidden" }, job());
		expect(d.sent.length).toBe(0);
	});
	test("SILENT still writes file", async () => {
		const d = makeDeps();
		const delivery = new Delivery(d);
		await delivery.deliver(
			{ ok: true, output: "[SILENT] data" },
			job({ delivery: { target: "file", file: "s.txt" } }),
		);
		expect(d.files[0]![1]).toContain("data");
	});
	test("origin uses originChatKey, falls back to default without it", async () => {
		const d = makeDeps();
		const delivery = new Delivery(d);
		await delivery.deliver({ ok: true, output: "x" }, job({ delivery: { target: "origin" } }), {
			originChatKey: "c2c:origin",
		});
		expect(d.sent[0]!.chat).toBe("c2c:origin");
		const d2 = makeDeps();
		const delivery2 = new Delivery(d2);
		await delivery2.deliver({ ok: true, output: "x" }, job({ delivery: { target: "origin" } }));
		expect(d2.sent[0]!.chat).toBe("home"); // degraded to defaultTarget
	});
	test("missing qq target throws", async () => {
		const d = makeDeps({ homeChannel: "" });
		const delivery = new Delivery(d);
		await expect(delivery.deliver({ ok: true, output: "x" }, job())).rejects.toThrow(/no qq target/);
	});
});

describe("segment", () => {
	test("returns text as-is when within the limit", () => {
		expect(segment("hello")).toEqual(["hello"]);
	});
	test("splits long text at maxLen (hard cut when no boundary)", () => {
		const text = "a".repeat(5000);
		const parts = segment(text);
		expect(parts.map((p) => p.length)).toEqual([2000, 2000, 1000]);
		expect(parts.join("")).toBe(text);
	});
	test("honors a custom maxLen", () => {
		expect(segment("123456", 3)).toEqual(["123", "456"]);
	});
	test("prefers word boundaries over hard cuts and never exceeds maxLen", () => {
		const text = "abcde fghij klmno pqrst uvwxy z";
		const parts = segment(text, 7);
		expect(parts.join("")).toBe(text);
		expect(parts.every((p) => p.length <= 7)).toBe(true);
		// first window "abcde f" walks back to the space at index 5 → "abcde "
		expect(parts[0]).toBe("abcde ");
	});
	test("empty text yields a single empty segment", () => {
		expect(segment("")).toEqual([""]);
	});
	test("degenerate maxLen degrades to 1 (no infinite loop)", () => {
		expect(segment("ab", 0)).toEqual(["a", "b"]);
		expect(segment("ab", -5)).toEqual(["a", "b"]);
	});
});

describe("Delivery scanning", () => {
	test("scan hit redacts payload and alerts with job name + matches", async () => {
		const hits: [string, string[]][] = [];
		const d = makeDeps({
			wrapResponse: false,
			scan: (text) => ({ matched: ["sk-"], redacted: text.replace("sk-abc", "[REDACTED:sk-]") }),
			onScanHit: (jobName, matched) => void hits.push([jobName, matched]),
		});
		const delivery = new Delivery(d);
		const res = await delivery.deliver({ ok: true, output: "leak sk-abc here" }, job());
		expect(res[0].segments).toBe(1);
		expect(d.sent[0]!.text).toBe("leak [REDACTED:sk-] here");
		expect(hits).toEqual([["test-job", ["sk-"]]]);
	});
	test("clean payload does not alert", async () => {
		const hits: [string, string[]][] = [];
		const d = makeDeps({
			scan: (text) => ({ matched: [], redacted: text }),
			onScanHit: (jobName, matched) => void hits.push([jobName, matched]),
		});
		const delivery = new Delivery(d);
		await delivery.deliver({ ok: true, output: "clean" }, job());
		expect(hits).toEqual([]);
		expect(d.sent[0]!.text).toContain("clean");
	});
	test("scan applies to file target too", async () => {
		const hits: [string, string[]][] = [];
		const d = makeDeps({
			scan: (text) => ({ matched: ["app_secret"], redacted: text.replace(/SECRET/g, "[REDACTED]") }),
			onScanHit: (jobName, matched) => void hits.push([jobName, matched]),
		});
		const delivery = new Delivery(d);
		await delivery.deliver(
			{ ok: true, output: "SECRET in file" },
			job({ delivery: { target: "file", file: "out.txt" } }),
		);
		expect(d.files[0]![1]).toContain("[REDACTED] in file");
		expect(hits).toHaveLength(1);
	});
});

describe("Delivery segmentation", () => {
	test("long qq payload is sent as multiple segments", async () => {
		const d = makeDeps({ wrapResponse: false });
		const delivery = new Delivery(d);
		const output = "x".repeat(4500);
		const res = await delivery.deliver({ ok: true, output }, job());
		expect(res[0].segments).toBe(3);
		expect(res[0].chatKey).toBe("home");
		expect(d.sent.map((s) => s.text.length)).toEqual([2000, 2000, 500]);
		expect(d.sent.map((s) => s.text).join("")).toBe(output);
	});
	test("short payload sends one segment", async () => {
		const d = makeDeps({ wrapResponse: false });
		const delivery = new Delivery(d);
		const res = await delivery.deliver({ ok: true, output: "short" }, job());
		expect(res[0].segments).toBe(1);
		expect(d.sent).toHaveLength(1);
	});
	test("origin is segmented and routed to origin chat", async () => {
		const d = makeDeps({ wrapResponse: false });
		const delivery = new Delivery(d);
		const output = "y".repeat(4500);
		const res = await delivery.deliver({ ok: true, output }, job({ delivery: { target: "origin" } }), {
			originChatKey: "c2c:origin",
		});
		expect(res[0].target).toBe("origin");
		expect(res[0].segments).toBe(3);
		expect(d.sent).toHaveLength(3);
		expect(d.sent.every((s) => s.chat === "c2c:origin")).toBe(true);
	});
	test("suppressed delivery reports zero segments", async () => {
		const d = makeDeps();
		const delivery = new Delivery(d);
		const res = await delivery.deliver({ ok: true, output: "[SILENT] hidden" }, job());
		expect(res[0].segments).toBe(0);
	});
	test("file outcome reports one segment", async () => {
		const d = makeDeps();
		const delivery = new Delivery(d);
		const res = await delivery.deliver(
			{ ok: true, output: "data" },
			job({ delivery: { target: "file", file: "out.txt" } }),
		);
		expect(res[0].path).toBe("out.txt");
		expect(res[0].segments).toBe(1);
	});
	test("segmented delivery still redacts on scan hit", async () => {
		const d = makeDeps({
			wrapResponse: false,
			scan: (text) => ({ matched: ["secret"], redacted: text.replaceAll("secret", "[REDACTED]") }),
		});
		const delivery = new Delivery(d);
		const output = "secret " + "z".repeat(4000);
		const res = await delivery.deliver({ ok: true, output }, job());
		expect(res[0].segments).toBe(3);
		expect(d.sent.map((s) => s.text).join("")).toBe("[REDACTED] " + "z".repeat(4000));
	});
});
