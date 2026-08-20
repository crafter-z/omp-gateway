/**
 * Daemon: orchestrates config -> store/ledger -> scheduler + qq gateway,
 * wires the omp RPC runner, and routes every run result through Delivery.
 *
 * M2 scope: cron (interval/once/cron) headless execution + QQ text inbound
 * round-trip (reply back to origin chat). Per-chat session reuse is P5.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GatewayConfig } from "./config/schema.ts";
import { expandHome } from "./config/load.ts";
import { createLogger, type Logger } from "./util/logger.ts";
import { scanSecrets } from "./util/scan.ts";
import { JobStore } from "./scheduler/store.ts";
import { Ledger } from "./scheduler/ledger.ts";
import { DefaultExecutor } from "./scheduler/executor.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import type { AgentRunner, Job, RunResult } from "./scheduler/types.ts";
import { OmpRpcClient } from "./omp/client.ts";
import { buildArgs } from "./omp/session.ts";
import { QqGateway } from "./qq/gateway.ts";
import { sendText } from "./qq/rest.ts";
import { downloadAudio, transcribeVoice } from "./qq/stt.ts";
import { ChatStore } from "./qq/chat.ts";
import type { InboundMessage } from "./qq/types.ts";
import { Delivery, type DeliveryJob } from "./delivery/index.ts";
import { AdminServer, type AdminContext, type AdminEvent, type AdminJob, type AdminJobInput, type AdminStatus } from "./admin/server.ts";

/**
 * Resolve the omp CLI entry for `bun <cliPath> --mode rpc`.
 * - absolute path to cli.js: used as-is
 * - "omp" (default): derived from the installed @oh-my-pi package
 *   (BUN_INSTALL / ~/.bun/install/global/node_modules/.../dist/cli.js, or the
 *   location of `omp` on PATH). P8 service mode MUST pass an absolute path —
 *   child PATH may be stripped.
 */
export function resolveCliPath(binary: string): string {
	if (existsSync(binary)) return binary;
	if (binary !== "" && binary !== "omp") return binary; // non-file, non-default: let client fail loudly

	const candidates: string[] = [];
	const bunInstall = process.env.BUN_INSTALL ?? join(homedir(), ".bun");
	candidates.push(
		join(bunInstall, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
	);
	const which = Bun.which("omp");
	if (which) {
		// .../.bun/bin/omp.exe -> .../.bun/install/global/node_modules/...
		candidates.push(
			join(dirname(dirname(which)), "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
		);
	}
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	throw new Error(
		`cannot resolve omp cli.js (binary="${binary}"); set omp.binary to the absolute cli.js path`,
	);
}

/** chatKey ("c2c:..." | "group:...") -> the openid/gid used by the REST API. */
export function openidOf(chatKey: string): string {
	return chatKey.startsWith("group:") ? chatKey.slice("group:".length) : chatKey.slice("c2c:".length);
}

/** Best-effort image MIME detection from magic bytes (QQ media URLs rarely carry extensions). */
function sniffImageMime(bytes: Uint8Array): string {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
	) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 6 &&
		bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39)
	) return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
	) return "image/webp";
	return "image/jpeg";
}

/** Encode image bytes as a data URL for the omp prompt `images` input. */
function toDataUrl(bytes: Uint8Array, mime: string): string {
	return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Deterministic per-chat session file path (reserved for P5 session reuse). */
export function sessionPathFor(cfg: GatewayConfig, chatKey: string): string {
	const dir = cfg.omp.session_dir || join(homedir(), ".omp", "agent", "sessions");
	const hash = createHash("sha1").update(chatKey).digest("hex").slice(0, 12);
	return join(expandHome(dir), `chat-${hash}.json`);
}

/** AgentRunner backed by OmpRpcClient: fresh session per run (--no-session). */
export class RpcRunner implements AgentRunner {
	constructor(
		private readonly cfg: GatewayConfig,
		private readonly logger: Logger,
	) {}

	async run(
		prompt: string,
		opts: { model?: string; cwd?: string; timeoutMs?: number; images?: string[] },
	): Promise<RunResult> {
		const cliPath = resolveCliPath(this.cfg.omp.binary);
		this.logger.debug("spawning omp rpc", { cliPath });
		const client = new OmpRpcClient({
			cliPath,
			cwd: opts.cwd,
			model: opts.model ?? (this.cfg.omp.model || undefined),
			thinking: this.cfg.omp.thinking,
			approval: this.cfg.omp.approval,
			extraArgs: [...this.cfg.omp.extra_args, ...buildArgs({ noSession: true })],
			timeoutMs: opts.timeoutMs ?? this.cfg.omp.rpc_timeout_ms,
		});
		await client.connect();
		try {
			let output = "";
			const tools: string[] = [];
			for await (const ev of client.prompt({ message: prompt, images: opts.images })) {
				if (ev.kind === "text_delta") output += ev.text;
				if (ev.kind === "tool") tools.push(ev.name);
				if (ev.kind === "error") {
					return { ok: false, output, error: ev.message, meta: { tools } };
				}
			}
			if (client.exitCode !== null && client.exitCode !== 0) {
				return { ok: false, output, error: `omp exited ${client.exitCode}: ${client.stderrLog}`, meta: { tools } };
			}
			return { ok: true, output, meta: { tools } };
		} finally {
			await client.close();
		}
	}
}

export class Daemon {
	readonly logger: Logger;
	private store?: JobStore;
	private scheduler?: Scheduler;
	private qq?: QqGateway;
	private delivery?: Delivery;
	private runner?: RpcRunner;
	private admin?: AdminServer;
	private readonly listeners = new Set<(e: AdminEvent) => void>();
	private started = false;

	constructor(
		private readonly cfg: GatewayConfig,
		logger?: Logger,
	) {
		this.logger = logger ?? createLogger({ level: cfg.log.level, file: expandHome(cfg.log.file) });
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const cfg = this.cfg;
		const log = this.logger;

		this.store = new JobStore(cfg.scheduler.ledger);
		this.runner = new RpcRunner(cfg, log.child("omp"));

		const executor = new DefaultExecutor({ runner: this.runner });
		const ledger = new Ledger(this.store);

		this.delivery = new Delivery({
			qqSend: async (chatKey, text) => {
				await sendText(cfg.qq, { chatKey, openid: openidOf(chatKey) }, text);
			},
			fileSink: async (path, text) => {
				await Bun.write(expandHome(path), text);
			},
			defaultTarget: cfg.delivery.default_target,
			homeChannel: cfg.delivery.home_channel,
			wrapResponse: cfg.delivery.wrap_response,
			silentTrigger: cfg.delivery.silent_trigger,
			scan: (text) => scanSecrets(text),
			onScanHit: (jobName, matched) => {
				log.warn("delivery secret scan hit — payload redacted", { job: jobName, matched });
			},
		});

		this.scheduler = new Scheduler(this.store, executor, {
			timezone: cfg.timezone,
			tickS: cfg.scheduler.tick_s,
			maxConcurrentJobs: cfg.scheduler.max_concurrent_jobs,
			misfireGraceS: cfg.scheduler.misfire_grace_s,
			onResult: (job, result) => void this.deliverJobResult(job, result),
		});
		if (cfg.scheduler.enabled) this.scheduler.start();

		this.chatStore = new ChatStore(this.store.db);
		this.qq = new QqGateway(cfg.qq, (m) => this.handleQqMessage(m));
		// Background connect: the gateway owns exponential-backoff reconnection.
		// Never blocks the daemon core — scheduler keeps working when QQ is down.
		void this.qq.connect().then(
			() => log.info("qq gateway connected"),
			(err) => log.error("qq gateway connect failed", { error: (err as Error).message }),
		);
		this.admin = new AdminServer(
			{ host: cfg.admin.host, port: cfg.admin.port, token: cfg.admin.token },
			this.adminContext(),
			log.child("admin"),
		);
		this.admin.start();
		log.info("daemon started", { jobs: this.store.list().filter((j) => j.enabled).length });
	}

	/** AdminContext 适配层：daemon 内部对象 → admin API（防死循环在此实施）。 */
	private adminContext(): AdminContext {
		const self = this;
		return {
			status(): AdminStatus {
				const store = self.store;
				const scheduler = self.scheduler;
				return {
					daemon: self.started ? "running" : "stopped",
					qq: self.qq ? "connecting" : "disconnected",
					scheduler: scheduler ? "running" : "stopped",
					runningJobs: store?.list().filter((j) => j.status === "running").length ?? 0,
					jobs: store?.list().length ?? 0,
				};
			},
			jobs(): AdminJob[] {
				return (self.store?.list() ?? []).map((j) => ({
					id: j.id,
					name: j.name,
					enabled: j.enabled,
					schedule: { kind: j.schedule.kind, expr: j.schedule.expr },
					action: { type: j.action.type },
					delivery: { target: j.delivery.target },
					status: j.status,
					next_run: j.next_run,
					last_run: j.last_run,
					run_count: j.run_count,
					fail_streak: j.fail_streak,
				}));
			},
			addJob(input: AdminJobInput) {
				if (!self.store) throw new Error("daemon not started");
				// 防死循环：agent 创建的调度 job 不得再创建 agent 调度 job
				if (input.meta?.source === "agent" && input.action.type === "agent") {
					throw new Error("agent-created jobs are restricted to no-agent actions (anti-loop)");
				}
				return self.store.add({
					name: input.name,
					enabled: input.enabled ?? true,
					schedule: input.schedule,
					action: input.action,
					delivery: input.delivery,
					workdir: input.workdir,
					max_runs: input.max_runs,
					ttl_s: input.ttl_s,
					next_run: null,
				});
			},
			updateJob(id: string, patch: Record<string, unknown>) {
				if (!self.store) throw new Error("daemon not started");
				const job = self.store.get(id);
				if (!job) throw new Error(`job not found: ${id}`);
				const allowed: Partial<Job> = {};
				for (const key of ["name", "enabled", "schedule", "action", "delivery", "workdir", "max_runs", "ttl_s"] as const) {
					if (key in patch) (allowed as Record<string, unknown>)[key] = patch[key];
				}
				return self.store.update(id, allowed);
			},
			removeJob(id: string) {
				if (!self.store) throw new Error("daemon not started");
				self.store.remove(id);
			},
			syncJob(id: string) {
				self.scheduler?.sync(id);
			},
			async sendQq(chatKey: string, text: string) {
				await sendText(self.cfg.qq, { chatKey, openid: openidOf(chatKey) }, text);
			},
			subscribe(listener) {
				self.listeners.add(listener);
				return () => self.listeners.delete(listener);
			},
			emit(event) {
				for (const listener of self.listeners) listener(event);
			},
		};
	}

	private chatStore?: ChatStore;

	private async handleQqMessage(m: InboundMessage): Promise<void> {
		if (!this.runner || !this.delivery || !this.chatStore) return;
		const log = this.logger.child("qq");
		this.chatStore.getOrCreate(m.chatKey, sessionPathFor(this.cfg, m.chatKey));
		log.info("inbound", { chatKey: m.chatKey, text: m.text.slice(0, 120) });
		try {
			let prompt = m.text;
			const images: string[] = [];
			for (const att of m.attachments) {
				if (att.type === "image") {
					try {
						const bytes = await downloadAudio(att.url);
						images.push(toDataUrl(bytes, sniffImageMime(bytes)));
					} catch (err) {
						log.warn("image download failed", { url: att.url, error: (err as Error).message });
					}
				} else if (att.type === "voice") {
					// Prefer the platform ASR transcription; fall back to the STT provider.
					const voiceText = att.asrText ?? (await transcribeVoice(this.cfg.qq.stt, att.url));
					if (voiceText) prompt = `${prompt}\n[语音转写] ${voiceText}`;
				}
			}
			const run = await this.runner.run(prompt, { timeoutMs: this.cfg.omp.rpc_timeout_ms, images });
			this.emit({ type: "qq_message", chatKey: m.chatKey, text: m.text.slice(0, 200) });
			await this.delivery.deliver(
				{ ok: run.ok, output: run.output, error: run.error },
				{ name: `qq:${m.chatKey}`, delivery: { target: "origin" } },
				{ originChatKey: m.chatKey },
			);
		} catch (err) {
			log.error("qq handler failed", { error: (err as Error).message });
		}
	}

	private async deliverJobResult(job: Job, result: RunResult): Promise<void> {
		if (!this.delivery) return;
		const deliveryJob: DeliveryJob = {
			name: job.name,
			delivery: {
				target: job.delivery.target,
				file: job.delivery.file,
				qq_chat: job.delivery.qq_chat,
				silent: job.delivery.silent,
				wrap_response: job.delivery.wrap_response,
			},
		};
		// 失败连击 nudge：fail_streak 达阈值（或其倍数）时提醒 home channel（经 delivery 事件）
		if (!result.ok && job.fail_streak > 0 && job.fail_streak % this.cfg.scheduler.nudge_after_failures === 0) {
			this.logger.warn("nudge: repeated job failures", { job: job.name, failStreak: job.fail_streak });
			this.emit({ type: "nudge", job: job.name, failStreak: job.fail_streak });
		}
		try {
			await this.delivery.deliver(
				{ ok: result.ok, output: result.output, error: result.error },
				deliveryJob,
			);
			this.emit({ type: "job_result", job: job.name, ok: result.ok, output: result.output.slice(0, 500) });
		} catch (err) {
			this.logger.error("delivery failed", { job: job.name, error: (err as Error).message });
		}
	}

	/** 向 admin 订阅者广播事件（WS /api/ws）。 */
	private emit(event: AdminEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.scheduler?.stop();
		await this.qq?.stop();
		this.admin?.stop();
		this.store?.close();
		this.logger.info("daemon stopped");
	}

	get storeInstance(): JobStore | undefined {
		return this.store;
	}

	get schedulerInstance(): Scheduler | undefined {
		return this.scheduler;
	}
}
