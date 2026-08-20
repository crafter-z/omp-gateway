/**
 * OmpRpcClient — spawns `omp --mode rpc` and drives the RPC protocol.
 *
 * Wire reference: `@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-client.ts`
 * (installed at C:/Users/craft/.bun/install/global/node_modules/...).
 * Contract: docs/02-contracts.md §5; type draft: docs/05-implementation-plan.md §4.
 *
 * Lifecycle invariants:
 * - One prompt at a time per client (a client is bound to one omp session).
 * - After a hard abort (prompt timeout) or close(), the client is unusable
 *   and the spawned process tree is guaranteed dead (taskkill /T /F on win32).
 * - `close()` is idempotent.
 */
import type { Subprocess } from "bun";
import type { AgentEvent, HostToolDef, OmpClientOpts } from "./types.ts";
import { encodeFrame, isRecord, RpcFrameDecoder, MAX_RPC_FRAME_BYTES } from "./protocol.ts";

const READY_TIMEOUT_MS = 30_000;
const NEGOTIATE_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;
/** Grace between SIGTERM and hard taskkill during close(). */
const CLOSE_GRACE_MS = 1_500;
/** How long to wait for the stderr pipe to drain before composing failure messages. */
const STDERR_GRACE_MS = 250;

type RpcResponseFrame = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	code?: string;
};

interface PendingRequest {
	resolve: (frame: RpcResponseFrame) => void;
	reject: (error: Error) => void;
}

interface ActivePrompt {
	id: string;
	queue: AgentEvent[];
	ended: boolean;
	error: Error | null;
	/** agentInvoked from the prompt response frame, for isTerminal inference. */
	agentInvoked: boolean | undefined;
	wake: (() => void) | null;
	timer: ReturnType<typeof setTimeout> | undefined;
}

function isRpcResponse(value: Record<string, unknown>): value is RpcResponseFrame {
	return value.type === "response" && typeof value.command === "string" && typeof value.success === "boolean";
}

/** Extract the incremental text from a message_update event frame (omp's assistantMessageEvent.text_delta). */
function extractTextDelta(ev: Record<string, unknown>): string | null {
	const ame = isRecord(ev.assistantMessageEvent) ? ev.assistantMessageEvent : null;
	if (ame && ame.type === "text_delta" && typeof ame.delta === "string") return ame.delta;
	if (typeof ev.delta === "string") return ev.delta;
	return null;
}

export class OmpRpcClient {
	readonly #opts: OmpClientOpts;
	readonly #timeoutMs: number;

	#child: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#connected = false;
	#closed = false;
	#requestId = 0;
	#pending = new Map<string, PendingRequest>();
	#decoder = new RpcFrameDecoder();
	#protocolVersion: 1 | 2 = 1;
	#activePrompt: ActivePrompt | null = null;
	#stderr = "";
	#stderrSettled: Promise<void> = Promise.resolve();
	#exitCode: number | null = null;
	#abortController: AbortController | null = null;

	constructor(opts: OmpClientOpts) {
		this.#opts = opts;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
	}

	/** Negotiated RPC protocol version (2 after successful v2 negotiation, else 1). */
	get protocolVersion(): 1 | 2 {
		return this.#protocolVersion;
	}

	get pid(): number | null {
		return this.#child?.pid ?? null;
	}

	/** Last observed child exit code; non-null once the spawned process has been reaped. */
	get exitCode(): number | null {
		return this.#exitCode;
	}

	/** Captured stderr of the omp process (best-effort; used in error messages). */
	get stderrLog(): string {
		return this.#stderr;
	}

	/**
	 * Spawn `bun <cliPath> --mode rpc` (+ model/thinking/approval/extraArgs),
	 * wait for the ready frame (30s), and negotiate protocol v2 when the server
	 * advertises support (supportedProtocolVersions includes 2 and
	 * maxFrameBytes === 1 MiB). Falls back to v1 otherwise.
	 */
	async connect(): Promise<void> {
		if (this.#closed) throw new Error("OmpRpcClient is closed");
		if (this.#child) throw new Error("OmpRpcClient already connected");

		const args = ["--mode", "rpc"];
		if (this.#opts.model) args.push("--model", this.#opts.model);
		if (this.#opts.thinking) args.push("--thinking", this.#opts.thinking);
		if (this.#opts.approval) args.push("--approval-mode", this.#opts.approval);
		if (this.#opts.extraArgs && this.#opts.extraArgs.length > 0) args.push(...this.#opts.extraArgs);

		const child = Bun.spawn(["bun", this.#opts.cliPath, ...args], {
			cwd: this.#opts.cwd,
			env: { ...Bun.env, ...this.#opts.env },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#child = child;
		this.#decoder = new RpcFrameDecoder();
		this.#abortController = new AbortController();
		this.#stderr = "";
		this.#exitCode = null;
		this.#protocolVersion = 1;
		this.#connected = false;
		this.#stderrSettled = this.#drainStderr(child);

		void child.exited.then(
			code => {
				this.#exitCode = code;
			},
			() => {
				// Killed/never exited cleanly; exitCode stays null.
			},
		);

		try {
			const supportsV2 = await this.#waitForReady(child);
			this.#connected = true;
			if (supportsV2) {
				// Accept v2 chunks from this point on (the negotiate response itself may be chunked).
				this.#protocolVersion = 2;
				const resp = await this.#send({ type: "negotiate_protocol", protocolVersion: 2 }, NEGOTIATE_TIMEOUT_MS);
				if (
					!resp.success ||
					resp.command !== "negotiate_protocol" ||
					!isRecord(resp.data) ||
					resp.data.protocolVersion !== 2
				) {
					throw new Error("RPC protocol v2 negotiation failed");
				}
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			await this.#abortHard(err);
			throw err;
		}
	}

	/**
	 * Run one prompt; yields normalized AgentEvents until the terminal
	 * agent_end event. The prompt fails (throws) on timeout or process death.
	 */
	prompt(req: { message: string; images?: string[] }): AsyncIterable<AgentEvent> {
		this.#assertConnected();
		const id = `req_${++this.#requestId}`;
		const state: ActivePrompt = {
			id,
			queue: [],
			ended: false,
			error: null,
			agentInvoked: undefined,
			wake: null,
			timer: undefined,
		};
		this.#activePrompt = state;
		this.#writeFrame({ type: "prompt", id, message: req.message, ...(req.images && req.images.length > 0 ? { images: req.images } : {}) });
		state.timer = setTimeout(() => {
			// Record the timeout error synchronously so a concurrent reap (output
			// stream ended) cannot overwrite it; wake only after the tree is dead.
			const error = new Error(`omp prompt timed out after ${this.#timeoutMs}ms`);
			if (state.error === null) state.error = error;
			void this.#abortHard(error).then(() => this.#wake(state));
		}, this.#timeoutMs);
		return this.#promptIterable(state);
	}

	async steer(text: string): Promise<void> {
		await this.#send({ type: "steer", message: text });
	}

	async followUp(text: string): Promise<void> {
		await this.#send({ type: "follow_up", message: text });
	}

	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#send({ type: "set_model", provider, modelId });
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	async setHostTools(defs: HostToolDef[]): Promise<void> {
		const tools = defs.map(({ name, description, parameters }) => ({ name, description, parameters }));
		await this.#send({ type: "set_host_tools", tools });
	}

	/** Graceful close: SIGTERM, escalate to taskkill /T /F after CLOSE_GRACE_MS. Idempotent. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const child = this.#child;
		const error = new Error("omp client closed");
		if (this.#activePrompt) {
			const state = this.#activePrompt;
			state.error = error;
			this.#wake(state);
		}
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#connected = false;
		this.#abortController?.abort(error);
		if (child) {
			this.#child = null;
			try {
				child.kill(); // SIGTERM
			} catch {
				// process already dead
			}
			const exited = await Promise.race([
				child.exited.then(() => true, () => true),
				Bun.sleep(CLOSE_GRACE_MS).then(() => false),
			]);
			if (!exited) await this.#taskkill(child.pid);
		}
	}

	// ------------------------------------------------------------------ //
	//  Handshake                                                         //
	// ------------------------------------------------------------------ //

	#waitForReady(child: Subprocess<"pipe", "pipe", "pipe">): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			let readySeen = false;
			let settled = false;
			const fail = (message: () => string) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				void Promise.race([this.#stderrSettled, Bun.sleep(STDERR_GRACE_MS)]).then(
					() => reject(new Error(message())),
					() => reject(new Error(message())),
				);
			};
			const timer = setTimeout(() => {
				fail(() => `Timeout waiting for omp ready after ${READY_TIMEOUT_MS}ms. Stderr: ${this.#stderr || "(empty)"}`);
			}, READY_TIMEOUT_MS);

			void (async () => {
				try {
					for await (const line of this.#readJsonLines(child.stdout)) {
						let frame: unknown;
						try {
							frame = this.#decoder.push(line);
						} catch (error) {
							fail(() => `omp frame decode failed: ${error instanceof Error ? error.message : String(error)}. Stderr: ${this.#stderr || "(empty)"}`);
							return;
						}
						if (frame === undefined) continue;
						if (isRecord(frame) && frame.type === "ready") {
							readySeen = this.#supportsProtocolV2(frame);
							settled = true;
							clearTimeout(timer);
							resolve(readySeen);
							continue;
						}
						if (isRecord(frame) && frame.type === "rpc_chunk" && this.#protocolVersion !== 2) {
							fail(() => "omp sent rpc_chunk before protocol v2 negotiation");
							return;
						}
						this.#dispatchFrame(frame);
					}
					if (readySeen) {
						this.#reapAfterOutputEnd(child);
					} else {
						fail(() => `omp output stream ended before ready. Stderr: ${this.#stderr || "(empty)"}`);
					}
				} catch (error) {
					if (readySeen) {
						this.#reapAfterOutputEnd(child);
					} else {
						fail(() => `omp output reader failed: ${error instanceof Error ? error.message : String(error)}. Stderr: ${this.#stderr || "(empty)"}`);
					}
				}
			})();

			void child.exited.then(
				code => fail(() => `omp exited with code ${code} before ready. Stderr: ${this.#stderr || "(empty)"}`),
				() => fail(() => `omp exited before ready. Stderr: ${this.#stderr || "(empty)"}`),
			);
		});
	}

	#supportsProtocolV2(frame: Record<string, unknown>): boolean {
		return (
			Array.isArray(frame.supportedProtocolVersions) &&
			frame.supportedProtocolVersions.includes(2) &&
			frame.maxFrameBytes === MAX_RPC_FRAME_BYTES
		);
	}

	// ------------------------------------------------------------------ //
	//  Frame dispatch                                                    //
	// ------------------------------------------------------------------ //

	#dispatchFrame(frame: unknown): void {
		if (!isRecord(frame)) return;

		if (frame.type === "response" && isRpcResponse(frame)) {
			const id = frame.id;
			if (id !== undefined) {
				const pending = this.#pending.get(id);
				if (pending) {
					this.#pending.delete(id);
					if (frame.success) {
						pending.resolve(frame);
					} else {
						pending.reject(new Error(`omp ${frame.command} failed: ${frame.error ?? "unknown error"}. Stderr: ${this.#stderr || "(empty)"}`));
					}
					return;
				}
				// No pending request: a prompt's response arriving late (after
				// agent_end) or an unmatched id. Only a live prompt is relevant.
				if (this.#activePrompt && this.#activePrompt.id === id) {
					this.#handlePromptResponse(frame);
				}
			}
			return;
		}

		if (frame.type === "prompt_result" && typeof frame.id === "string") {
			// Real omp's terminal marker; safety net in case agent_end never streamed.
			const active = this.#activePrompt;
			if (active && active.id === frame.id && !active.ended) {
				active.agentInvoked = frame.agentInvoked === true;
				active.ended = true;
				this.#wake(active);
			}
			return;
		}

		const event = this.#normalizeEvent(frame);
		if (event) this.#pushEvent(event);
	}

	#handlePromptResponse(frame: RpcResponseFrame): void {
		const active = this.#activePrompt;
		if (!active) return;
		if (!frame.success) {
			active.error = new Error(`omp prompt failed: ${frame.error ?? "unknown error"}`);
			this.#wake(active);
			return;
		}
		if (isRecord(frame.data) && typeof frame.data.agentInvoked === "boolean") {
			active.agentInvoked = frame.data.agentInvoked;
		}
	}

	/** Normalize a raw event frame into our AgentEvent contract shape. */
	#normalizeEvent(frame: Record<string, unknown>): AgentEvent | null {
		const ev = frame.type === "event" && isRecord(frame.event) ? frame.event : frame;
		switch (ev.type) {
			case "message_update": {
				const text = extractTextDelta(ev);
				return text === null ? null : { kind: "text_delta", text };
			}
			case "text_delta": {
				const text = typeof ev.delta === "string" ? ev.delta : typeof ev.text === "string" ? ev.text : "";
				return { kind: "text_delta", text };
			}
			case "agent_end": {
				const isTerminal = typeof ev.isTerminal === "boolean" ? ev.isTerminal : (this.#activePrompt?.agentInvoked ?? true);
				const usage = ev.usage;
				return { kind: "agent_end", isTerminal, ...(usage !== undefined ? { usage } : {}) };
			}
			case "tool_execution_start":
				return { kind: "tool", name: String(ev.toolName ?? ""), args: ev.args };
			case "error":
				return { kind: "error", message: String(ev.message ?? ev.error ?? "omp reported an error") };
			default:
				return null;
		}
	}

	#pushEvent(event: AgentEvent): void {
		const active = this.#activePrompt;
		if (!active || active.ended) return;
		active.queue.push(event);
		if (event.kind === "agent_end") active.ended = true;
		this.#wake(active);
	}

	#wake(active: ActivePrompt): void {
		const wake = active.wake;
		active.wake = null;
		wake?.();
	}

	async *#promptIterable(state: ActivePrompt): AsyncGenerator<AgentEvent> {
		try {
			while (true) {
				if (state.queue.length > 0) {
					const event = state.queue.shift()!;
					yield event;
					if (event.kind === "agent_end") return;
					continue;
				}
				if (state.error) throw state.error;
				if (state.ended) return;
				// No await between the checks above and registering the wake, so a
				// dispatch in between cannot be lost.
				await new Promise<void>(resolve => {
					state.wake = resolve;
				});
			}
		} finally {
			if (this.#activePrompt === state) this.#activePrompt = null;
			if (state.timer !== undefined) clearTimeout(state.timer);
		}
	}

	// ------------------------------------------------------------------ //
	//  Transport                                                         //
	// ------------------------------------------------------------------ //

	#send(command: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<RpcResponseFrame> {
		this.#assertConnected();
		const id = `req_${++this.#requestId}`;
		const full = { ...command, id };
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponseFrame>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`Timeout waiting for ${String(command.type)} response after ${timeoutMs}ms. Stderr: ${this.#stderr || "(empty)"}`));
		}, timeoutMs);
		this.#pending.set(id, {
			resolve: frame => {
				clearTimeout(timer);
				resolve(frame);
			},
			reject: error => {
				clearTimeout(timer);
				reject(error);
			},
		});
		try {
			this.#writeFrame(full);
		} catch (error) {
			clearTimeout(timer);
			this.#pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	#writeFrame(frame: Record<string, unknown>): void {
		const child = this.#child;
		if (!child || !this.#connected) throw new Error("OmpRpcClient not connected");
		child.stdin.write(encodeFrame(frame));
		child.stdin.flush();
	}

	#assertConnected(): void {
		if (!this.#child || !this.#connected) throw new Error("OmpRpcClient not connected");
	}

	async *#readJsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
		const reader = stream.getReader();
		const decoder = new TextDecoder("utf-8");
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (line.length === 0) continue;
					yield JSON.parse(line);
				}
			}
			const tail = buffer.trim();
			if (tail.length > 0) yield JSON.parse(tail);
		} finally {
			reader.releaseLock();
		}
	}

	async #drainStderr(child: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const reader = child.stderr.getReader();
		const decoder = new TextDecoder("utf-8");
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.#stderr += decoder.decode(value, { stream: true });
				if (this.#stderr.length > 64 * 1024) this.#stderr = this.#stderr.slice(-64 * 1024);
			}
		} catch {
			// Stream teardown; captured stderr is best-effort.
		} finally {
			reader.releaseLock();
		}
	}

	// ------------------------------------------------------------------ //
	//  Failure handling / process reaping                                //
	// ------------------------------------------------------------------ //

	/** The stdout stream ended after a successful ready; fail all in-flight work. */
	#reapAfterOutputEnd(child: Subprocess<"pipe", "pipe", "pipe">): void {
		if (this.#closed) return;
		const error = new Error(`omp output stream ended unexpectedly. Stderr: ${this.#stderr || "(empty)"}`);
		if (this.#activePrompt) {
			const state = this.#activePrompt;
			if (state.error === null) state.error = error;
			this.#wake(state);
		}
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#connected = false;
		void this.#taskkill(child.pid);
	}

	/** Kill the whole process tree; settle after the child is reaped. */
	async #abortHard(error: Error): Promise<void> {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#connected = false;
		const child = this.#child;
		if (!child) return;
		this.#abortController?.abort(error);
		try {
			child.kill(); // SIGTERM first; taskkill below guarantees tree death on win32
		} catch {
			// process already dead
		}
		await Promise.race([child.exited.catch(() => {}), Bun.sleep(500)]);
		if (child.exitCode === null) await this.#taskkill(child.pid);
	}

	async #taskkill(pid: number): Promise<void> {
		if (process.platform === "win32") {
			try {
				const killer = Bun.spawn(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
				await killer.exited.catch(() => {});
			} catch {
				// process already gone
			}
		} else {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// process already gone
			}
		}
	}
}
