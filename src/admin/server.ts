/**
 * Admin HTTP server (contract 02 §7): localhost management API + WS event push.
 * Consumed by the omp extension shell (P7) and future tooling.
 * Zero cross-module imports: the daemon adapts its internals to AdminContext.
 */
import type { Logger } from "../util/logger.ts";

export interface AdminStatus {
	daemon: "running" | "stopped";
	qq: "connected" | "disconnected" | "connecting";
	scheduler: "running" | "stopped";
	runningJobs: number;
	jobs: number;
	lastTickAt?: string;
	lastSuccessAt?: string;
	lastErrorAt?: string;
}

export interface AdminJob {
	id: string;
	name: string;
	enabled: boolean;
	schedule: { kind: string; expr: string };
	action: { type: string };
	delivery: { target: string };
	status: string;
	next_run: string | null;
	last_run: string | null;
	run_count: number;
	fail_streak: number;
}

export type AdminEvent =
	| { type: "qq_message"; chatKey: string; text: string }
	| { type: "job_result"; job: string; ok: boolean; output: string }
	| { type: "nudge"; job: string; failStreak: number };

export interface AdminJobInput {
	name: string;
	enabled?: boolean;
	schedule: { kind: "cron" | "interval" | "once"; expr: string; repeat?: number };
	action: { type: "agent" | "no-agent"; prompt?: string; model?: string; script?: string; wake_agent?: boolean; context_from?: string[] };
	delivery: { target: string; file?: string; qq_chat?: string; silent?: boolean };
	workdir?: string;
	max_runs?: number;
	ttl_s?: number;
	/** job 创建来源标记（防死循环：agent 创建的调度 job 受限） */
	meta?: { source?: "agent" | "cli" };
}

export interface AdminDeadTarget {
	chatKey: string;
	errorKind: string;
	markedAt: string;
	lastError: string | null;
}

export interface AdminContext {
	status(): AdminStatus;
	jobs(): AdminJob[];
	addJob(input: AdminJobInput): AdminJob;
	updateJob(id: string, patch: Record<string, unknown>): AdminJob;
	removeJob(id: string): void;
	syncJob(id: string): void;
	sendQq(chatKey: string, text: string): Promise<void>;
	sendQqMedia(chatKey: string, filePath: string): Promise<void>;
	deadTargets(): AdminDeadTarget[];
	clearDeadTarget(chatKey: string): void;
	subscribe(listener: (e: AdminEvent) => void): () => void;
	emit(event: AdminEvent): void;
}

export interface AdminServerOptions {
	host: string;
	port: number;
	token: string;
}

function authOk(token: string, req: Request): boolean {
	if (token === "") return true;
	const header = req.headers.get("authorization") ?? "";
	return header === `Bearer ${token}`;
}

export class AdminServer {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly listeners = new Set<(e: AdminEvent) => void>();
	private readonly sockets = new Set<{ send(d: string): void; close(code?: number, reason?: string): void }>();

	constructor(
		private readonly opts: AdminServerOptions,
		private readonly ctx: AdminContext,
		private readonly logger: Logger,
	) {}

	start(): void {
		if (this.server) return;
		this.server = Bun.serve({
			hostname: this.opts.host,
			port: this.opts.port,
			fetch: (req, server) => this.handleFetch(req, server),
			websocket: {
				open: (ws) => {
					this.sockets.add(ws);
				},
				message: () => {},
				close: (ws) => {
					this.sockets.delete(ws);
				},
			},
		});
		// 事件广播：context 订阅者（daemon 侧 emit 时经此分发）
		this.unsub = this.ctx.subscribe((e) => this.broadcast(e));
		this.logger.info("admin server listening", { host: this.opts.host, port: this.opts.port });
	}

	private unsub: (() => void) | null = null;

	stop(): void {
		this.unsub?.();
		this.unsub = null;
		for (const ws of this.sockets) {
			try {
				ws.close(1000, "admin stop");
			} catch {
				// ignore
			}
		}
		this.sockets.clear();
		this.server?.stop(true);
		this.server = null;
	}

	private broadcast(e: AdminEvent): void {
		for (const ws of this.sockets) {
			try {
				ws.send(JSON.stringify(e));
			} catch {
				// stale socket; dropped
			}
		}
	}

	private async handleFetch(
		req: Request,
		server: { upgrade: (req: Request, options: { headers?: Record<string, string>; data: unknown }) => boolean },
	): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/api/ws") {
			if (!authOk(this.opts.token, req)) return new Response("unauthorized", { status: 401 });
			if (server.upgrade(req, { data: {} })) return new Response();
			return new Response("upgrade failed", { status: 500 });
		}
		if (!authOk(this.opts.token, req)) return new Response("unauthorized", { status: 401 });
		// CSRF 加固：跨站 POST 无法自定义 header（浏览器 drive-by），非 GET 一律要求
		// x-omp-gateway-csrf: 1。GET 与 WS upgrade 不受影响。
		if (req.method !== "GET" && req.headers.get("x-omp-gateway-csrf") !== "1") {
			return json({ error: "missing csrf header" }, 403);
		}

		try {
			switch (url.pathname) {
				case "/api/status":
					return json(this.ctx.status());
				case "/api/jobs":
					if (req.method === "GET") return json(this.ctx.jobs());
					if (req.method === "POST") {
						const input = (await req.json()) as AdminJobInput;
						const job = this.ctx.addJob(input);
						this.ctx.syncJob(job.id);
						return json(job, 201);
					}
					return methodNotAllowed();
				case "/api/outbound/qq":
					if (req.method === "POST") {
						const body = (await req.json()) as { chatKey: string; text: string; media?: string };
						if (typeof body.chatKey !== "string") {
							return json({ error: "chatKey required" }, 400);
						}
						if (typeof body.media === "string" && body.media.trim() !== "") {
							await this.ctx.sendQqMedia(body.chatKey, body.media);
							return json({ ok: true, media: true });
						}
						if (typeof body.text !== "string") {
							return json({ error: "text required" }, 400);
						}
						await this.ctx.sendQq(body.chatKey, body.text);
						return json({ ok: true });
					}
					return methodNotAllowed();
			}
			const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
			if (jobMatch) {
				const id = jobMatch[1]!;
				if (req.method === "PATCH") {
					const patch = (await req.json()) as Record<string, unknown>;
					const job = this.ctx.updateJob(id, patch);
					this.ctx.syncJob(id);
					return json(job);
				}
				if (req.method === "DELETE") {
					this.ctx.removeJob(id);
					return json({ ok: true });
				}
				return methodNotAllowed();
			}
			if (url.pathname === "/api/dead-targets") {
				if (req.method === "GET") return json(this.ctx.deadTargets());
				return methodNotAllowed();
			}
			const deadMatch = /^\/api\/dead-targets\/([^/]+)$/.exec(url.pathname);
			if (deadMatch && req.method === "DELETE") {
				this.ctx.clearDeadTarget(decodeURIComponent(deadMatch[1]!));
				return json({ ok: true });
			}
			return json({ error: `not found: ${url.pathname}` }, 404);
		} catch (err) {
			this.logger.error("admin request failed", { path: url.pathname, error: (err as Error).message });
			return json({ error: (err as Error).message }, 500);
		}
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function methodNotAllowed(): Response {
	return new Response("method not allowed", { status: 405 });
}
