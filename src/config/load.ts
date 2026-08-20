/**
 * Config loading: YAML file -> secret expansion -> env override -> zod validation.
 * Fail-fast with friendly errors (field path).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { gatewayConfigSchema, type GatewayConfig } from "./schema.ts";
import { resolveSecretsDeep } from "./secret.ts";

export const DEFAULT_CONFIG_PATH = "~/.omp-gateway/config.yml";

/** Expand ~ to home dir. */
export function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
	return p;
}

/**
 * Apply OMP_GATEWAY_<PATH> env overrides onto a raw (unparsed) config object.
 * Path hierarchy is separated by DOUBLE underscore, UPPER_SNAKE per segment,
 * e.g. OMP_GATEWAY_QQ__APP_ID -> qq.app_id; OMP_GATEWAY_TIMEZONE -> timezone.
 * (Single underscore inside a segment is preserved; `__` disambiguates nesting.)
 * Leaf values are parsed as JSON when possible, else kept as strings.
 */
export function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
	const prefix = "OMP_GATEWAY_";
	for (const [envKey, envVal] of Object.entries(process.env)) {
		if (!envKey.startsWith(prefix)) continue;
		const path = envKey
			.slice(prefix.length)
			.toLowerCase()
			.split("__")
			.filter((s) => s.length > 0);
		if (path.length === 0) continue;
		let node: Record<string, unknown> = raw;
		for (let i = 0; i < path.length - 1; i++) {
			const seg = path[i]!;
			if (typeof node[seg] !== "object" || node[seg] === null) node[seg] = {};
			node = node[seg] as Record<string, unknown>;
		}
		const leaf = path[path.length - 1]!;
		let value: unknown = envVal;
		try {
			value = JSON.parse(envVal!);
		} catch {
			// keep string
		}
		node[leaf] = value;
	}
	return raw;
}

/** Load and validate the gateway config. Throws ConfigError on any failure. */
export function loadConfig(pathArg?: string): GatewayConfig {
	const path = expandHome(pathArg ?? process.env.OMP_GATEWAY_CONFIG ?? DEFAULT_CONFIG_PATH);
	let raw: unknown;
	try {
		const text = readFileSync(path, "utf8");
		raw = parseYaml(text);
	} catch (err) {
		throw new ConfigError(`cannot read config file ${path}: ${(err as Error).message}`);
	}
	if (raw === null || raw === undefined) raw = {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new ConfigError(`config file ${path} must contain a YAML mapping`);
	}
	const withEnv = applyEnvOverrides(raw as Record<string, unknown>);
	const withSecrets = resolveSecretsDeep(withEnv);
	const parsed = gatewayConfigSchema.safeParse(withSecrets);
	if (!parsed.success) {
		throw new ConfigError(formatZodError(parsed.error));
	}
	// Normalize ~ in file paths after validation.
	const cfg = parsed.data;
	cfg.log.file = expandHome(cfg.log.file);
	cfg.scheduler.ledger = expandHome(cfg.scheduler.ledger);
	if (cfg.omp.session_dir) cfg.omp.session_dir = expandHome(cfg.omp.session_dir);
	return cfg;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

function formatZodError(err: z.ZodError): string {
	const lines = err.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
		return `  ${path}: ${issue.message}`;
	});
	return `invalid config:\n${lines.join("\n")}`;
}
