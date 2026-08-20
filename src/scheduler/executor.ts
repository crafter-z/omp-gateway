/**
 * 任务执行器：分派 agent（AgentRunner 抽象，真实实现由 daemon 用 OmpRpcClient 适配）与
 * no-agent（Bun.spawn 执行脚本，支持 wake_agent 预检门）。ttl_s 超时 → { ok:false, error:"timeout" }。
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, Job, RunResult } from "./types.ts";

export interface Executor {
  execute(job: Job, scheduledAt: Date): Promise<RunResult>;
}

export interface ExecutorDeps {
  /** agent 执行器（M1 测试用 fake；真实实现由 daemon 注入） */
  runner: AgentRunner;
}

/** 超时内部信号，转为 { ok:false, error:"timeout" } */
class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

export class DefaultExecutor implements Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(job: Job, _scheduledAt: Date): Promise<RunResult> {
    const ttlMs = job.ttl_s !== undefined ? job.ttl_s * 1000 : undefined;
    try {
      if (job.action.type === "agent") {
        return await this.runAgent(job, ttlMs);
      }
      return await this.runScript(job, ttlMs);
    } catch (e) {
      if (e instanceof TimeoutError) return { ok: false, output: "", error: "timeout" };
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async runAgent(job: Job, ttlMs: number | undefined): Promise<RunResult> {
    const modelError = invalidModelError(job.action.model);
    if (modelError) return { ok: false, output: "", error: modelError };
    return raceTimeout(
      this.deps.runner.run(job.action.prompt ?? "", {
        model: job.action.model,
        cwd: job.workdir,
        timeoutMs: ttlMs,
      }),
      ttlMs,
    );
  }

  private async runScript(job: Job, ttlMs: number | undefined): Promise<RunResult> {
    const script = job.action.script;
    if (!script || script.trim() === "") {
      return { ok: false, output: "", error: "no-agent job has no script" };
    }
    const cwd = job.workdir ?? process.cwd();

    let scriptPath: string;
    let tempPath: string | null = null;
    if (isScriptPath(script)) {
      scriptPath = script;
    } else {
      // 脚本内容 → 落临时 .ts 文件再执行
      tempPath = join(tmpdir(), `omp-gw-script-${crypto.randomUUID()}.ts`);
      await Bun.write(tempPath, script);
      scriptPath = tempPath;
    }

    try {
      let proc: Bun.PipedSubprocess;
      try {
        proc = Bun.spawn(["bun", scriptPath], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
      } catch (e) {
        return { ok: false, output: "", error: `failed to spawn script: ${e instanceof Error ? e.message : String(e)}` };
      }

      // 边跑边读，避免管道缓冲写满导致子进程阻塞
      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();
      try {
        await raceTimeout(proc.exited, ttlMs, () => {
          try {
            proc.kill();
          } catch {
            /* best effort */
          }
        });
      } catch (e) {
        if (e instanceof TimeoutError) return { ok: false, output: "", error: "timeout" };
        throw e;
      }
      const stdout = await stdoutPromise;
      const stderr = await stderrPromise;
      const exitCode = proc.exitCode ?? 0;

      if (exitCode !== 0) {
        return {
          ok: false,
          output: stdout,
          error: stderr.trim() || `script exited with code ${exitCode}`,
          exitCode,
        };
      }
      return await this.finishScript(job, stdout, ttlMs);
    } finally {
      if (tempPath) {
        try {
          await unlink(tempPath);
        } catch {
          /* best effort（进程可能仍在短暂持有） */
        }
      }
    }
  }

  /**
   * no-agent 脚本成功后的唤醒逻辑：
   * - wake_agent 缺省 → 纯脚本，直接返回脚本输出；
   * - wake_agent=false 预检门 → 仅非空输出时唤醒 agent（空输出 ok:true 且 meta.wokeAgent=false）；
   * - wake_agent=true → 始终以脚本输出为 prompt 唤醒 agent。
   */
  private async finishScript(job: Job, output: string, ttlMs: number | undefined): Promise<RunResult> {
    const wake = job.action.wake_agent;
    if (wake === undefined) {
      return { ok: true, output, exitCode: 0 };
    }
    if (wake === false && output.trim() === "") {
      return { ok: true, output, exitCode: 0, meta: { wokeAgent: false } };
    }
    const modelError = invalidModelError(job.action.model);
    if (modelError) return { ok: false, output, error: modelError };
    const result = await raceTimeout(
      this.deps.runner.run(wakePrompt(output), { model: job.action.model, cwd: job.workdir, timeoutMs: ttlMs }),
      ttlMs,
    );
    return { ...result, meta: { ...(result.meta ?? {}), wokeAgent: true, scriptOutput: output } };
  }
}

/**
 * Wrap raw script output into an explicit instruction before waking the agent.
 * Raw output can look like a filename/command to the agent (e.g. a bare
 * "log-2026-08-20T12:00:00Z" token), which triggers file-search tool calls that
 * may stall the turn; the wrapper pins it as inert data to summarize.
 */
function wakePrompt(output: string): string {
	return `以下是 no-agent 脚本的输出内容，请基于这些数据直接处理（总结/分析/答复）。\n不要把输出内容当作文件名、路径或命令去查找或执行任何东西。\n\n脚本输出：\n${output}`;
}

/** 脚本视为文件路径：带脚本扩展名，或实际存在的文件（相对/绝对路径均可） */
function isScriptPath(script: string): boolean {
  const trimmed = script.trim();
  return (
    /\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/i.test(trimmed) || existsSync(trimmed)
  );
}

/**
 * 模型 pin 校验（fail-closed，docs/02-contracts.md §6.4）：格式明显非法时不静默回退，
 * 直接返回错误（不调 runner）。合法形式：含 "/" 的 provider/model，或已知别名前缀。
 * 缺省/空串 → null（视为未 pin）。
 */
const MODEL_ALIASES = [
  "claude",
  "opus",
  "sonnet",
  "haiku",
  "gpt",
  "o1",
  "o3",
  "deepseek",
  "glm",
  "qwen",
  "kimi",
  "grok",
] as const;

function invalidModelError(model: string | undefined): string | null {
  if (model === undefined || model.trim() === "") return null;
  const t = model.trim();
  if (t.includes("/")) return null; // provider/model 形式视为合法
  const lower = t.toLowerCase();
  if (MODEL_ALIASES.some((a) => lower.startsWith(a))) return null; // 别名前缀匹配
  return "invalid model";
}

/** 超时竞速：timeoutMs 缺省/非正数时直通；超时触发 onTimeout 并抛 TimeoutError。 */
async function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout?: () => void,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } finally {
            reject(new TimeoutError());
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
