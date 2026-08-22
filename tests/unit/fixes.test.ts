/**
 * Regression tests for the 2026-08 fix batch:
 * - ledger terminal-state guards (stale unknown cannot be overwritten)
 * - once-job downtime catch-up in Scheduler.start
 * - interval range validation shared by preflight/scheduler/nl
 * - passive-reply msg_id/msg_seq threading through delivery
 *
 * Note: the once-catch-up tests poll for the real async fire() completion
 * instead of fixed sleeps — the scheduler's own tick interval is set to an
 * hour so only the startup catch-up path runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { JobStore } from "../../src/scheduler/store.ts";
import { Ledger } from "../../src/scheduler/ledger.ts";
import { Scheduler } from "../../src/scheduler/scheduler.ts";
import { DefaultExecutor } from "../../src/scheduler/executor.ts";
import { preflightJob } from "../../src/scheduler/preflight.ts";
import { parseSchedule } from "../../src/scheduler/nl.ts";
import { intervalToCron, onceDate } from "../../src/scheduler/expr.ts";
import { Delivery, StreamingReply } from "../../src/delivery/index.ts";
import { buildArgs } from "../../src/omp/session.ts";
import { resetAccessTokenCache, sendText } from "../../src/qq/rest.ts";
import type { QqConfig } from "../../src/qq/types.ts";
import type { AgentRunner, JobInput } from "../../src/scheduler/types.ts";

function makeInput(overrides: Partial<JobInput> = {}): JobInput {
	return {
		name: `job-${crypto.randomUUID().slice(0, 8)}`,
		enabled: true,
		schedule: { kind: "interval", expr: "5m" },
		action: { type: "no-agent", script: 'console.log("x")' },
		delivery: { target: "file", file: "o.txt" },
		...overrides,
	};
}

/** Poll until fn() is true; no guessed durations — fails with the condition itself. */
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > deadline) {
			expect(fn()).toBe(true); // surface a descriptive failure
			return;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 10);
		await promise;
	}
}

describe("Ledger terminal-state guards", () => {
	test("markRunning on an already-unknown execution is a no-op returning false", () => {
		const store = new JobStore(":memory:");
		const ledger = new Ledger(store);
		const job = store.add(makeInput());
		const exec = ledger.claim(job)!;
		ledger.markUnknown(exec.id, "stale");
		expect(ledger.markRunning(exec.id)).toBe(false);
		const row = store.db.query("SELECT status FROM executions WHERE id = ?").get(exec.id) as {
			status: string;
		};
		expect(row.status).toBe("unknown");
		store.close();
	});

	test("late markCompleted after scanStale does NOT overwrite unknown and does NOT bump counters", () => {
		const store = new JobStore(":memory:");
		const ledger = new Ledger(store);
		const job = store.add(makeInput());
		const exec = ledger.claim(job)!;
		ledger.markRunning(exec.id);
		// 长任务超过 misfire 窗口 → 回拨 started_at 后 scanStale 判 stale（模拟 tick）
		store.db.run("UPDATE executions SET started_at = ? WHERE id = ?", [
			new Date(Date.now() - 120_000).toISOString(),
			exec.id,
		]);
		ledger.scanStale(60_000);
		expect(ledger.markCompleted(exec.id, null)).toBe(false);
		const row = store.db.query("SELECT status FROM executions WHERE id = ?").get(exec.id) as {
			status: string;
		};
		expect(row.status).toBe("unknown");
		expect(store.get(job.id)!.run_count).toBe(0); // 迟到的完成不计入
		store.close();
	});

	test("markCompleted after a superseding new claim does not reset the new claim's running status", () => {
		const store = new JobStore(":memory:");
		const ledger = new Ledger(store, { claimTimeoutMs: 50 });
		const job = store.add(makeInput());
		const first = ledger.claim(job)!;
		ledger.markRunning(first.id);
		// 回拨 started_at 使其 stale，然后新 claim 取代
		store.db.run("UPDATE executions SET started_at = ? WHERE id = ?", [
			new Date(Date.now() - 60_000).toISOString(),
			first.id,
		]);
		store.update(job.id, { status: "idle" });
		const second = ledger.claim(job)!;
		ledger.markRunning(second.id);
		// 第一个执行的迟到完成写入：被守卫拒绝，job 保持第二个 claim 的 running
		expect(ledger.markCompleted(first.id, null)).toBe(false);
		expect(store.get(job.id)!.status).toBe("running");
		// 第二个正常完成仍然工作
		expect(ledger.markCompleted(second.id, null)).toBe(true);
		expect(store.get(job.id)!.status).toBe("idle");
		store.close();
	});
});

describe("Once-job downtime catch-up", () => {
	const fakeRunner: AgentRunner = { run: async (p) => ({ ok: true, output: `ran:${p}` }) };

	function makeScheduler(store: JobStore): Scheduler {
		return new Scheduler(
			store,
			new DefaultExecutor({ runner: fakeRunner }),
			{ timezone: "Asia/Shanghai", tickS: 3600, maxConcurrentJobs: 2, misfireGraceS: 300 },
			new Ledger(store),
		);
	}

	test("once job missed inside grace window fires on start and clears next_run", async () => {
		const store = new JobStore(":memory:");
		const past = new Date(Date.now() - 10_000).toISOString();
		store.add(makeInput({ schedule: { kind: "once", expr: past }, next_run: past }));
		const scheduler = makeScheduler(store);
		scheduler.start();
		await waitFor(() =>
			(store.db.query("SELECT status FROM executions").all() as Array<{ status: string }>).some(
				(r) => r.status === "completed",
			),
		);
		scheduler.stop();
		const j = store.list()[0]!;
		expect(j.next_run).toBeNull(); // 补跑后 once 结束
		store.close();
	});

	test("once job expired beyond grace window is retired with next_run=null and not fired", async () => {
		const store = new JobStore(":memory:");
		const longPast = new Date(Date.now() - 3_600_000).toISOString();
		store.add(makeInput({ schedule: { kind: "once", expr: longPast }, next_run: longPast }));
		const scheduler = makeScheduler(store);
		scheduler.start();
		await new Promise((r) => setTimeout(r, 50)); // 让 start() 同步流程走完
		scheduler.stop();
		const rows = store.db.query("SELECT status FROM executions").all() as Array<{ status: string }>;
		expect(rows).toHaveLength(0); // 未触发
		expect(store.list()[0]!.next_run).toBeNull();
		store.close();
	});
});

describe("Interval range validation (shared expr module)", () => {
	test("intervalToCron rejects out-of-range steps that croner would throw on", () => {
		for (const bad of ["90m", "25h", "32d", "61s"]) {
			expect(() => intervalToCron(bad)).toThrow(/step must be/);
		}
		for (const good of ["59s", "59m", "23h", "31d", "5m"]) {
			expect(typeof intervalToCron(good)).toBe("string");
		}
	});

	test("preflight rejects out-of-range intervals before write", () => {
		const errors = preflightJob(makeInput({ schedule: { kind: "interval", expr: "90m" } }));
		expect(errors.some((e) => e.includes("interval"))).toBe(true);
		expect(preflightJob(makeInput({ schedule: { kind: "interval", expr: "45m" } }))).toEqual([]);
	});

	test("NL parser refuses out-of-range intervals instead of emitting dead schedules", () => {
		expect(parseSchedule("每90分钟")).toBeNull();
		expect(parseSchedule("every 25 hours")).toBeNull();
		expect(parseSchedule("每30分钟")).toEqual({ kind: "interval", expr: "30m" });
	});
});

describe("Delivery passive-reply threading", () => {
	function makeDeps() {
		const sent: Array<{ chat: string; text: string; opts?: { msgId?: string; msgSeq?: number } }> = [];
		const deps = {
			qqSend: async (chat: string, text: string, opts?: { msgId?: string; msgSeq?: number }) => {
				sent.push({ chat, text, opts });
			},
			fileSink: async () => {},
			defaultTarget: "qq" as const,
			homeChannel: "home",
			wrapResponse: false,
			silentTrigger: "[SILENT]",
		};
		return { deps, sent };
	}

	test("single reply carries msg_id without msg_seq", async () => {
		const { deps, sent } = makeDeps();
		await new Delivery(deps).deliver(
			{ ok: true, output: "hi" },
			{ name: "j", delivery: { target: "origin" } },
			{ originChatKey: "c2c:u1", replyTo: "in-1" },
		);
		expect(sent[0]!.opts).toEqual({ msgId: "in-1" });
	});

	test("segmented replies increment msg_seq from 2", async () => {
		const { deps, sent } = makeDeps();
		const text = "x".repeat(5000); // → 3 段（2000 上限）
		await new Delivery(deps).deliver(
			{ ok: true, output: text },
			{ name: "j", delivery: { target: "origin" } },
			{ originChatKey: "c2c:u1", replyTo: "in-2" },
		);
		expect(sent.length).toBe(3);
		expect(sent[0]!.opts).toEqual({ msgId: "in-2" });
		expect(sent[1]!.opts).toEqual({ msgId: "in-2", msgSeq: 2 });
		expect(sent[2]!.opts).toEqual({ msgId: "in-2", msgSeq: 3 });
	});

	test("no replyTo keeps sends active (cron home-channel path unchanged)", async () => {
		const { deps, sent } = makeDeps();
		await new Delivery(deps).deliver({ ok: true, output: "hi" }, { name: "j", delivery: { target: "qq" } });
		expect(sent[0]!.opts).toBeUndefined();
	});
});

describe("expr.onceDate parity with scheduler", () => {
	test("parses relative and ISO expressions identically to the registration path", () => {
		const rel = onceDate("+30m");
		expect(rel).not.toBeNull();
		expect(rel!.getTime()).toBeGreaterThan(Date.now());
		expect(onceDate("2020-01-01T00:00:00Z")!.getTime()).toBeLessThan(Date.now());
		expect(onceDate("garbage")).toBeNull();
	});
});

describe("buildArgs session modes", () => {
	test("sessionPath emits -r; noSession emits --no-session; never both", () => {
		expect(buildArgs({ sessionPath: "C:/tmp/s.json" })).toEqual(["-r", "C:/tmp/s.json"]);
		expect(buildArgs({ noSession: true })).toEqual(["--no-session"]);
	});
});

describe("StreamingReply", () => {
	function makeStream(chunkChars: number) {
		const sent: Array<{ text: string; opts?: { msgId?: string; msgSeq?: number } }> = [];
		const stream = new StreamingReply({
			send: async (text, opts) => {
				sent.push({ text, opts });
			},
			replyTo: "in-9",
			chunkChars,
		});
		return { stream, sent };
	}

	test("buffers below chunkChars; finish flushes the remainder", async () => {
		const { stream, sent } = makeStream(300);
		await stream.push("短文本");
		expect(sent).toHaveLength(0);
		await stream.finish();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ text: "短文本", opts: { msgId: "in-9" } });
	});

	test("long output splits at boundaries with incrementing msg_seq", async () => {
		const { stream, sent } = makeStream(10);
		for (let i = 0; i < 30; i++) await stream.push(`词${i} `); // ~45 chars with boundaries
		await stream.finish();
		expect(sent.length).toBeGreaterThanOrEqual(3);
		expect(sent[0]!.opts).toEqual({ msgId: "in-9" });
		expect(sent[1]!.opts).toEqual({ msgId: "in-9", msgSeq: 2 });
		for (const s of sent) expect(s.text.length).toBeLessThanOrEqual(11);
	});

	test("SILENT prefix suppresses subsequent output", async () => {
		const { stream, sent } = makeStream(5);
		await stream.push("[SILENT] secret stuff");
		await stream.push("more");
		await stream.finish();
		expect(sent).toHaveLength(0);
	});

	test("push after finish is ignored", async () => {
		const { stream, sent } = makeStream(300);
		await stream.push("first");
		await stream.finish();
		await stream.push("late");
		expect(sent).toHaveLength(1);
	});
});

describe("sendText markdown body", () => {
	const CFG: QqConfig = { app_id: "app-md", app_secret: "sec" };
	const realFetch = globalThis.fetch;
	/** Bodies of /messages POSTs only (token calls excluded → index-stable). */
	let msgBodies: unknown[] = [];

	function mockFetch(): void {
		msgBodies = [];
		resetAccessTokenCache();
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/app/getAppAccessToken")) {
				return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 });
			}
			msgBodies.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ id: "out" }), { status: 200 });
		}) as unknown as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = realFetch;
		resetAccessTokenCache();
	});

	test("plain default keeps msg_type 0 + content", async () => {
		mockFetch();
		await sendText(CFG, { chatKey: "c2c:u", openid: "u" }, "hi");
		expect(msgBodies).toEqual([{ content: "hi", msg_type: 0 }]);
	});

	test("markdown option emits msg_type 2 + markdown.content without content field", async () => {
		mockFetch();
		await sendText(CFG, { chatKey: "group:g", openid: "g" }, "# 标题", {
			markdown: true,
			msgId: "m1",
			msgSeq: 2,
		});
		await sendText(CFG, { chatKey: "group:g", openid: "g" }, "x", { markdown: true, msgId: "m1", msgSeq: 3 });
		expect(msgBodies).toEqual([
			{ msg_type: 2, markdown: { content: "# 标题" }, msg_id: "m1", msg_seq: 2 },
			{ msg_type: 2, markdown: { content: "x" }, msg_id: "m1", msg_seq: 3 },
		]);
	});
});
