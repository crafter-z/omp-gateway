/**
 * REAL-environment smoke: production QQ credentials (from hermes .env), real
 * bots.qq.com token endpoint, real wss gateway via GET /gateway discovery.
 * Asserts the daemon's QqGateway reaches READY against the live service.
 * No messages are sent — inbound requires a user to message the bot first.
 */
import { Daemon } from "../../src/daemon.ts";
import { createLogger } from "../../src/util/logger.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../../src/config/schema.ts";

const env = await Bun.file(join(homedir(), "AppData", "Local", "hermes", ".env")).text();
if (!/QQ_CLIENT_SECRET=\S+/.test(env)) {
	console.error("no QQ_CLIENT_SECRET in hermes .env");
	process.exit(1);
}

const cfg: GatewayConfig = {
	timezone: "Asia/Shanghai",
	log: { level: "info", file: "" },
	admin: { host: "127.0.0.1", port: 0, token: "" },
	qq: {
		app_id: "1903491211",
		app_secret: env.match(/QQ_CLIENT_SECRET=(\S+)/)![1]!,
		portal_host: "q.qq.com",
		ws_url: "",
		intents: ["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE"],
		markdown_support: false,
		typing_indicator: false,
		stt: { provider: "none", base_url: "", api_key: "", model: "" },
		allow: { users: [], groups: [], allow_all_users: true },
	},
	omp: {
		binary: "omp",
		model: "",
		thinking: "auto",
		approval: "yolo",
		rpc_timeout_ms: 300_000,
		session_dir: "",
		extra_args: [],
	},
	scheduler: {
		enabled: false,
		tick_s: 3600,
		max_concurrent_jobs: 2,
		misfire_grace_s: 300,
		nudge_after_failures: 3,
		ledger: ":memory:",
		liveness_dir: "",
		completed_once_retention_days: 7,
		output_retention: 50,
	},
	delivery: {
		default_target: "qq",
		home_channel: "",
		wrap_response: true,
		silent_trigger: "[SILENT]",
		filter_silence_narration: true,
		stream_replies: false,
		stream_chunk_chars: 300,
	},
};

const daemon = new Daemon(cfg, createLogger({ level: "info" }));
await daemon.start();

// Poll the admin status seam for real gateway state (connected = READY received).
const deadline = Date.now() + 20_000;
let status = "";
while (Date.now() < deadline) {
	const qqState = daemon["qq"]?.connected ? "connected" : "connecting";
	status = qqState;
	if (qqState === "connected") break;
	await new Promise((r) => setTimeout(r, 500));
}

await daemon.stop();
if (status !== "connected") {
	console.error(`SMOKE FAIL: gateway never reached READY (last state: ${status})`);
	process.exit(1);
}
console.log("REAL SMOKE PASS: token → /gateway discovery → WS Hello → IDENTIFY → READY");
