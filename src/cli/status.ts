/**
 * `omp-gateway status`: report daemon process state + config summary.
 */
import { Command } from "commander";
import { loadConfig } from "../config/load.ts";
import { isPidAlive, readPidFile } from "./pid.ts";
import { dataDirOf } from "./start.ts";

export function statusCommand(): Command {
	return new Command("status")
		.description("show daemon status")
		.option("--config <path>", "config file path")
		.action((opts) => {
			const cfg = loadConfig(opts.config);
			const info = readPidFile(dataDirOf(cfg));
			const alive = info !== null && isPidAlive(info.pid);
			console.log(`daemon: ${alive ? `running (pid ${info!.pid}, since ${info!.startedAt})` : "stopped"}`);
			const configPath = opts.config ?? process.env.OMP_GATEWAY_CONFIG ?? "~/.omp-gateway/config.yml";
			console.log(`config: ${configPath}`);
			console.log(`qq: ${cfg.qq.app_id ? `configured (app ${cfg.qq.app_id})` : "MISSING app_id"}`);
			console.log(
				`scheduler: ${cfg.scheduler.enabled ? `enabled (tick ${cfg.scheduler.tick_s}s, ledger ${cfg.scheduler.ledger})` : "disabled"}`,
			);
			console.log(
				`delivery: default=${cfg.delivery.default_target}, home_channel=${cfg.delivery.home_channel || "(unset)"}`,
			);
		});
}
