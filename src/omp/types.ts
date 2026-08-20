/**
 * Public types for the omp driver module (contract: docs/02-contracts.md §5,
 * type draft: docs/05-implementation-plan.md §4).
 *
 * No cross-module imports: the daemon wiring maps these to other modules'
 * local interfaces.
 */

/**
 * A normalized, daemon-facing event emitted while an omp agent turn runs.
 * Produced by OmpRpcClient from raw RPC frames (message_update → text_delta,
 * agent_end → agent_end, tool_execution_start → tool, error → error).
 */
export type AgentEvent =
	| { kind: "text_delta"; text: string }
	| { kind: "agent_end"; isTerminal: boolean; usage?: unknown }
	| { kind: "tool"; name: string; args: unknown }
	| { kind: "error"; message: string };

/**
 * Minimal host tool definition registered with omp via `set_host_tools`.
 * `execute` is host-side only and never serialized to the wire.
 */
export interface HostToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute?(...args: unknown[]): unknown;
}

/** Options for constructing an OmpRpcClient. */
export interface OmpClientOpts {
	/** Path to the omp CLI entry point (absolute path recommended; the process is spawned as `bun <cliPath> --mode rpc`). */
	cliPath: string;
	/** Working directory for the spawned omp process. */
	cwd?: string;
	/** Default model, passed as `--model <model>` at spawn. */
	model?: string;
	/** Thinking level (off|minimal|low|medium|high|xhigh|max|auto), passed as `--thinking <level>`. */
	thinking?: string;
	/** Approval mode (always-ask|write|yolo), passed as `--approval-mode <mode>`. */
	approval?: string;
	/** Extra CLI arguments appended after `--mode rpc` (e.g. session args from session.ts). */
	extraArgs?: string[];
	/** Per-prompt timeout in ms; on expiry the process tree is killed (`taskkill /T /F`). Default 300_000. */
	timeoutMs?: number;
	/** Extra environment variables merged over the parent environment (e.g. FAKE_OMP_MODE for fixtures). */
	env?: Record<string, string>;
}
