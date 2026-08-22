import { describe, expect, test } from "bun:test";
import { JobStore } from "../../src/scheduler/store.ts";
import { Ledger } from "../../src/scheduler/ledger.ts";
import { Scheduler } from "../../src/scheduler/scheduler.ts";
import { DefaultExecutor } from "../../src/scheduler/executor.ts";
import type { AgentRunner } from "../../src/scheduler/types.ts";

const fakeRunner: AgentRunner = {
	run: async (prompt) => ({ ok: true, output: `ran:${prompt}` }),
};

function makeScheduler(
	store: JobStore,
	overrides: Partial<ConstructorParameters<typeof Scheduler>[2]> = {},
): Scheduler {
	const ledger = new Ledger(store);
	const executor = new DefaultExecutor({ runner: fakeRunner });
	return new Scheduler(
		store,
		executor,
		{ timezone: "Asia/Shanghai", tickS: 1, maxConcurrentJobs: 2, misfireGraceS: 30, ...overrides },
		ledger,
	);
}

describe("Scheduler misfire recovery", () => {
	test("stale claimed execution inside grace window is marked unknown and re-fired", async () => {
		const store = new JobStore(":memory:");
		const job = store.add({
			name: "mf",
			enabled: true,
			schedule: { kind: "cron", expr: "0 0 3 * * *" }, // 每天 3 点：2.5s 窗口内不会自行触发
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
			schedule: { kind: "cron", expr: "0 0 3 * * *" }, // 每天 3 点：窗口内不会自行触发
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

describe("Scheduler maintenance (steady-state, no stale rows)", () => {
	test("execution prune runs every tick even when scanStale is empty", async () => {
		const store = new JobStore(":memory:");
		const job = store.add({
			name: "prune-me",
			enabled: true,
			schedule: { kind: "cron", expr: "0 0 3 * * *" }, // 不会在窗口内触发
			action: { type: "no-agent", script: 'console.log("x")' },
			delivery: { target: "file", file: "o.txt" },
		});
		// 插入 1005 条终态记录（超过 MAX_TERMINAL_EXECUTIONS=1000）
		const now = new Date().toISOString();
		const insert = store.db.query(
			`INSERT INTO executions (id, job_id, status, kind, scheduled_at, claimed_at, started_at, finished_at, exit_code, output_ref, error, meta)
			 VALUES (?, ?, 'completed', 'no-agent', ?, ?, ?, ?, 0, NULL, NULL, '{}')`,
		);
		for (let i = 0; i < 1005; i++) {
			const ts = new Date(Date.now() - i * 1000).toISOString();
			insert.run(`${job.id}:t${i}`, job.id, ts, ts, ts, ts);
		}
		expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM executions").get()!.n).toBe(1005);

		const scheduler = makeScheduler(store);
		scheduler.start();
		await Bun.sleep(1200); // ≥1 个 tick；无 stale 行
		scheduler.stop();

		const remaining = store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM executions").get()!.n;
		expect(remaining).toBe(1000); // 裁剪实际执行，而非死代码
		store.close();
	});

	test("completed once job beyond retention days is removed", async () => {
		const store = new JobStore(":memory:");
		const job = store.add({
			name: "once-old",
			enabled: true,
			schedule: { kind: "once", expr: "+1h" },
			action: { type: "no-agent", script: 'console.log("x")' },
			delivery: { target: "file", file: "o.txt" },
		});
		// 完成态：run_count=1、next_run=null、updated_at 回拨到 8 天前
		const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
		store.db
			.query(
				"UPDATE jobs SET run_count = 1, next_run = NULL, updated_at = ?, last_run = ? WHERE id = ?",
			)
			.run(old, old, job.id);

		const scheduler = makeScheduler(store, { completedOnceRetentionDays: 7 });
		scheduler.start();
		await Bun.sleep(1200);
		scheduler.stop();

		expect(store.get(job.id)).toBeUndefined(); // 留存清理实际执行
		store.close();
	});
});
