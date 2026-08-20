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
	intents: z
		.array(z.enum(["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE", "PUBLIC_GUILD_MESSAGES"]))
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
});

export const deliveryConfigSchema = z.object({
	default_target: z.enum(["file", "qq", "origin"]).default("qq"),
	home_channel: z.string().default(""),
	wrap_response: z.boolean().default(true),
	silent_trigger: z.string().default("[SILENT]"),
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
