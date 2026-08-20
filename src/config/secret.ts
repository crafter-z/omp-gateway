/**
 * Secret resolution (contract 02 §1.1): ${VAR}, ${VAR:-default}, !command.
 * Command execution: 10s timeout, result cached for process lifetime.
 */
import { spawnSync } from "node:child_process";

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;
const CMD_PATTERN = /^!(.+)$/;

const commandCache = new Map<string, string>();

function runCommand(cmd: string): string {
	const cached = commandCache.get(cmd);
	if (cached !== undefined) return cached;
	let result: string;
	try {
		const r = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 10_000 });
		if (r.error) throw r.error;
		if (r.status !== 0) throw new Error(`command exited ${r.status}: ${r.stderr?.trim()}`);
		result = (r.stdout ?? "").trim();
	} catch (err) {
		throw new Error(`secret resolution failed for command "${cmd}": ${(err as Error).message}`);
	}
	commandCache.set(cmd, result);
	return result;
}

/** Resolve env-var and command references in a string value. */
export function resolveSecret(value: string): string {
	if (CMD_PATTERN.test(value)) {
		return runCommand(value.slice(1).trim());
	}
	return value.replace(VAR_PATTERN, (whole, name: string, _sep: string | undefined, fallback: string | undefined) => {
		const env = process.env[name];
		if (env !== undefined) return env;
		if (fallback !== undefined) return fallback;
		return whole; // leave unresolved; zod/startup validation will surface it
	});
}

/** Deep-resolve every string leaf in a parsed config tree. */
export function resolveSecretsDeep<T>(value: T): T {
	if (typeof value === "string") return resolveSecret(value) as T;
	if (Array.isArray(value)) return value.map((v) => resolveSecretsDeep(v)) as T;
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = resolveSecretsDeep(v);
		return out as T;
	}
	return value;
}
