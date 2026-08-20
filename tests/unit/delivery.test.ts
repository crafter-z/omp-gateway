import { describe, expect, test } from "bun:test";
import { Delivery, parseSilent, wrapResult, type DeliveryDeps, type DeliveryJob } from "../../src/delivery/index.ts";

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
		expect(res.target).toBe("qq");
		expect(res.chatKey).toBe("home");
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
		expect(res.path).toBe("out.txt");
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
