/**
 * job 创建前预检（docs/02-contracts.md §6.4）：模型可解析 / script 存在 / workdir 存在 /
 * delivery 目标合法且可写 / schedule 表达式可解析（cron 用 croner 校验；interval/once
 * 复用 scheduler/expr.ts 的共享实现，保证"预检通过 ⇒ 注册必成功"）。
 * 只做本地文件系统与语法校验——不烧 token、不碰网络。
 *
 * 额外防线（hermes lifecycle_guard 对等）：拒绝 prompt/script 中包含网关生命周期
 * 命令（重启/停止/kill 本 daemon）的 job，并递归扫描引用的 shell/python 脚本。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Cron } from "croner";
import type { JobInput } from "./types.ts";
import { intervalToCron, onceDate } from "./expr.ts";

/** 合法 target 原语（多目标逗号列表与 chatKey 直发由 delivery 解析） */
const TARGET_PRIMITIVES = ["file", "qq", "origin", "all"] as const;
const CHAT_KEY_RE = /^(c2c|group|guild):[A-Za-z0-9_-]+$/;

/** 脚本扩展名（对齐 executor.isScriptPath 的主集） */
const SCRIPT_EXT_RE = /\.(ts|mts|cts|js|mjs|cjs|tsx|jsx|sh|bat|cmd|ps1|py)$/i;

// ---------------------------------------------------------------------------
// Lifecycle guard (hermes cron/lifecycle_guard.py)
// ---------------------------------------------------------------------------

/** 网关进程名变体（含 omp-gateway 与常见包名） */
const GATEWAY_NAMES = [
  "omp-gateway",
  "omp_gateway",
  "gateway",
];

/** 危险的终止/重启命令形态（大小写不敏感） */
const KILL_PATTERNS: RegExp[] = [
  /\b(pkill|killall|taskkill|kill)\b[^\n]*(omp-gateway|omp_gateway)/i,
  /\b(taskkill)\b[^\n]*\/PID/i,
  /\b(pkill|killall)\b[^\n]*-f?[^\n]*(gateway|hermes)/i,
  /\b(reboot|shutdown)\b/i,
];

/** 服务控制命令（计划任务/NSSM/systemd/launchctl）作用于网关自身 */
const SERVICE_PATTERNS: RegExp[] = [
  /\b(sc|schtasks|nssm|systemctl|service|launchctl)\b[^\n]*(stop|delete|remove|kill|disable)\b[^\n]*(omp-gateway|omp_gateway|gateway)/i,
  /\b(launchctl)\b[^\n]*(submit|remove|kickstart)/i,
];

/** 引用脚本递归扫描上限 */
const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_BYTES = 32 * 1024;

/** 扫描单个文本块是否含生命周期威胁；返回命中描述（无命中 → null） */
export function scanLifecycleThreat(text: string): string | null {
  const s = text.replace(/\r\n/g, "\n");
  for (const re of KILL_PATTERNS) {
    if (re.test(s)) return `lifecycle command pattern: ${re.source}`;
  }
  for (const re of SERVICE_PATTERNS) {
    if (re.test(s)) return `gateway service control pattern: ${re.source}`;
  }
  // 直接引用网关启动/停止子命令（omp-gateway start/stop/restart）
  if (new RegExp(`\\bomp-gateway\\b[^\\n]*(start|stop|restart)\\b`, "i").test(s)) {
    return "omp-gateway start/stop/restart in job text";
  }
  return null;
}

/**
 * 递归扫描引用的脚本文件（行内脚本直接扫内容）。路径判定复用 looksLikePath；
 * 文件按扩展名分派到 shell/python 主集，深度/大小有界。
 */
function scanScriptFiles(
  script: string,
  base: string,
  depth: number,
  seen: Set<string>,
): string[] {
  const out: string[] = [];
  if (depth > MAX_SCAN_DEPTH) return out;
  const threat = scanLifecycleThreat(script);
  if (threat) out.push(threat);
  if (!looksLikePath(script)) return out;

  const p = resolve(base, script);
  if (seen.has(p)) return out;
  seen.add(p);
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) return out;
    const content = readFileSync(p, "utf8");
    const t = scanLifecycleThreat(content);
    if (t) out.push(`${t} (in ${p})`);
    // 递归扫描脚本内引用的其他脚本路径（引号/空白分隔的候选路径）
    for (const ref of content.matchAll(/(?:^|\s)([^\s"'`]+\.(?:sh|bat|cmd|ps1|py))\s*$/gm)) {
      out.push(...scanScriptFiles(ref[1]!, dirname(p), depth + 1, seen));
    }
  } catch {
    // 读取失败不算威胁
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

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
    if (job.action.context_from && job.action.context_from.length > 0) {
      for (const name of job.action.context_from) {
        if (!name || name.trim() === "" || name === job.name) {
          errors.push(`context_from contains an invalid or self-referential job name: ${name}`);
        }
      }
    }
    const threat = scanLifecycleThreat(job.action.prompt ?? "");
    if (threat) errors.push(`agent prompt rejected: ${threat}`);
  } else {
    const script = job.action.script;
    if (!script || script.trim() === "") {
      errors.push("no-agent job requires a script");
    } else if (looksLikePath(script)) {
      const base = job.workdir ?? process.cwd();
      const p = resolve(base, script);
      if (!existsSync(p)) {
        errors.push(`script file not found: ${script}`);
      } else {
        const seen = new Set<string>();
        errors.push(...scanScriptFiles(script, base, 0, seen).map((t) => `script rejected: ${t}`));
      }
    } else {
      const threat = scanLifecycleThreat(script);
      if (threat) errors.push(`script rejected: ${threat}`);
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
  const targetParts = String(d.target ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (targetParts.length === 0) {
    errors.push("delivery target is required (file|qq|origin|all|chatKey[, …])");
  }
  for (const part of targetParts) {
    if ((TARGET_PRIMITIVES as readonly string[]).includes(part.toLowerCase())) continue;
    if (CHAT_KEY_RE.test(part)) continue;
    errors.push(`invalid delivery target: ${part} (expected file|qq|origin|all|chatKey)`);
  }
  if (targetParts.includes("file")) {
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
    try {
      intervalToCron(s.expr);
    } catch (e) {
      errors.push(`invalid interval expression: "${s.expr}" (${e instanceof Error ? e.message : e})`);
    }
  } else if (s.kind === "once") {
    const target = onceDate(s.expr);
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
