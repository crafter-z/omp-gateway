/**
 * Gateway config schema (contract: docs/02-contracts.md §1).
 * zod runtime validation, fail-fast at startup.
 */
import { z } from "zod";

export const logConfigSchema = z.object({
	level: z.enum(["debug", "info", "warn", "error"]).default("info"),
	file: z.string().default("~/.omp-gateway/logs/gateway.log"),
});

export const adminConfigSchema = z.object({
	host: z.string().default("127.0.0.1"),
	port: z.number().int().min(1).max(65535).default(18765),
	token: z.string().default(""),
});

export const qqSttConfigSchema = z.object({
	provider: z.enum(["zai", "openai", "none"]).default("zai"),
	base_url: z.string().default(""),
	api_key: z.string().default(""),
	model: z.string().default("glm-asr"),
});

export const qqConfigSchema = z.object({
	app_id: z.string().min(1, "qq.app_id is required"),
	app_secret: z.string().min(1, "qq.app_secret is required"),
	portal_host: z.string().default("q.qq.com"),
	/** WebSocket gateway URL override (empty = derive from portal host). Test/sandbox hook. */
	ws_url: z.string().default(""),
	intents: z
		.array(
			z.enum([
				"C2C_MESSAGE_CREATE",
				"GROUP_AT_MESSAGE_CREATE",
				"PUBLIC_GUILD_MESSAGES",
				"DIRECT_MESSAGE_CREATE",
				"INTERACTION_CREATE",
			]),
		)
		.default(["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE"]),
	allow: z
		.object({
			users: z.array(z.string()).default([]),
			groups: z.array(z.string()).default([]),
			allow_all_users: z.boolean().default(false),
		})
		.default({}),
	stt: qqSttConfigSchema.default({}),
	markdown_support: z.boolean().default(false),
	/** C2C 消息处理期间发送"正在输入"指示（input_notify，50s debounce）。 */
	typing_indicator: z.boolean().default(true),
});

export const ompConfigSchema = z.object({
	/**
	 * CLI entry resolution (contract 02 §5.1):
	 *  - "omp" (or any bare name): resolved via PATH -> spawn(["bun", "omp", "--mode", "rpc", ...])
	 *  - absolute path to cli.js: spawn(["bun", <abs>, "--mode", "rpc", ...])
	 *    (P8 service mode MUST use an absolute path: child PATH may be stripped)
	 */
	binary: z.string().default("omp"),
	model: z.string().default(""),
	thinking: z
		.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"])
		.default("auto"),
	approval: z.enum(["yolo", "write", "always-ask"]).default("yolo"),
	rpc_timeout_ms: z.number().int().min(1000).default(300_000),
	session_dir: z.string().default(""),
	extra_args: z.array(z.string()).default([]),
});

export const schedulerConfigSchema = z.object({
	enabled: z.boolean().default(true),
	tick_s: z.number().int().min(1).default(60),
	max_concurrent_jobs: z.number().int().min(1).default(4),
	misfire_grace_s: z.number().int().min(0).default(300),
	nudge_after_failures: z.number().int().min(1).default(3),
	ledger: z.string().default("~/.omp-gateway/ledger.db"),
	/** liveness 信号目录（ticker_heartbeat/last_success/last_error）；空 = 关闭。 */
	liveness_dir: z.string().default(""),
	/** 已完成的 once job 留存天数（0 = 不清理）。 */
	completed_once_retention_days: z.number().int().min(0).default(7),
	/** 每个 job 的输出文件留存上限（0 = 不清理）。 */
	output_retention: z.number().int().min(0).default(50),
});

export const deliveryConfigSchema = z.object({
	default_target: z.enum(["file", "qq", "origin"]).default("qq"),
	home_channel: z.string().default(""),
	wrap_response: z.boolean().default(true),
	silent_trigger: z.string().default("[SILENT]"),
	/** 投递前过滤 LLM 幻觉的静音叙述 token（*(silent)* / 🔇 / 裸 "." / "…"）。 */
	filter_silence_narration: z.boolean().default(true),
	/**
	 * QQ 回复流式投递（contract 02 §5.3）：text_delta 按边界缓冲到
	 * stream_chunk_chars 即发一条（msg_seq 递增），agent_end 后发余量。
	 * 官方 API 无消息编辑能力，"流式"即多条顺序发送；默认关（一次性投递）。
	 */
	stream_replies: z.boolean().default(false),
	/** 流式分块的目标字符数（在边界字符处切）。 */
	stream_chunk_chars: z.number().int().min(50).max(2000).default(300),
});

export const gatewayConfigSchema = z.object({
	timezone: z.string().default("Asia/Shanghai"),
	log: logConfigSchema.default({}),
	admin: adminConfigSchema.default({}),
	qq: qqConfigSchema,
	omp: ompConfigSchema.default({}),
	scheduler: schedulerConfigSchema.default({}),
	delivery: deliveryConfigSchema.default({}),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type QqConfig = z.infer<typeof qqConfigSchema>;
export type OmpConfig = z.infer<typeof ompConfigSchema>;
export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;
export type DeliveryConfig = z.infer<typeof deliveryConfigSchema>;
export type LogConfig = z.infer<typeof logConfigSchema>;
export type AdminConfig = z.infer<typeof adminConfigSchema>;
