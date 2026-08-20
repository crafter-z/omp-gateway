import { describe, expect, test } from "bun:test";
import { JobStore } from "../../src/scheduler/store.ts";
import { Ledger } from "../../src/scheduler/ledger.ts";
import { Scheduler } from "../../src/scheduler/scheduler.ts";
import { DefaultExecutor } from "../../src/scheduler/executor.ts";
import type { AgentRunner } from "../../src/scheduler/types.ts";

const fakeRunner: AgentRunner = {
	run: async (prompt) => ({ ok: true, output: `ran:${prompt}` }),
};

function makeScheduler(store: JobStore): Scheduler {
	const ledger = new Ledger(store);
	const executor = new DefaultExecutor({ runner: fakeRunner });
	return new Scheduler(
		store,
		executor,
		{ timezone: "Asia/Shanghai", tickS: 1, maxConcurrentJobs: 2, misfireGraceS: 30 },
		ledger,
	);
}

describe("Scheduler misfire recovery", () => {
	test("stale claimed execution inside grace window is marked unknown and re-fired", async () => {
		const store = new JobStore(":memory:");
		const job = store.add({
			name: "mf",
			enabled: true,
			schedule: { kind: "interval", expr: "1m" }, // 不会自行触发（1 分钟）
			action: { type: "no-agent", script: 'console.log("x")' },
			delivery: { target: "file", file: "o.txt" },
		});
		const now = Date.now();
		// 残留：claimed 超时（35s 前领取，超 30s 窗口）、scheduled_at 在窗口内（10s 前）
		store.db
			.query(
				`INSERT INTO executions (id, job_id, status, kind, scheduled_at, claimed_at, started_at, finished_at, exit_code, output_ref, error, meta)
				 VALUES (?, ?, 'claimed', 'no-agent', ?, ?, NULL, NULL, NULL, NULL, NULL, '{}')`,
			)
			.run(`${job.id}:stale`, job.id, new Date(now - 10_000).toISOString(), new Date(now - 35_000).toISOString());

		const scheduler = makeScheduler(store);
		scheduler.start();
		await Bun.sleep(2500); // 2+ 个 tick
		scheduler.stop();

		const rows = store.db
			.query<{ id: string; status: string }, [string]>("SELECT id, status FROM executions WHERE job_id = ? ORDER BY id")
			.all(job.id);
		// 残留被标 unknown
		expect(rows.some((r) => r.id === `${job.id}:stale` && r.status === "unknown")).toBe(true);
		// 补跑产生新 execution 且完成
		const recovered = rows.filter((r) => r.id !== `${job.id}:stale`);
		expect(recovered.length).toBeGreaterThan(0);
		expect(recovered.some((r) => r.status === "completed")).toBe(true);
		store.close();
	});

	test("stale execution outside grace window is marked unknown but NOT re-fired", async () => {
		const store = new JobStore(":memory:");
		const job = store.add({
			name: "mf2",
			enabled: true,
			schedule: { kind: "interval", expr: "1m" },
			action: { type: "no-agent", script: 'console.log("x")' },
			delivery: { target: "file", file: "o.txt" },
		});
		const now = Date.now();
		// scheduled_at 在窗口外（10 分钟前）
		store.db
			.query(
				`INSERT INTO executions (id, job_id, status, kind, scheduled_at, claimed_at, started_at, finished_at, exit_code, output_ref, error, meta)
				 VALUES (?, ?, 'claimed', 'no-agent', ?, ?, NULL, NULL, NULL, NULL, NULL, '{}')`,
			)
			.run(`${job.id}:stale`, job.id, new Date(now - 600_000).toISOString(), new Date(now - 650_000).toISOString());

		const scheduler = makeScheduler(store);
		scheduler.start();
		await Bun.sleep(2500);
		scheduler.stop();

		const rows = store.db
			.query<{ id: string; status: string }, [string]>("SELECT id, status FROM executions WHERE job_id = ? ORDER BY id")
			.all(job.id);
		expect(rows.some((r) => r.id === `${job.id}:stale` && r.status === "unknown")).toBe(true);
		// 窗口外：不补跑，无新 execution
		expect(rows.filter((r) => r.id !== `${job.id}:stale`)).toHaveLength(0);
		store.close();
	});
});
