/**
 * `omp-gateway stop`: terminate the running daemon process tree.
 */
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { loadConfig } from "../config/load.ts";
import { isPidAlive, readPidFile, removePidFile } from "./pid.ts";
import { dataDirOf } from "./start.ts";

export function stopCommand(): Command {
	return new Command("stop")
		.description("stop the running daemon")
		.option("--config <path>", "config file path")
		.action((opts) => {
			const cfg = loadConfig(opts.config);
			const dir = dataDirOf(cfg);
			const info = readPidFile(dir);
			if (!info || !isPidAlive(info.pid)) {
				console.log("no running daemon");
				removePidFile(dir);
				return;
			}
			if (process.platform === "win32") {
				const r = spawnSync("taskkill", ["/T", "/F", "/PID", String(info.pid)], { stdio: "inherit" });
				if (r.status !== 0) {
					console.error(`taskkill failed (exit ${r.status})`);
					process.exitCode = 1;
				}
			} else {
				process.kill(info.pid, "SIGTERM");
			}
			removePidFile(dir);
			console.log(`stopped (pid ${info.pid})`);
		});
}
