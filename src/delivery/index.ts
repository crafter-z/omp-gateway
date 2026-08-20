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
	/**
	 * Optional credential-leak scan mounted at the delivery exit (contract 02
	 * §6.4): run against the payload before it is sent/written; a hit swaps in
	 * the redacted version. Daemon wires util/scan.ts's scanSecrets.
	 */
	scan?: (text: string) => { matched: string[]; redacted: string };
	/** Invoked with the job name + matched patterns when the scan hits (daemon logs a warning). */
	onScanHit?: (jobName: string, matched: string[]) => void;
}

/** Result of a delivery: target + (per-target) destination + how many messages/segments were emitted. */
export interface DeliverOutcome {
	target: DeliveryTargetName;
	/** qq/origin destination chat key. */
	chatKey?: string;
	/** file target path. */
	path?: string;
	/** Number of messages actually sent (qq/origin: segmented parts; file: 1; suppressed: 0). */
	segments: number;
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

/** Characters that are safe cut points when segmenting (whitespace + common CJK/Latin punctuation). */
const SEGMENT_BOUNDARY = /[\s。，、；：？！,.!?;:]/;

/**
 * Split text into chunks of at most {@link maxLen} characters (default 2000,
 * the practical QQ single-message content ceiling). Each chunk prefers to end
 * on the last boundary character inside the window (never splits a word);
 * when the window holds no boundary it hard-cuts at maxLen. The loop always
 * advances, so it cannot spin forever even for degenerate input. Empty text
 * yields a single empty chunk (a blank message).
 */
export function segment(text: string, maxLen = 2000): string[] {
	const size = Math.floor(maxLen);
	const n = size > 0 ? size : 1;
	if (text.length <= n) return [text];
	const parts: string[] = [];
	let start = 0;
	while (start < text.length) {
		const end = Math.min(start + n, text.length);
		let cut = end;
		if (end < text.length) {
			// Walk back from the end: prefer the last boundary inside the window.
			for (let j = end - 1; j > start; j--) {
				if (SEGMENT_BOUNDARY.test(text[j])) {
					cut = j + 1;
					break;
				}
			}
		}
		parts.push(text.slice(start, cut));
		start = cut;
	}
	return parts;
}

export class Delivery {
	constructor(private readonly deps: DeliveryDeps) {}

	/**
	 * Deliver a run result. SILENT (job flag or trigger prefix) suppresses qq/origin
	 * delivery; file target still writes. Unresolvable targets degrade to
	 * defaultTarget/homeChannel with a logged warning via error throw.
	 *
	 * The payload is run through deps.scan (if wired) right before delivery —
	 * a match swaps in the redacted version and fires deps.onScanHit. qq/origin
	 * sends are segmented after wrapping so each message stays within the QQ
	 * content ceiling.
	 */
	async deliver(
		run: DeliveryRun,
		job: DeliveryJob,
		opts: { originChatKey?: string } = {},
	): Promise<DeliverOutcome> {
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
			await this.deps.fileSink(path, this.scanPayload(job.name, payload));
			return { target: "file", path, segments: 1 };
		}

		if (silent || jobSilent) return { target, segments: 0 }; // suppressed

		const safe = this.scanPayload(job.name, payload);
		const parts = segment(safe);

		if (target === "qq") {
			const chatKey = job.delivery.qq_chat ?? this.deps.homeChannel;
			if (!chatKey) throw new Error(`delivery: no qq target for job ${job.name} (qq_chat or home_channel unset)`);
			for (const part of parts) await this.deps.qqSend(chatKey, part);
			return { target: "qq", chatKey, segments: parts.length };
		}

		// origin
		const originKey = opts.originChatKey;
		if (!originKey) throw new Error(`delivery: origin target without originChatKey for job ${job.name}`);
		for (const part of parts) await this.deps.qqSend(originKey, part);
		return { target: "origin", chatKey: originKey, segments: parts.length };
	}

	/** Apply the credential-leak scan to the payload; alert on hits (contract 02 §6.4). */
	private scanPayload(jobName: string, payload: string): string {
		if (!this.deps.scan) return payload;
		const { matched, redacted } = this.deps.scan(payload);
		if (matched.length > 0) this.deps.onScanHit?.(jobName, matched);
		return redacted;
	}
}
