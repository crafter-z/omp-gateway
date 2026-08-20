/**
 * omp extension shell (P7): bridges a running omp-gateway daemon into live
 * omp TUI sessions.
 *
 * - `/gateway status|jobs|...` management commands (via admin HTTP API)
 * - `qq_send` / `job_add` tools for the agent (outbound via admin API)
 * - QQ inbound events -> `pi.sendUserMessage` injection into the current session
 *
 * Install: `omp plugin install omp-gateway` (see package.json omp.extensions).
 * Admin URL/token come from env: OMP_GATEWAY_ADMIN_URL (default
 * http://127.0.0.1:18765) and OMP_GATEWAY_ADMIN_TOKEN.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

interface AdminEvent {
	type: string;
	chatKey?: string;
	text?: string;
	job?: string;
	ok?: boolean;
	output?: string;
	failStreak?: number;
}

export default function gatewayExtension(pi: ExtensionAPI) {
	const adminUrl = (process.env.OMP_GATEWAY_ADMIN_URL ?? "http://127.0.0.1:18765").replace(/\/$/, "");
	const token = process.env.OMP_GATEWAY_ADMIN_TOKEN ?? "";
	const z = pi.zod;

	function headers(): Record<string, string> {
		const h: Record<string, string> = { "content-type": "application/json" };
		if (token) h.authorization = `Bearer ${token}`;
		return h;
	}

	async function api<T>(path: string, init?: RequestInit): Promise<T> {
		const res = await fetch(`${adminUrl}${path}`, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`gateway admin ${res.status}: ${body.slice(0, 200)}`);
		}
		return (await res.json()) as T;
	}

	// ---- /gateway management command ----
	pi.registerCommand("gateway", {
		description: "omp-gateway daemon 管理：status / jobs / job add / job rm",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			try {
				switch (sub ?? "status") {
					case "status": {
						const st = await api<Record<string, unknown>>("/api/status");
						ctx.ui.notify(
							`gateway: daemon=${String(st.daemon)} qq=${String(st.qq)} scheduler=${String(st.scheduler)} jobs=${String(st.jobs)} running=${String(st.runningJobs)}`,
							"info",
						);
						break;
					}
					case "jobs": {
						const jobs = await api<Record<string, unknown>[]>("/api/jobs");
						if (jobs.length === 0) {
							ctx.ui.notify("gateway: no jobs", "info");
							break;
						}
						const lines = jobs.map((j) => `${j.enabled ? "" : "[disabled] "}${String(j.name)} ${String((j.schedule as { kind: string }).kind)}:${String((j.schedule as { expr: string }).expr)} runs=${String(j.run_count)} fail=${String(j.fail_streak)}`);
						ctx.ui.notify(`gateway jobs:\n${lines.join("\n")}`, "info");
						break;
					}
					default:
						ctx.ui.notify(`unknown subcommand: ${sub}（支持 status|jobs）`, "warning");
				}
			} catch (err) {
				ctx.ui.notify(`gateway: ${(err as Error).message}`, "error");
			}
		},
	});

	// ---- qq_send tool: agent sends a QQ message via the daemon ----
	pi.registerTool({
		name: "qq_send",
		label: "QQ Send",
		description: "通过 omp-gateway 向 QQ 会话发送文本消息。chatKey 格式：c2c:<openid>（私聊）或 group:<group_openid>（群）。",
		parameters: z.object({
			chatKey: z.string().describe("目标 chatKey，如 c2c:xxx 或 group:xxx"),
			text: z.string().describe("消息文本"),
		}),
		async execute(
			_toolCallId: string,
			params: { chatKey: string; text: string },
			_onUpdate: unknown,
			_ctx: unknown,
			_signal: unknown,
		) {
			const { chatKey, text } = params;
			await api("/api/outbound/qq", { method: "POST", body: JSON.stringify({ chatKey, text }) });
			return {
				content: [{ type: "text", text: `QQ 消息已发送到 ${chatKey}` }],
				details: { chatKey },
			};
		},
	});

	// ---- job_add tool: agent creates a cron job (no-agent only; anti-loop) ----
	pi.registerTool({
		name: "job_add",
		label: "Job Add",
		description:
			"创建 omp-gateway 定时任务。仅支持 no-agent 类型（执行脚本），agent 创建的 job 不允许再创建调度任务（防死循环）。schedule: interval 如 \"5m\"、cron 6 字段、once \"+30m\"。",
		parameters: z.object({
			name: z.string().describe("唯一 job 名"),
			schedule: z.string().describe('调度：interval "5m" / cron "0 0 9 * * *" / once "+30m"'),
			script: z.string().describe("脚本文件路径或脚本内容"),
			delivery_target: z.enum(["file", "qq", "origin"]).default("file").describe("投递目标（默认 file，避免无 home channel 报错）"),
			file: z.string().optional().describe("target=file 时的输出路径"),
		}),
		async execute(
			_toolCallId: string,
			params: { name: string; schedule: string; script: string; delivery_target: string; file?: string },
			_onUpdate: unknown,
			_ctx: unknown,
			_signal: unknown,
		) {
			const { name, schedule, script, delivery_target, file } = params;
			// 简单调度表达式判定：纯数字+单位 → interval；数字开头带空格单位 → interval；否则 cron
			let kind: "interval" | "cron" | "once" = "cron";
			const trimmed = schedule.trim();
			if (/^\d+(s|m|h|d)$/i.test(trimmed) || /^every\s/i.test(trimmed) || /^每\s/i.test(trimmed)) kind = "interval";
			else if (trimmed.startsWith("+")) kind = "once";
			const job = await api<Record<string, unknown>>("/api/jobs", {
				method: "POST",
				body: JSON.stringify({
					name,
					schedule: { kind, expr: trimmed },
					action: { type: "no-agent", script, wake_agent: false },
					delivery: { target: delivery_target, file },
					meta: { source: "agent" },
				}),
			});
			return {
				content: [{ type: "text", text: `job 已创建: ${String(job.name)} (${String(job.id)})` }],
				details: { jobId: job.id },
			};
		},
	});

	// ---- inbound events: inject QQ messages into the live session ----
	function connectEvents(): void {
		const wsUrl = adminUrl.replace(/^http/, "ws") + "/api/ws";
		let closed = false;
		const ws = new WebSocket(wsUrl, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
		ws.addEventListener("open", () => pi.logger.debug("gateway event stream connected", { wsUrl }));
		ws.addEventListener("message", (ev) => {
			let e: AdminEvent;
			try {
				e = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
			} catch {
				return;
			}
			if (e.type === "qq_message" && e.chatKey && e.text) {
				pi.sendUserMessage(`[QQ ${e.chatKey}] ${e.text}`, { deliverAs: "steer" });
			}
		});
		ws.addEventListener("close", () => {
			if (closed) return;
			setTimeout(connectEvents, 5000);
		});
		ws.addEventListener("error", () => {
			// close follows; reconnection handled there
		});
	}
	connectEvents();
}
