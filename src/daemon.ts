/**
 * Daemon: orchestrates config -> store/ledger -> scheduler + qq gateway,
 * wires the omp RPC runner, and routes every run result through Delivery.
 *
 * M2 scope: cron (interval/once/cron) headless execution + QQ text inbound
 * round-trip (reply back to origin chat). Per-chat session reuse is P5.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GatewayConfig } from "./config/schema.ts";
import { expandHome } from "./config/load.ts";
import { createLogger, type Logger } from "./util/logger.ts";
import { scanSecrets } from "./util/scan.ts";
import { acquireLock } from "./util/lock.ts";
import { DeadTargetRegistry, isDeadTargetError, shouldProbeDead } from "./util/deadTargets.ts";
import { DeliveryLedger } from "./util/deliveryLedger.ts";
import { mirrorToSession } from "./util/sessionMirror.ts";
import { JobStore } from "./scheduler/store.ts";
import { Ledger } from "./scheduler/ledger.ts";
import { DefaultExecutor } from "./scheduler/executor.ts";
import { preflightJob } from "./scheduler/preflight.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import type { AgentRunner, Job, RunResult } from "./scheduler/types.ts";
import { OmpRpcClient } from "./omp/client.ts";
import { buildArgs } from "./omp/session.ts";
import { QqGateway } from "./qq/gateway.ts";
import { getAccessToken, sendMedia, sendInputNotify, sendText, type SendTextOptions } from "./qq/rest.ts";
import { downloadMedia, transcribeVoice } from "./qq/stt.ts";
import { ChatStore } from "./qq/chat.ts";
import type { InboundMessage } from "./qq/types.ts";
import { Delivery, StreamingReply, type DeliveryJob } from "./delivery/index.ts";
import { AdminServer, type AdminContext, type AdminDeadTarget, type AdminEvent, type AdminJob, type AdminJobInput, type AdminStatus } from "./admin/server.ts";

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
/**
 * sendText 选项组装：markdown_support=true 时走 msg_type 2 富文本；
 * msgId/msgSeq 来自投递层的被动回复字段。
 */
function formatOpts(
	markdownSupport: boolean,
	sendOpts?: { msgId?: string; msgSeq?: number },
): SendTextOptions {
	return {
		markdown: markdownSupport,
		...(sendOpts?.msgId ? { msgId: sendOpts.msgId, msgSeq: sendOpts.msgSeq } : {}),
	};
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

/**
 * AgentRunner backed by OmpRpcClient。会话策略（contract 02 §5.1）：
 * - opts.sessionPath 缺省 → `--no-session`（cron 每 job 全新会话）
 * - opts.sessionPath 给定 → `-r <path>`（QQ chat per-chat 续聊；
 *   omp 对不存在的路径原地新建会话）
 */
export class RpcRunner implements AgentRunner {
	constructor(
		private readonly cfg: GatewayConfig,
		private readonly logger: Logger,
	) {}

	async run(
		prompt: string,
		opts: { model?: string; cwd?: string; timeoutMs?: number; images?: string[]; sessionPath?: string },
	): Promise<RunResult> {
		const client = await this.#connect(opts);
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

	/**
	 * 流式变体：text_delta 经 onDelta 回调增量外送（StreamingReply.push），
	 * 返回值语义与 run() 完全一致（output 为全文，供台账/审计）。
	 */
	async runStreaming(
		prompt: string,
		opts: {
			model?: string;
			cwd?: string;
			timeoutMs?: number;
			images?: string[];
			sessionPath?: string;
			onDelta: (text: string) => Promise<void>;
		},
	): Promise<RunResult> {
		const client = await this.#connect(opts);
		try {
			let output = "";
			const tools: string[] = [];
			for await (const ev of client.prompt({ message: prompt, images: opts.images })) {
				if (ev.kind === "text_delta") {
					output += ev.text;
					await opts.onDelta(ev.text);
				}
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

	async #connect(opts: { model?: string; cwd?: string; timeoutMs?: number; sessionPath?: string }) {
		const cliPath = resolveCliPath(this.cfg.omp.binary);
		this.logger.debug("spawning omp rpc", { cliPath, session: opts.sessionPath ? "resume" : "fresh" });
		const client = new OmpRpcClient({
			cliPath,
			cwd: opts.cwd,
			model: opts.model ?? (this.cfg.omp.model || undefined),
			thinking: this.cfg.omp.thinking,
			approval: this.cfg.omp.approval,
			extraArgs: [
				...this.cfg.omp.extra_args,
				...buildArgs(opts.sessionPath ? { sessionPath: opts.sessionPath } : { noSession: true }),
			],
			timeoutMs: opts.timeoutMs ?? this.cfg.omp.rpc_timeout_ms,
		});
		await client.connect();
		return client;
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
	private chatStore?: ChatStore;
	private deadTargets?: DeadTargetRegistry;
	private deliveryLedger?: DeliveryLedger;
	private readonly listeners = new Set<(e: AdminEvent) => void>();
	private started = false;
	private stopping = false;
	/** 实例锁句柄（平台锁：同一 ledger 不允许第二个 daemon 实例）。 */
	private instanceLock?: { release(): Promise<void> };
	/** Typing 指示器 debounce：chatKey → last sent ms。有界：超 500 删最旧。 */
	private readonly typingSentAt = new Map<string, number>();
	/** 死目标探活节流：chatKey → last probe ms（自愈用，见 shouldProbeDead）。 */
	private readonly deadProbeAt = new Map<string, number>();
	/** per-chat 串行化队列：chatKey → 尾部 chain promise（完成即清理，保持有界）。 */
	private readonly chatQueues = new Map<string, Promise<void>>();
	/** 在途投递 promise 集合：stop() 排空等待，防止关库后投递写台账崩溃。 */
	private readonly inFlightDeliveries = new Set<Promise<void>>();

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

		// 平台锁：同一 ledger 只允许一个 daemon 实例（防 AppID 重复连接）。
		// ":memory:"（测试）每个实例独立，无需锁。
		if (cfg.scheduler.ledger !== ":memory:") {
			const lockPath = `${cfg.scheduler.ledger}.instance`;
			try {
				this.instanceLock = await acquireLock(lockPath, { timeoutMs: 5_000, staleMs: 60_000 });
			} catch {
				this.started = false;
				throw new Error(`another daemon instance holds the lock (${lockPath}) — refusing to start`);
			}
		}

		this.store = new JobStore(cfg.scheduler.ledger);
		this.runner = new RpcRunner(cfg, log.child("omp"));

		// 输出审计目录 + 保存/取回（context_from 链 + output_ref 台账）
		let outputsDir = "";
		if (cfg.scheduler.ledger !== ":memory:") {
			outputsDir = join(dirname(cfg.scheduler.ledger), "outputs");
			mkdirSync(outputsDir, { recursive: true });
		}
		const saveOutput = async (jobId: string, output: string): Promise<string | null> => {
			if (outputsDir === "") return null;
			try {
				const jobDir = join(outputsDir, jobId);
				mkdirSync(jobDir, { recursive: true });
				const p = join(jobDir, `${Date.now()}.txt`);
				writeFileSync(p, output, "utf8");
				return p;
			} catch {
				return null;
			}
		};
		const lastOutput = async (jobName: string): Promise<string | null> => {
			try {
				const job = this.store!.getByName(jobName);
				if (!job) return null;
				const row = this.store!.db
					.query<{ output_ref: string | null }, string[]>(
						"SELECT output_ref FROM executions WHERE job_id = ? AND status = 'completed' AND output_ref IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
					)
					.get(job.id);
				if (!row?.output_ref) return null;
				const text = readFileSync(row.output_ref, "utf8");
				return text.length > 64_000 ? text.slice(0, 64_000) : text;
			} catch {
				return null;
			}
		};

		const executor = new DefaultExecutor({
			runner: this.runner,
			saveOutput,
			lastOutput,
			currentDefaultModel: () => (cfg.omp.model.trim() === "" ? undefined : cfg.omp.model),
		});
		const ledger = new Ledger(this.store);
		this.deadTargets = new DeadTargetRegistry(this.store.db);
		this.deliveryLedger = new DeliveryLedger(this.store.db);

		// 投递出口（dead-target 短路 + 成功自愈）。
		const qqSend = async (chatKey: string, text: string, sendOpts?: { msgId?: string; msgSeq?: number }) => {
			const dead = this.deadTargets!;
			let probing = false;
			if (dead.isDead(chatKey)) {
				if (!shouldProbeDead(chatKey, this.deadProbeAt)) {
					log.warn("delivery skipped: dead target", { chatKey });
					return;
				}
				// 探活自愈：≥10 分钟才放行一次真实发送。成功走下方正常路径（clear）；
				// 失败且仍是死目标错误 → 按现有 markDead 逻辑标记并吞掉错误维持静默。
				this.deadProbeAt.set(chatKey, Date.now());
				probing = true;
				log.info("dead target probe send", { chatKey });
			}
			try {
				await sendText(
					cfg.qq,
					{ chatKey, openid: openidOf(chatKey) },
					text,
					formatOpts(cfg.qq.markdown_support, sendOpts),
				);
				dead.clear(chatKey); // 自愈
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (isDeadTargetError(msg)) {
					dead.markDead(chatKey, msg);
					if (probing) return; // 探活失败：目标确认仍死，维持短路语义
				}
				throw err;
			}
		};
		const qqSendMedia = async (chatKey: string, filePath: string, kind: "image" | "file") => {
			const dead = this.deadTargets!;
			if (dead.isDead(chatKey)) return;
			try {
				await sendMedia(cfg.qq, { chatKey, openid: openidOf(chatKey) }, filePath, kind);
				dead.clear(chatKey);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (isDeadTargetError(msg)) dead.markDead(chatKey, msg);
				throw err;
			}
		};

		this.delivery = new Delivery({
			qqSend,
			qqSendMedia,
			fileSink: async (path, text) => {
				await Bun.write(expandHome(path), text);
			},
			auditSink: async (path, text) => {
				const dir = expandHome("~/.omp-gateway/audit");
				mkdirSync(dir, { recursive: true });
				await Bun.write(join(dir, path), text);
			},
			defaultTarget: cfg.delivery.default_target,
			homeChannel: cfg.delivery.home_channel,
			wrapResponse: cfg.delivery.wrap_response,
			silentTrigger: cfg.delivery.silent_trigger,
			filterSilenceNarration: cfg.delivery.filter_silence_narration,
			ledger: this.deliveryLedger,
			scan: (text) => scanSecrets(text),
			onScanHit: (jobName, matched) => {
				log.warn("delivery secret scan hit — payload redacted", { job: jobName, matched });
			},
			onMediaError: (jobName, path, error) => {
				log.warn("media delivery failed", { job: jobName, path, error });
			},
		});

		// 崩溃恢复：重投递未完成的投递义务（诚实 at-least-once）。
		void this.recoverDeliveries(qqSend);

		this.scheduler = new Scheduler(this.store, executor, {
			timezone: cfg.timezone,
			tickS: cfg.scheduler.tick_s,
			maxConcurrentJobs: cfg.scheduler.max_concurrent_jobs,
			misfireGraceS: cfg.scheduler.misfire_grace_s,
			staleExecutionS: cfg.scheduler.stale_execution_s,
			onResult: (job, result) => void this.deliverJobResult(job, result),
			log: (msg: string) => log.child("scheduler").info(msg),
			livenessDir: cfg.scheduler.liveness_dir ? expandHome(cfg.scheduler.liveness_dir) : undefined,
			outputsDir: outputsDir !== "" ? outputsDir : undefined,
			completedOnceRetentionDays: cfg.scheduler.completed_once_retention_days,
			outputRetention: cfg.scheduler.output_retention,
		});
		if (cfg.scheduler.enabled) this.scheduler.start();

		this.chatStore = new ChatStore(this.store.db);
		this.qq = new QqGateway(cfg.qq, (m) => this.handleQqMessage(m), {
			tokenProvider: () => getAccessToken(cfg.qq),
			onLog: (msg: string) => log.child("qq").warn(msg),
		});
		// Background connect: the gateway owns exponential-backoff reconnection.
		// Never blocks the daemon core — scheduler keeps working when QQ is down.
		void this.qq.connect().then(
			() => log.info("qq gateway connected"),
			(err) => log.error("qq gateway connect failed", { error: (err as Error).message }),
		);
		// admin 加固：非 loopback 绑定必须配置 token，否则拒绝启动
		// （无鉴权的管理面暴露在局域网 = 任意 job CRUD + QQ 消息出口）。
		const isLoopback = (host: string): boolean => host in { "127.0.0.1": true, "::1": true, localhost: true };
		if (!isLoopback(cfg.admin.host.toLowerCase()) && cfg.admin.token === "") {
			throw new Error(
				`admin.host "${cfg.admin.host}" is not loopback and admin.token is empty — refusing to start; ` +
					"set admin.token or bind admin.host to 127.0.0.1/::1/localhost",
			);
		}
		this.admin = new AdminServer(
			{ host: cfg.admin.host, port: cfg.admin.port, token: cfg.admin.token },
			this.adminContext(),
			log.child("admin"),
		);
		this.admin.start();
		log.info("daemon started", { jobs: this.store.list().filter((j) => j.enabled).length });
	}

	/** 崩溃恢复：交付 ledger 中未完成的行重投递（attempting 行带 ♻️ 重复标记）。 */
	private async recoverDeliveries(
		qqSend: (chatKey: string, text: string, opts?: { msgId?: string; msgSeq?: number }) => Promise<void>,
	): Promise<void> {
		const ledger = this.deliveryLedger;
		if (!ledger) return;
		for (const row of ledger.sweepRecoverable(30_000)) {
			const text = row.recovered ? `♻️ Recovered reply — may be a duplicate:\n${row.text}` : row.text;
			ledger.markAttempting(row.id);
			try {
				await qqSend(row.chatKey, text);
				ledger.markDelivered(row.id);
				this.logger.info("recovered delivery", { id: row.id, chatKey: row.chatKey });
			} catch (err) {
				ledger.markFailed(row.id, err instanceof Error ? err.message : String(err));
				this.logger.warn("recovered delivery failed", { id: row.id, error: (err as Error).message });
			}
		}
	}

	/** AdminContext 适配层：daemon 内部对象 → admin API（防死循环在此实施）。 */
	private adminContext(): AdminContext {
		const self = this;
		return {
			status(): AdminStatus {
				const store = self.store;
				const scheduler = self.scheduler;
				// best-effort 读取 scheduler liveness 信号（空目录 = 关闭，永不抛错）
				const livenessDir = self.cfg.scheduler.liveness_dir ? expandHome(self.cfg.scheduler.liveness_dir) : "";
				const readLiveness = (name: string): string | undefined => {
					if (!livenessDir) return undefined;
					try {
						const line = readFileSync(join(livenessDir, name), "utf8");
						const token = line.trim().split(/\s+/)[0];
						return token || undefined;
					} catch {
						return undefined;
					}
				};
				return {
					daemon: self.started ? "running" : "stopped",
					qq: self.qq ? (self.qq.connected ? "connected" : "connecting") : "disconnected",
					scheduler: scheduler ? "running" : "stopped",
					runningJobs: store?.list().filter((j) => j.status === "running").length ?? 0,
					jobs: store?.list().length ?? 0,
					lastTickAt: readLiveness("ticker_heartbeat"),
					lastSuccessAt: readLiveness("ticker_last_success"),
					lastErrorAt: readLiveness("ticker_last_error"),
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
				// 预检（不烧 token）：schedule/action/delivery 合法性，失败拒绝写入
				const errors = preflightJob({
					name: input.name,
					enabled: input.enabled ?? true,
					schedule: input.schedule,
					action: input.action,
					delivery: input.delivery,
					workdir: input.workdir,
					max_runs: input.max_runs,
					ttl_s: input.ttl_s,
				});
				if (errors.length > 0) throw new Error(`preflight failed: ${errors.join("; ")}`);
				// 模型漂移守卫快照：未 pin 模型的 agent job 记录创建时的全局默认。
				const meta = input.meta as Record<string, unknown> | undefined;
				const snapshotMeta: Record<string, unknown> = { ...(meta ?? {}) };
				if (input.action.type === "agent" && (!input.action.model || input.action.model.trim() === "")) {
					const globalModel = self.cfg.omp.model.trim();
					if (globalModel !== "") {
						snapshotMeta.provider_snapshot = { model: globalModel };
					}
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
					meta: snapshotMeta,
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
				const merged = { ...job, ...allowed };
				// anti-loop 复查：source=agent 的 job 不得经 PATCH 换成 agent 型 action（防绕过）
				if ((merged.meta as { source?: unknown } | undefined)?.source === "agent" && merged.action.type === "agent") {
					throw new Error("agent-created jobs are restricted to no-agent actions (anti-loop)");
				}
				// 预检合并后的完整 job（PATCH 可能只带 schedule 或 action）
				const errors = preflightJob({
					name: merged.name,
					enabled: merged.enabled,
					schedule: merged.schedule,
					action: merged.action,
					delivery: merged.delivery,
					workdir: merged.workdir,
					max_runs: merged.max_runs,
					ttl_s: merged.ttl_s,
				});
				if (errors.length > 0) throw new Error(`preflight failed: ${errors.join("; ")}`);
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
			async sendQqMedia(chatKey: string, filePath: string) {
				const kind = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(filePath) ? "image" : "file";
				await sendMedia(self.cfg.qq, { chatKey, openid: openidOf(chatKey) }, filePath, kind);
			},
			deadTargets(): AdminDeadTarget[] {
				return (self.deadTargets?.list() ?? []).map((d) => ({
					chatKey: d.chatKey,
					errorKind: d.errorKind,
					markedAt: d.markedAt,
					lastError: d.lastError,
				}));
			},
			clearDeadTarget(chatKey: string) {
				self.deadTargets?.clear(chatKey);
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

	private async handleQqMessage(m: InboundMessage): Promise<void> {
		// per-chat 串行化：gateway 对消息 fire-and-forget，同 chatKey 的并发消息若不
		// 排队会同时 spawn 多个 omp -r 写同一 session 文件。链式排队保证 FIFO。
		const key = m.chatKey;
		const prev = this.chatQueues.get(key) ?? Promise.resolve();
		const chain = prev.catch(() => {}).then(() => this.runQqMessage(m));
		this.chatQueues.set(key, chain);
		// 有界清理：仅当仍是链尾时删除（后续入队者已替换 Map 值）。
		void chain.finally(() => {
			if (this.chatQueues.get(key) === chain) this.chatQueues.delete(key);
		});
		return chain;
	}

	/** 原 handleQqMessage 消息处理主体（经 per-chat 队列串行调用）。 */
	private async runQqMessage(m: InboundMessage): Promise<void> {
		if (!this.runner || !this.delivery || !this.chatStore) return;
		const log = this.logger.child("qq");
		if (!this.isAllowed(m)) {
			log.warn("inbound rejected by allowlist", { chatKey: m.chatKey, author: m.authorOpenid });
			return;
		}
		const chat = this.chatStore.getOrCreate(m.chatKey, sessionPathFor(this.cfg, m.chatKey));
		// omp -r 对不存在的会话路径会原地新建（ENOENT → 空条目 → 原路径落盘），先确保父目录存在
		mkdirSync(dirname(chat.sessionPath), { recursive: true });
		log.info("inbound", { chatKey: m.chatKey, text: m.text.slice(0, 120) });
		await this.maybeSendTyping(m, chat.sessionPath);
		try {
			let prompt = m.text;
			const images: string[] = [];
			// QQ 多媒体 CDN 下载需要 Authorization 头。
			const authToken = await getAccessToken(this.cfg.qq).catch(() => undefined);
			const fileParts: string[] = [];
			for (const att of m.attachments) {
				if (att.type === "image") {
					try {
						const bytes = await downloadMedia(att.url, { authToken });
						images.push(toDataUrl(bytes, sniffImageMime(bytes)));
					} catch (err) {
						log.warn("image download failed", { url: att.url, error: (err as Error).message });
					}
				} else if (att.type === "voice") {
					// 优先平台 ASR；其次 voice_wav_url / 原 URL + ffmpeg 转码；失败给用户可见标记。
					const voiceText =
						att.asrText ??
						(await transcribeVoice(this.cfg.qq.stt, att.url, { authToken, voiceWavUrl: att.voiceWavUrl }));
					if (voiceText) prompt = `${prompt}\n[语音转写] ${voiceText}`;
					else prompt = `${prompt}\n[语音识别失败]`;
				} else {
					// 文件附件：把名称 + URL 交给 agent（可 fetch）。
					fileParts.push(`[file: ${att.filename || "attachment"} (${att.url})]`);
				}
			}
			if (fileParts.length > 0) prompt = `${prompt}\n${fileParts.join("\n")}`;
			// 引用消息上下文（message_type 103）：原文 + 引用图片。
			if (m.quoted) {
				prompt = `[Quoted message]:\n${m.quoted.text}\n\n${prompt}`;
				for (const url of m.quoted.images) {
					try {
						const bytes = await downloadMedia(url, { authToken });
						images.push(toDataUrl(bytes, sniffImageMime(bytes)));
					} catch (err) {
						log.warn("quoted image download failed", { url, error: (err as Error).message });
					}
				}
			}
			this.emit({ type: "qq_message", chatKey: m.chatKey, text: m.text.slice(0, 200) });
			if (this.cfg.delivery.stream_replies) {
				await this.#runWithStreaming(m, prompt, images, chat.sessionPath);
			} else {
				const run = await this.runner.run(prompt, {
					timeoutMs: this.cfg.omp.rpc_timeout_ms,
					images,
					sessionPath: chat.sessionPath, // per-chat 续聊：同 chat_key 复用同一会话文件
				});
				await this.delivery.deliver(
					{ ok: run.ok, output: run.output, error: run.error },
					// 聊天回复不加 wrap（"[job] 时间戳 ok" 前缀是 cron 投递语义），
					// job name 也不进 payload，避免 secret-scan 对 openid 的误脱敏
					{
						name: `qq:${m.chatKey}`,
						delivery: {
							target: "origin",
							wrap_response: false,
							markdown_support: this.cfg.qq.markdown_support,
						},
					},
					{ originChatKey: m.chatKey, replyTo: m.id },
				);
			}
		} catch (err) {
			log.error("qq handler failed", { error: (err as Error).message });
		}
	}

	/** Typing 指示器（C2C 专属，50s debounce；失败静默）。 */
	private async maybeSendTyping(m: InboundMessage, _sessionPath: string): Promise<void> {
		if (!this.cfg.qq.typing_indicator) return;
		if (!m.chatKey.startsWith("c2c:")) return;
		const now = Date.now();
		const last = this.typingSentAt.get(m.chatKey) ?? 0;
		if (now - last < 40_000) return;
		if (this.typingSentAt.size > 500) this.typingSentAt.delete(this.typingSentAt.keys().next().value!);
		this.typingSentAt.set(m.chatKey, now);
		try {
			await sendInputNotify(this.cfg.qq, { chatKey: m.chatKey, openid: openidOf(m.chatKey) }, { msgId: m.id });
		} catch {
			// best-effort
		}
	}

	/**
	 * 流式回复（cfg.delivery.stream_replies=true）：text_delta 经 StreamingReply
	 * 缓冲切块发送；失败且尚无任何块发出时回退一次性投递完整错误，保证用户
	 * 总能收到反馈。成功时块已全部发出，不再走 delivery 重复投递。
	 */
	async #runWithStreaming(
		m: InboundMessage,
		prompt: string,
		images: string[],
		sessionPath: string,
	): Promise<RunResult> {
		const log = this.logger.child("qq");
		const stream = new StreamingReply({
			send: async (text, sendOpts) => {
				await sendText(
					this.cfg.qq,
					{ chatKey: m.chatKey, openid: openidOf(m.chatKey) },
					text,
					formatOpts(this.cfg.qq.markdown_support, sendOpts),
				);
			},
			replyTo: m.id,
			chunkChars: this.cfg.delivery.stream_chunk_chars,
			scan: (text) => scanSecrets(text),
		});
		const run = await this.runner!.runStreaming(prompt, {
			timeoutMs: this.cfg.omp.rpc_timeout_ms,
			images,
			sessionPath,
			onDelta: (delta) => stream.push(delta),
		});
		await stream.finish();
		if (!run.ok && stream.sentChunks === 0 && this.delivery) {
			// 一条都没发出去过 → 走常规投递把错误送达（聊天回复不加 wrap）
			await this.delivery.deliver(
				{ ok: false, output: run.output, error: run.error },
				{
					name: `qq:${m.chatKey}`,
					delivery: {
						target: "origin",
						wrap_response: false,
						markdown_support: this.cfg.qq.markdown_support,
					},
				},
				{ originChatKey: m.chatKey, replyTo: m.id },
			);
		} else if (!run.ok) {
			log.warn("streamed reply ended with error after chunks were sent", { error: run.error });
		}
		return run;
	}

	/**
	 * Allowlist gate (contract 02 §6.4): c2c/dm requires the author to be
	 * listed (or allow_all_users); group/guild chats require the group/guild
	 * to be listed. An empty list denies by default — fail closed.
	 */
	private isAllowed(m: InboundMessage): boolean {
		const allow = this.cfg.qq.allow;
		if (m.chatKey.startsWith("group:") || m.chatKey.startsWith("guild:")) {
			return allow.groups.includes(m.chatKey.slice(m.chatKey.indexOf(":") + 1));
		}
		return allow.allow_all_users || allow.users.includes(m.authorOpenid);
	}
	private async deliverJobResult(job: Job, result: RunResult): Promise<void> {
		// 投递主体经 #trackDelivery 追踪：stop() 关库前排空，防止在 store 关闭后
		// 仍写台账/mirror。fire() 层面不变。
		const t = this.#trackDelivery(job, result);
		return t;
	}

	#trackDelivery(job: Job, result: RunResult): Promise<void> {
		const tracked = (async () => {
 		if (!this.delivery) return;

		// 中断感知（hermes _is_interrupted 对等）：daemon 关闭中完成的 job 若呈现
		// 成功，禁止把截断输出当完整成功投递——强制按失败投递诚实摘要。
		let effective = result;
		if (this.stopping && result.ok) {
			effective = { ok: false, output: "", error: "Interrupted by gateway shutdown" };
		}

		// 失败必达：job 失败（含中断）无条件向 home channel / origin 投递分类摘要，
		// 而不是只在 fail_streak 达阈值时发 admin 事件。
		const deliveryJob: DeliveryJob = {
			name: job.name,
			delivery: {
				target: effective.ok ? job.delivery.target : "all",
				file: job.delivery.file,
				qq_chat: job.delivery.qq_chat,
				silent: effective.ok ? job.delivery.silent : false,
				wrap_response: job.delivery.wrap_response,
				markdown_support: job.delivery.markdown_support,
			},
		};
		// 失败连击 nudge：fail_streak 达阈值（或其倍数）时提醒 home channel（经 delivery 事件）
		if (!effective.ok && job.fail_streak > 0 && job.fail_streak % this.cfg.scheduler.nudge_after_failures === 0) {
			this.logger.warn("nudge: repeated job failures", { job: job.name, failStreak: job.fail_streak });
			this.emit({ type: "nudge", job: job.name, failStreak: job.fail_streak });
		}
		try {
			const outcomes = await this.delivery.deliver(
				{ ok: effective.ok, output: effective.output, error: effective.error },
				deliveryJob,
			);
			this.emit({ type: "job_result", job: job.name, ok: effective.ok, output: effective.output.slice(0, 500) });
			// continuable 续聊：把干净的 cron 输出镜像进目标 chat 的 omp 会话
			// 转录，使后续 QQ 回复在同一会话里带上下次执行的上下文。
			if (job.delivery.continuable !== false && effective.ok && outcomes.length > 0 && this.store) {
				const chatKey = outcomes[0]?.chatKey;
				if (chatKey) {
					try {
						const row = this.store.db
							.query<{ session_path: string }, string[]>(
								"SELECT session_path FROM chat_sessions WHERE chat_key = ?",
							)
							.get(chatKey);
						if (row?.session_path) {
							await mirrorToSession(
								row.session_path,
								`[cron delivery of job ${job.name}]\n${effective.output}`,
								(msg) => this.logger.warn(msg),
							);
						}
					} catch (err) {
						this.logger.warn("session mirror failed", { job: job.name, error: (err as Error).message });
					}
				}
			}
		} catch (err) {
			this.logger.error("delivery failed", { job: job.name, error: (err as Error).message });
		}
		})();
		this.inFlightDeliveries.add(tracked);
		void tracked.finally(() => this.inFlightDeliveries.delete(tracked));
		return tracked;
	}

	/** 向 admin 订阅者广播事件（WS /api/ws）。 */
	private emit(event: AdminEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.stopping = true;
		this.scheduler?.stop();
		await this.qq?.stop();
		this.admin?.stop();
		// 排空在途投递（10s 上限）：store 关闭后 delivery/ledger/mirror 不可再写。
		await Promise.race([
			Promise.allSettled([...this.inFlightDeliveries]),
			Bun.sleep(10_000),
		]);
		this.store?.close();
		await this.instanceLock?.release();
		this.instanceLock = undefined;
		this.logger.info("daemon stopped");
	}

	get storeInstance(): JobStore | undefined {
		return this.store;
	}

	get schedulerInstance(): Scheduler | undefined {
		return this.scheduler;
	}
}
