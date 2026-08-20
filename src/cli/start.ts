/**
 * `omp-gateway start`: run the daemon in the foreground, or detach with --daemon.
 */
import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig, expandHome } from "../config/load.ts";
import type { GatewayConfig } from "../config/schema.ts";
import { Daemon } from "../daemon.ts";
import { removePidFile, writePidFile } from "./pid.ts";

export function dataDirOf(cfg: GatewayConfig): string {
	return resolve(expandHome(cfg.scheduler.ledger), "..");
}

function spawnDaemon(cfg: GatewayConfig, configArg: string | undefined): void {
	const entry = resolve(import.meta.dir, "..", "index.ts");
	const args = ["start", "--foreground"];
	if (configArg) args.push("--config", configArg);
	const logFile = Bun.file(expandHome(cfg.log.file), { type: "text/plain" });
	const child = Bun.spawn({
		cmd: [process.execPath, entry, ...args],
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
