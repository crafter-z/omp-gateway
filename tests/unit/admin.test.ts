import { describe, expect, test } from "bun:test";
import { AdminServer, type AdminContext, type AdminEvent, type AdminJob } from "../../src/admin/server.ts";
import { createLogger } from "../../src/util/logger.ts";

function makeCtx(overrides: Partial<AdminContext> = {}): AdminContext & {
	added: unknown[];
	removed: string[];
	synced: string[];
	sent: { chatKey: string; text: string }[];
	events: AdminEvent[];
} {
	const added: unknown[] = [];
	const removed: string[] = [];
	const synced: string[] = [];
	const sent: { chatKey: string; text: string }[] = [];
	const events: AdminEvent[] = [];
	const listeners = new Set<(e: AdminEvent) => void>();
	return {
		status: () => ({ daemon: "running", qq: "connecting", scheduler: "running", runningJobs: 1, jobs: 2 }),
		jobs: () => [],
		addJob: (input) => {
			added.push(input);
			return { id: "j1", name: input.name, enabled: true, schedule: { kind: "interval", expr: "5m" }, action: { type: "no-agent" }, delivery: { target: "file" }, status: "idle", next_run: null, last_run: null, run_count: 0, fail_streak: 0 } satisfies AdminJob;
		},
		updateJob: (id, patch) => ({ id, name: String(patch.name ?? "x"), enabled: true, schedule: { kind: "interval", expr: "5m" }, action: { type: "no-agent" }, delivery: { target: "file" }, status: "idle", next_run: null, last_run: null, run_count: 0, fail_streak: 0 }),
		removeJob: (id) => removed.push(id),
		syncJob: (id) => synced.push(id),
		sendQq: async (chatKey, text) => void sent.push({ chatKey, text }),
		subscribe: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		emit: (e) => {
			for (const l of listeners) l(e);
		},
		...overrides,
		added,
		removed,
		synced,
		sent,
		events,
	};
}

async function startServer(token = ""): Promise<{ server: AdminServer; ctx: ReturnType<typeof makeCtx>; base: string }> {
	const ctx = makeCtx();
	const server = new AdminServer({ host: "127.0.0.1", port: 0, token }, ctx, createLogger({ level: "error" }));
	server.start();
	const port = (server as unknown as { server: { port: number } }).server.port;
	return { server, ctx, base: `http://127.0.0.1:${port}` };
}

describe("AdminServer", () => {
	test("GET /api/status returns context status", async () => {
		const { server, base } = await startServer();
		try {
			const res = await fetch(`${base}/api/status`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toMatchObject({ daemon: "running", jobs: 2 });
		} finally {
			server.stop();
		}
	});

	test("token auth: no header -> 401, correct header -> 200", async () => {
		const { server, base } = await startServer("sekrit");
		try {
			const no = await fetch(`${base}/api/status`);
			expect(no.status).toBe(401);
			const yes = await fetch(`${base}/api/status`, { headers: { authorization: "Bearer sekrit" } });
			expect(yes.status).toBe(200);
		} finally {
			server.stop();
		}
	});

	test("POST /api/jobs adds and syncs", async () => {
		const { server, ctx, base } = await startServer();
		try {
			const res = await fetch(`${base}/api/jobs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: "n1",
					schedule: { kind: "interval", expr: "5m" },
					action: { type: "no-agent", script: "x.ts" },
					delivery: { target: "file", file: "o.txt" },
				}),
			});
			expect(res.status).toBe(201);
			expect(ctx.added).toHaveLength(1);
			expect(ctx.synced).toContain("j1");
		} finally {
			server.stop();
		}
	});

	test("PATCH /api/jobs/:id updates and syncs", async () => {
		const { server, ctx, base } = await startServer();
		try {
			const res = await fetch(`${base}/api/jobs/j1`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			});
			expect(res.status).toBe(200);
			expect(ctx.synced).toContain("j1");
		} finally {
			server.stop();
		}
	});

	test("DELETE /api/jobs/:id removes", async () => {
		const { server, ctx, base } = await startServer();
		try {
			const res = await fetch(`${base}/api/jobs/j1`, { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(ctx.removed).toContain("j1");
		} finally {
			server.stop();
		}
	});

	test("POST /api/outbound/qq sends", async () => {
		const { server, ctx, base } = await startServer();
		try {
			const res = await fetch(`${base}/api/outbound/qq`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chatKey: "c2c:u1", text: "hi" }),
			});
			expect(res.status).toBe(200);
			expect(ctx.sent).toEqual([{ chatKey: "c2c:u1", text: "hi" }]);
		} finally {
			server.stop();
		}
	});

	test("WS /api/ws pushes emitted events", async () => {
		const { server, ctx, base } = await startServer();
		try {
			const received: AdminEvent[] = [];
			const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/ws`);
			await new Promise<void>((resolve, reject) => {
				ws.addEventListener("open", () => resolve());
				ws.addEventListener("error", () => reject(new Error("ws open failed")));
			});
			ws.addEventListener("message", (ev) => {
				received.push(JSON.parse(ev.data as string) as AdminEvent);
			});
			ctx.emit({ type: "nudge", job: "j", failStreak: 3 });
			await Bun.sleep(200);
			expect(received).toContainEqual({ type: "nudge", job: "j", failStreak: 3 });
			ws.close();
		} finally {
			server.stop();
		}
	});
});
