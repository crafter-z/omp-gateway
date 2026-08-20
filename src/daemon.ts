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
import { JobStore } from "./scheduler/store.ts";
import { Ledger } from "./scheduler/ledger.ts";
import { DefaultExecutor } from "./scheduler/executor.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import type { AgentRunner, Job, RunResult } from "./scheduler/types.ts";
import { OmpRpcClient } from "./omp/client.ts";
import { buildArgs } from "./omp/session.ts";
import { QqGateway } from "./qq/gateway.ts";
import { sendText } from "./qq/rest.ts";
import { ChatStore } from "./qq/chat.ts";
import type { InboundMessage } from "./qq/types.ts";
import { Delivery, type DeliveryJob } from "./delivery/index.ts";

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

	async run(prompt: string, opts: { model?: string; cwd?: string; timeoutMs?: number }): Promise<RunResult> {
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
			for await (const ev of client.prompt({ message: prompt })) {
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
		log.info("daemon started", { jobs: this.store.list().filter((j) => j.enabled).length });
	}

	private chatStore?: ChatStore;

	private async handleQqMessage(m: InboundMessage): Promise<void> {
		if (!this.runner || !this.delivery || !this.chatStore) return;
		const log = this.logger.child("qq");
		this.chatStore.getOrCreate(m.chatKey, sessionPathFor(this.cfg, m.chatKey));
		log.info("inbound", { chatKey: m.chatKey, text: m.text.slice(0, 120) });
		try {
			const run = await this.runner.run(m.text, { timeoutMs: this.cfg.omp.rpc_timeout_ms });
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
		try {
			await this.delivery.deliver(
				{ ok: result.ok, output: result.output, error: result.error },
				deliveryJob,
			);
		} catch (err) {
			this.logger.error("delivery failed", { job: job.name, error: (err as Error).message });
		}
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.scheduler?.stop();
		await this.qq?.stop();
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
