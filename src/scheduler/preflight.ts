/**
 * job 创建前预检（docs/02-contracts.md §6.4）：模型可解析 / script 存在 / workdir 存在 /
 * delivery 目标合法且可写 / schedule 表达式可解析（cron 用 croner 校验）。
 * 只做本地文件系统与语法校验——不烧 token、不碰网络。
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Cron } from "croner";
import type { JobInput } from "./types.ts";

const DELIVERY_TARGETS = ["file", "qq", "origin"] as const;

/** interval 表达式格式（对齐 scheduler.intervalToCron）：正数 + s/m/h/d */
const INTERVAL_RE = /^[1-9]\d*[smhd]$/i;

/** 脚本扩展名（对齐 executor.isScriptPath 的主集） */
const SCRIPT_EXT_RE = /\.(ts|mts|cts|js|mjs|cjs|tsx|jsx|sh|bat|cmd|ps1|py)$/i;

/**
 * 返回错误列表（空数组 = 通过）。每条错误独立可读，调用方打印后拒绝写入。
 */
export function preflightJob(job: JobInput): string[] {
  const errors: string[] = [];

  // --- action ---
  if (job.action.type === "agent") {
    if (!job.action.prompt || job.action.prompt.trim() === "") {
      errors.push("agent job requires a non-empty prompt");
    }
  } else {
    const script = job.action.script;
    if (!script || script.trim() === "") {
      errors.push("no-agent job requires a script");
    } else if (looksLikePath(script)) {
      const base = job.workdir ?? process.cwd();
      const p = resolve(base, script);
      if (!existsSync(p)) errors.push(`script file not found: ${script}`);
    }
  }

  // --- workdir ---
  if (job.workdir !== undefined && job.workdir.trim() !== "") {
    if (!existsSync(job.workdir)) {
      errors.push(`workdir not found: ${job.workdir}`);
    }
  }

  // --- ttl_s ---
  if (job.ttl_s !== undefined) {
    if (!Number.isFinite(job.ttl_s) || job.ttl_s <= 0) {
      errors.push(`ttl_s must be a positive number, got ${job.ttl_s}`);
    }
  }

  // --- delivery ---
  const d = job.delivery;
  if (!DELIVERY_TARGETS.includes(d.target)) {
    errors.push(`invalid delivery target: ${d.target} (expected file|qq|origin)`);
  } else if (d.target === "file") {
    if (!d.file || d.file.trim() === "") {
      errors.push("delivery target=file requires a file path (--file)");
    } else {
      const parent = dirname(resolve(d.file));
      if (!existsSync(parent)) {
        try {
          mkdirSync(parent, { recursive: true });
        } catch (e) {
          errors.push(`delivery file parent directory not creatable: ${parent} (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }
  }

  // --- schedule ---
  const s = job.schedule;
  if (!s) {
    errors.push("schedule is required");
  } else if (s.kind === "cron") {
    const fields = s.expr.trim().split(/\s+/);
    if (fields.length !== 6) {
      errors.push(`invalid cron expression: "${s.expr}" (expected 6 fields: sec min hour dom month dow)`);
    } else {
      try {
        new Cron(s.expr);
      } catch {
        errors.push(`invalid cron expression: "${s.expr}"`);
      }
    }
  } else if (s.kind === "interval") {
    if (!INTERVAL_RE.test(s.expr.trim())) {
      errors.push(`invalid interval expression: "${s.expr}" (expected e.g. 30s, 5m, 2h, 1d)`);
    }
  } else if (s.kind === "once") {
    const target = onceTarget(s.expr);
    if (!target) {
      errors.push(`invalid once expression: "${s.expr}" (expected "+30m" or ISO timestamp)`);
    } else if (target.getTime() <= Date.now()) {
      errors.push(`once schedule already expired: "${s.expr}"`);
    }
  } else {
    errors.push(`unknown schedule kind: ${String((s as { kind?: unknown }).kind)}`);
  }

  return errors;
}

/**
 * 脚本内容 or 路径启发式：明显带代码特征（括号/引号/分号等）视为内联内容；
 * 其余含路径指示（绝对路径、./ ~/ 前缀、目录分隔符、脚本扩展名）视为文件路径。
 */
function looksLikePath(script: string): boolean {
  const t = script.trim();
  if (t.length === 0) return false;
  if (/[\s()[\]"'=;{}]/.test(t)) return false; // 明显代码特征 → 内联内容
  if (isAbsolute(t)) return true;
  if (/^[.~]/.test(t)) return true;
  if (/[\\/]/.test(t)) return true;
  return SCRIPT_EXT_RE.test(t);
}

/** once 表达式 → 目标 Date（对齐 scheduler.onceDate）；非法 → null */
function onceTarget(expr: string): Date | null {
  const t = expr.trim();
  if (t.startsWith("+")) {
    const rel = /^\+(\d+)(s|m|h|d)$/i.exec(t);
    if (!rel) return null;
    const n = parseInt(rel[1], 10);
    if (n <= 0) return null;
    const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return new Date(Date.now() + n * unitMs[rel[2].toLowerCase()]);
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}
