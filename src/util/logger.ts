/**
 * Lightweight structured logger: level filtering + stdout/stderr + optional
 * append-only file sink.
 *
 * Invariants:
 * - Line format: `[ISO-UTC] [level] [prefix] message {"json fields"}`.
 * - A line is emitted only when its level ranks >= the configured level.
 * - File writes are synchronous (`appendFileSync`), so once a call returns the
 *   line is durable; safe on Windows (append mode, auto-created parent dirs).
 * - File-write failures never crash the caller: they degrade to a stderr note.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Derive a child logger whose lines carry a `[prefix]` tag. */
  child(prefix: string): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Optional append-only log file; parent directories are created on demand. */
  file?: string;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(opts: LoggerOptions): Logger {
  return makeLogger(opts.level, opts.file, undefined);
}

function makeLogger(level: LogLevel, file: string | undefined, prefix: string | undefined): Logger {
  const minRank = LEVEL_RANK[level];

  const emit = (msgLevel: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[msgLevel] < minRank) return; // level filtering
    const line = formatLine(msgLevel, msg, fields, prefix);
    if (file !== undefined) appendToFile(file, line);
    // debug/info/warn → stdout; errors → stderr
    const stream = msgLevel === "error" ? process.stderr : process.stdout;
    stream.write(line + "\n");
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (childPrefix) =>
      makeLogger(level, file, prefix === undefined ? childPrefix : `${prefix}.${childPrefix}`),
  };
}

function formatLine(
  msgLevel: LogLevel,
  msg: string,
  fields: Record<string, unknown> | undefined,
  prefix: string | undefined,
): string {
  const parts = [`[${new Date().toISOString()}]`, `[${msgLevel}]`];
  if (prefix !== undefined) parts.push(`[${prefix}]`);
  parts.push(msg);
  if (fields !== undefined) parts.push(JSON.stringify(fields));
  return parts.join(" ");
}

function appendToFile(file: string, line: string): void {
  try {
    appendFileSync(file, line + "\n", "utf8");
  } catch (err) {
    const isEnoent =
      err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT";
    if (isEnoent) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, line + "\n", "utf8");
        return;
      } catch {
        // fall through to diagnostic
      }
    }
    process.stderr.write(`[logger] failed to write ${file}: ${String(err)}\n`);
  }
}
