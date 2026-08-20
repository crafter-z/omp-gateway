/**
 * `omp-gateway run-prompt`: dev command — run one prompt through the real omp
 * RPC path and print the result. Smoke-tests the M1 integration seam.
 */
import { Command } from "commander";
import { loadConfig } from "../config/load.ts";
import { createLogger } from "../util/logger.ts";
import { RpcRunner } from "../daemon.ts";

export function runPromptCommand(): Command {
	return new Command("run-prompt")
		.description("run a single prompt through omp (dev)")
		.argument("<prompt>", "the prompt text")
		.option("--config <path>", "config file path")
		.action(async (prompt: string, opts: { config?: string }) => {
			const cfg = loadConfig(opts.config);
			const runner = new RpcRunner(cfg, createLogger({ level: cfg.log.level }));
			const result = await runner.run(prompt, {});
			process.stdout.write(result.output + "\n");
			if (!result.ok) {
				process.stderr.write(`\n[error] ${result.error ?? "unknown"}\n`);
				process.exit(1);
			}
		});
}
