/**
 * PID file management for `omp-gateway start|stop|status`.
 * Windows: process.kill(pid, 0) probes existence without terminating.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome } from "../config/load.ts";

export interface PidInfo {
	pid: number;
	startedAt: string;
}

export function pidFilePath(dataDir: string): string {
	return `${expandHome(dataDir)}/gateway.pid`;
}

export function writePidFile(dataDir: string, pid: number): void {
	const path = pidFilePath(dataDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
}

export function readPidFile(dataDir: string): PidInfo | null {
	try {
		const parsed = JSON.parse(readFileSync(pidFilePath(dataDir), "utf8")) as PidInfo;
		if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function removePidFile(dataDir: string): void {
	try {
		rmSync(pidFilePath(dataDir), { force: true });
	} catch {
		// ignore
	}
}

/** Probe whether a pid is alive (does not signal the process). */
export function isPidAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		// ESRCH: no such process; EPERM: exists but owned by another user.
		return e.code === "EPERM";
	}
}
