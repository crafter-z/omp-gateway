/**
 * Session-related CLI argument construction for spawning `omp --mode rpc`.
 *
 * Flag reference (verified against the installed omp CLI source at
 * `C:/Users/craft/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/`):
 * - `--no-session` — cli/args.ts parses it to `noSession` ("Don't save session
 *   (ephemeral)", commands/launch-help.ts).
 * - `-r` / `--resume <value>` — OPTIONAL_FLAGS in cli/flag-tables.ts maps both
 *   (plus `--session`) to `resume`; launch-help documents `-r` as "Resume a
 *   session (by ID prefix, path, or picker if omitted)".
 */

export interface BuildArgsOptions {
	/** Ephemeral session (cron jobs): emit `--no-session`. Takes precedence over `sessionPath`. */
	noSession?: boolean;
	/** Resume an existing session file: emit `-r <sessionPath>`. */
	sessionPath?: string;
	/** Additional flags appended after the session flags. */
	extra?: string[];
}

/**
 * Build the session-related argument vector.
 *
 * Invariant: `--no-session` and `-r <path>` are mutually exclusive on the wire
 * (omp parses the last one; ambiguity is avoided by never emitting both).
 * `noSession` wins over `sessionPath`.
 */
export function buildArgs(opts: BuildArgsOptions = {}): string[] {
	const args: string[] = [];
	if (opts.noSession) {
		args.push("--no-session");
	} else if (opts.sessionPath) {
		args.push("-r", opts.sessionPath);
	}
	if (opts.extra && opts.extra.length > 0) args.push(...opts.extra);
	return args;
}
