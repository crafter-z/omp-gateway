#!/usr/bin/env bun
import { Command } from "commander";
import { startCommand } from "./cli/start.ts";
import { stopCommand } from "./cli/stop.ts";
import { statusCommand } from "./cli/status.ts";
import { jobsCommand } from "./cli/jobs.ts";
import { runPromptCommand } from "./cli/run-prompt.ts";

const program = new Command();
program
	.name("omp-gateway")
	.description("Resident gateway daemon for omp: cron scheduler + QQ Bot API v2 gateway")
	.version("0.1.0");

program.addCommand(startCommand());
program.addCommand(stopCommand());
program.addCommand(statusCommand());
program.addCommand(jobsCommand());
program.addCommand(runPromptCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`omp-gateway: ${message}`);
	process.exit(1);
});
