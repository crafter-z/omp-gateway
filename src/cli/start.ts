/**
 * `omp-gateway start`: run the daemon in the foreground, or detach with --daemon.
 */
import { Command } from "commander";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig, expandHome } from "../config/load.ts";
import type { GatewayConfig } from "../config/schema.ts";
import { Daemon } from "../daemon.ts";
import { removePidFile, writePidFile } from "./pid.ts";

export function dataDirOf(cfg: GatewayConfig): string {
	return resolve(expandHome(cfg.scheduler.ledger), "..");
}

/**
 * Resolve the bun binary that actually works for spawning the daemon.
 * process.execPath / Bun.which can return stale winget shim paths (which may
 * contain a `\.\` segment that existsSync accepts but spawn rejects); prefer
 * the current process's own executable, resolved to a clean absolute path.
 */
function resolveBunBinary(): string {
	const candidates: string[] = [];
	candidates.push(process.execPath);
	if (process.env.BUN) candidates.push(process.env.BUN);
	const bunInstall = process.env.BUN_INSTALL ?? join(homedir(), ".bun");
	candidates.push(join(bunInstall, "bin", "bun.exe"), join(bunInstall, "bin", "bun"));
	const which = Bun.which("bun");
	if (which) candidates.push(which);
	for (const c of candidates) {
		if (!c) continue;
		const normalized = resolve(c);
		if (existsSync(normalized)) return normalized;
	}
	throw new Error("cannot resolve a working bun binary for daemon spawn");
}

function spawnDaemon(cfg: GatewayConfig, configArg: string | undefined): void {
	const entry = resolve(import.meta.dir, "..", "index.ts");
	const bunBinary = resolveBunBinary();
	const args = ["start", "--foreground"];
	if (configArg) args.push("--config", configArg);
	const logPath = expandHome(cfg.log.file);
	// Bun.spawn 重定向的日志文件父目录必须存在，否则 ENOENT（报错还误导指向 cmd[0]）
	mkdirSync(dirname(logPath), { recursive: true });
	const logFile = Bun.file(logPath, { type: "text/plain" });
	const child = Bun.spawn({
		cmd: [bunBinary, entry, ...args],
		cwd: process.cwd(),
		stdout: logFile,
		stderr: logFile,
		stdin: "ignore",
		detached: true,
	});
	child.unref();
	writePidFile(dataDirOf(cfg), child.pid);
	console.log(`omp-gateway daemon started (pid ${child.pid}), log: ${expandHome(cfg.log.file)}`);
}

export function startCommand(): Command {
	return new Command("start")
		.description("start the gateway daemon (foreground; --daemon detaches)")
		.option("--daemon", "run detached in the background")
		.option("--foreground", "internal: run attached (used by --daemon spawn)", false)
		.option("--service", "internal: run as a Windows service (foreground semantics)", false)
		.option("--config <path>", "config file path")
		.action(async (opts) => {
			const cfg = loadConfig(opts.config);
			if (opts.daemon) {
				spawnDaemon(cfg, opts.config);
				return;
			}
			const daemon = new Daemon(cfg);
			await daemon.start();
			writePidFile(dataDirOf(cfg), process.pid);
			let shuttingDown = false;
			const shutdown = async (signal: string) => {
				if (shuttingDown) return;
				shuttingDown = true;
				console.log(`\nreceived ${signal}, stopping...`);
				removePidFile(dataDirOf(cfg));
				await daemon.stop();
				process.exit(0);
			};
			process.on("SIGINT", () => void shutdown("SIGINT"));
			process.on("SIGTERM", () => void shutdown("SIGTERM"));
			// keep alive until a signal arrives
			const { promise } = Promise.withResolvers<void>();
			await promise;
		});
}
