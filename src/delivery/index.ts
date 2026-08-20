/**
 * Minimal delivery framework (contract 02 §5 / P6 完整版之前的最小集).
 * Routes a RunResult to file | qq | origin; applies SILENT + response wrapping.
 * Zero cross-module imports: callers adapt their Job type to DeliveryJob.
 */

export type DeliveryTargetName = "file" | "qq" | "origin";

/** Minimal job shape consumed by delivery (daemon adapts the scheduler Job). */
export interface DeliveryJob {
	name: string;
	delivery: {
		target: DeliveryTargetName;
		file?: string;
		qq_chat?: string;
		silent?: boolean;
		wrap_response?: boolean;
	};
}

/** Minimal run result shape consumed by delivery. */
export interface DeliveryRun {
	ok: boolean;
	output: string;
	error?: string;
}

export interface DeliveryDeps {
	/** Send a QQ message to a chat key (daemon wires QqGateway.send). */
	qqSend: (chatKey: string, text: string) => Promise<void>;
	/** Write output to a file (daemon wires fs). */
	fileSink: (path: string, text: string) => Promise<void>;
	/** Default target when job does not specify (config delivery.default_target). */
	defaultTarget: DeliveryTargetName;
	/** cron results default destination (config delivery.home_channel). */
	homeChannel: string;
	/** Global response wrapping toggle (config delivery.wrap_response). */
	wrapResponse: boolean;
	/** Prefix that marks a message silent (config delivery.silent_trigger). */
	silentTrigger: string;
}

/** Strip the SILENT trigger prefix; returns whether the run asked for silence. */
export function parseSilent(output: string, trigger: string): { text: string; silent: boolean } {
	if (trigger && output.trimStart().startsWith(trigger)) {
		return { text: output.trimStart().slice(trigger.length).trimStart(), silent: true };
	}
	return { text: output, silent: false };
}

/** Wrap a run result for delivery: status + timestamp + optional error. */
export function wrapResult(run: DeliveryRun, jobName: string, enabled: boolean): string {
	const ts = new Date().toISOString();
	const head = `[${jobName}] ${ts} ${run.ok ? "ok" : "FAILED"}`;
	const body = run.ok ? run.output : run.error ?? run.output;
	return `${head}\n${body}`;
}

export class Delivery {
	constructor(private readonly deps: DeliveryDeps) {}

	/**
	 * Deliver a run result. SILENT (job flag or trigger prefix) suppresses qq/origin
	 * delivery; file target still writes. Unresolvable targets degrade to
	 * defaultTarget/homeChannel with a logged warning via error throw.
	 */
	async deliver(
		run: DeliveryRun,
		job: DeliveryJob,
		opts: { originChatKey?: string } = {},
	): Promise<{ target: DeliveryTargetName; chatKey?: string; path?: string }> {
		const { text, silent } = parseSilent(run.output, this.deps.silentTrigger);
		const jobSilent = job.delivery.silent ?? false;
		const requested = job.delivery.target ?? this.deps.defaultTarget;
		const target: DeliveryTargetName =
			requested === "origin" && !opts.originChatKey ? this.deps.defaultTarget : requested;

		let payload = text;
		const wrap = job.delivery.wrap_response ?? this.deps.wrapResponse;
		if (wrap && !(silent || jobSilent)) payload = wrapResult({ ...run, output: text }, job.name, run.ok);

		if (target === "file") {
			const path = job.delivery.file ?? `.omp-gateway-output-${job.name}.txt`;
			await this.deps.fileSink(path, payload);
			return { target: "file", path };
		}

		if (silent || jobSilent) return { target }; // suppressed

		if (target === "qq") {
			const chatKey = job.delivery.qq_chat ?? this.deps.homeChannel;
			if (!chatKey) throw new Error(`delivery: no qq target for job ${job.name} (qq_chat or home_channel unset)`);
			await this.deps.qqSend(chatKey, payload);
			return { target: "qq", chatKey };
		}

		// origin
		const originKey = opts.originChatKey;
		if (!originKey) throw new Error(`delivery: origin target without originChatKey for job ${job.name}`);
		await this.deps.qqSend(originKey, payload);
		return { target: "origin", chatKey: originKey };
	}
}
