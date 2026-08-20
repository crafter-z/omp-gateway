/**
 * `omp-gateway service`: Windows service management (P8).
 * Uses sc.exe to register the compiled daemon binary as a service.
 */
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../config/load.ts";

const SERVICE_NAME = "omp-gateway";

function binaryPath(): string {
	// dist/omp-gateway.exe (bun build --compile output) next to this source tree
	const exe = resolve(import.meta.dir, "..", "..", "dist", "omp-gateway.exe");
	return exe;
}

function run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
	const r = spawnSync(cmd, args, { encoding: "utf8" });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function serviceCommand(): Command {
	const service = new Command("service").description("Windows service management (sc.exe)");

	service
		.command("install")
		.description("install omp-gateway as a Windows service")
		.option("--config <path>", "config file path (passed to the service)")
		.action((opts) => {
			if (process.platform !== "win32") {
				console.error("service install is Windows-only");
				process.exitCode = 1;
				return;
			}
			const exe = binaryPath();
			const cfg = loadConfig(opts.config);
			const configArg = opts.config ? ` --config "${opts.config}"` : "";
			// sc create omp-gateway binPath= "\"<exe>\" start --foreground --service" start= auto
			const binPath = `"${exe}" start --foreground --service${configArg}`;
			const r = run("sc", ["create", SERVICE_NAME, "start=", "auto", "binPath=", binPath]);
			if (r.status !== 0) {
				// 已存在 → 尝试更新
				if (r.stdout.includes("already exists") || r.stderr.includes("already exists")) {
					const u = run("sc", ["config", SERVICE_NAME, "binPath=", binPath]);
					console.log(u.status === 0 ? `service ${SERVICE_NAME} updated` : `update failed: ${u.stderr}`);
					return;
				}
				console.error(`install failed: ${r.stderr || r.stdout}`);
				process.exitCode = 1;
				return;
			}
			console.log(`service ${SERVICE_NAME} installed (binPath=${binPath})`);
			console.log(`start with: sc start ${SERVICE_NAME}`);
		});

	service.command("uninstall").description("remove the Windows service").action(() => {
		const r = run("sc", ["delete", SERVICE_NAME]);
		console.log(r.status === 0 ? `service ${SERVICE_NAME} removed` : `uninstall: ${r.stderr || r.stdout}`);
	});

	service.command("status").description("show service status").action(() => {
		const r = run("sc", ["query", SERVICE_NAME]);
		if (r.status !== 0) {
			console.log(`service ${SERVICE_NAME}: not installed`);
			return;
		}
		const state = /STATE\s*:\s*(\d+)/.exec(r.stdout)?.[1];
		const names: Record<string, string> = { "1": "STOPPED", "2": "START_PENDING", "3": "STOP_PENDING", "4": "RUNNING" };
		console.log(`service ${SERVICE_NAME}: ${names[state ?? ""] ?? r.stdout.trim()}`);
	});

	return service;
}
