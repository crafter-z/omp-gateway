/**
 * `omp-gateway jobs`: CRUD scheduled jobs against the daemon's ledger store.
 * Mutations write to the same sqlite db the daemon uses; the daemon picks up
 * changes on its next tick for enabled/disabled flags, and `run` executes
 * immediately through the daemon path only when the daemon is running.
 * (Hot sync via the admin API is P7; until then, restart or `run` after add.)
 */
import { Command } from "commander";
import { loadConfig } from "../config/load.ts";
import { JobStore } from "../scheduler/store.ts";
import type { JobSchedule } from "../scheduler/types.ts";

function openStore(configArg: string | undefined): JobStore {
	const cfg = loadConfig(configArg);
	return new JobStore(cfg.scheduler.ledger);
}

function scheduleFromOpts(opts: { every?: string; cron?: string; at?: string }): JobSchedule {
	const present = [opts.every, opts.cron, opts.at].filter((v) => v !== undefined);
	if (present.length !== 1) {
		throw new Error("exactly one of --every / --cron / --at is required");
	}
	if (opts.every !== undefined) return { kind: "interval", expr: opts.every };
	if (opts.cron !== undefined) return { kind: "cron", expr: opts.cron };
	return { kind: "once", expr: opts.at! };
}

export function jobsCommand(): Command {
	const jobs = new Command("jobs").description("manage scheduled jobs");

	jobs
		.command("list")
		.description("list jobs")
		.option("--config <path>", "config file path")
		.action((opts) => {
			const store = openStore(opts.config);
			try {
				const rows = store.list();
				if (rows.length === 0) {
					console.log("no jobs");
					return;
				}
				for (const j of rows) {
					const flag = j.enabled ? "" : "[disabled] ";
					console.log(
						`${flag}${j.name}\t${j.schedule.kind}:${j.schedule.expr}\tnext=${j.next_run ?? "-"}\tlast=${j.last_run ?? "-"}\truns=${j.run_count}\tfail=${j.fail_streak}`,
					);
				}
			} finally {
				store.close();
			}
		});

	jobs
		.command("add")
		.description("add a job (--every/--cron/--at exactly one; --prompt or --script)")
		.requiredOption("--name <name>", "unique job name")
		.option("--every <interval>", 'interval schedule, e.g. "5m"')
		.option("--cron <expr>", "cron schedule (6 fields, seconds first)")
		.option("--at <expr>", 'one-shot: "+30m" or ISO timestamp')
		.option("--prompt <text>", "agent prompt")
		.option("--script <path>", "no-agent script file path")
		.option("--model <model>", "per-job model pin")
		.option("--target <file|qq|origin>", "delivery target", "qq")
		.option("--file <path>", "output file for target=file")
		.option("--qq-chat <chatKey>", "explicit qq target (default: home channel)")
		.option("--silent", "suppress delivery")
		.option("--workdir <dir>", "execution working directory")
		.option("--max-runs <n>", "max executions", (v) => Number(v))
		.option("--ttl <seconds>", "per-run timeout", (v) => Number(v))
		.option("--no-wake-agent", "no-agent: only wake agent on non-empty output")
		.option("--config <path>", "config file path")
		.action((opts) => {
			if (!opts.prompt && !opts.script) {
				throw new Error("--prompt or --script is required");
			}
			const schedule = scheduleFromOpts(opts);
			const action =
				opts.prompt !== undefined
					? {
							type: "agent" as const,
							prompt: opts.prompt,
							model: opts.model,
						}
					: {
							type: "no-agent" as const,
							script: opts.script,
							// 显式 --no-wake-agent → 预检门；否则纯脚本（无 prompt 无可唤醒）
							wake_agent: opts.wakeAgent === false ? false : undefined,
						};
			const store = openStore(opts.config);
			try {
				const job = store.add({
					name: opts.name,
					enabled: true,
					schedule,
					action,
					delivery: {
						target: opts.target,
						file: opts.file,
						qq_chat: opts.qqChat,
						silent: opts.silent ?? false,
					},
					workdir: opts.workdir,
					max_runs: opts.maxRuns,
					ttl_s: opts.ttl,
				});
				console.log(`added job ${job.id} (${job.name}) — restart daemon or use 'jobs run' to execute`);
			} finally {
				store.close();
			}
		});

	for (const [name, desc, fn] of [
		["rm", "remove a job", (store: JobStore, id: string) => store.remove(id)],
		["pause", "disable a job", (store: JobStore, id: string) => store.pause(id)],
		["resume", "enable a job", (store: JobStore, id: string) => store.resume(id)],
	] as const) {
		jobs
			.command(name)
			.description(desc)
			.argument("<name>", "job name")
			.option("--config <path>", "config file path")
			.action((name: string, opts: { config?: string }) => {
				const store = openStore(opts.config);
				try {
					const job = store.getByName(name);
					if (!job) throw new Error(`job not found: ${name}`);
					fn(store, job.id);
					console.log(`${name} ${name}`);
				} finally {
					store.close();
				}
			});
	}

	return jobs;
}
