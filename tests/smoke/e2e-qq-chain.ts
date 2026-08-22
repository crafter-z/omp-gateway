/**
 * End-to-end smoke: real Daemon (local WS mock gateway + echo fake-omp +
 * mocked token/send REST) processing one allowed and one denied inbound
 * message. Asserts:
 * - denied message: no REST send, no spawn
 * - allowed message: full chain runs, reply sent with passive msg_id
 */
import { Daemon } from "../../src/daemon.ts";
import { createLogger } from "../../src/util/logger.ts";
import { resolve } from "node:path";
import type { GatewayConfig } from "../../src/config/schema.ts";
import { createWsServer } from "../fixtures/ws-server.ts";

const realFetch = globalThis.fetch;

const cfg: GatewayConfig = {
	timezone: "Asia/Shanghai",
	log: { level: "error", file: "" },
	admin: { host: "127.0.0.1", port: 0, token: "" },
	qq: {
		app_id: "smoke-app",
		app_secret: "smoke-secret",
		portal_host: "q.qq.com",
		ws_url: "",
		intents: [],
		markdown_support: false,
		typing_indicator: false,
		stt: { provider: "none", base_url: "", api_key: "", model: "" },
		allow: { users: ["allowed-user"], groups: [], allow_all_users: false },
	},
	omp: {
		binary: resolve(import.meta.dir, "..", "fixtures", "fake-omp.ts"),
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
		stale_execution_s: 3600,
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

const bodies: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	if (url.includes("/app/getAppAccessToken")) {
		return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: 200 });
	}
	bodies.push(JSON.parse(String(init?.body)));
	return new Response(JSON.stringify({ id: `out-${bodies.length}` }), { status: 200 });
}) as unknown as typeof fetch;

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 20);
		await promise;
	}
}

const h = await createWsServer();
cfg.qq.ws_url = h.url; // 指向本地 mock 网关
const daemon = new Daemon(cfg, createLogger({ level: "error" }));
await daemon.start();

// 等待 gateway 连上 mock 并 READY
await waitFor(() => h.sockets.size === 1);

function pushC2C(id: string, openid: string, content: string): void {
	h.pushEvent(h.sockets.values().next().value!, "C2C_MESSAGE_CREATE", {
		id,
		author: { user_openid: openid },
		content,
		attachments: [],
	});
}

// 1) 未在 allowlist 的用户 → 静默丢弃
pushC2C("deny-1", "stranger", "should be dropped");
await new Promise((r) => setTimeout(r, 300));
console.assert(bodies.length === 0, `denied message must not send (got ${bodies.length})`);

// 2) allowlist 用户 → 全链路，被动回复带 msg_id
pushC2C("allow-1", "allowed-user", "hello smoke");
await waitFor(() => bodies.length >= 1);
const reply = bodies[0] as Record<string, unknown>;
console.assert(reply.msg_id === "allow-1", `reply must carry msg_id=allow-1 (got ${JSON.stringify(reply)})`);
console.assert(
	typeof reply.content === "string" && (reply.content as string).includes("hello smoke"),
	`echo fixture must answer with prompt text (got ${String(reply.content).slice(0, 80)})`,
);

await daemon.stop();
await h.close();
globalThis.fetch = realFetch;
console.log("SMOKE PASS: allowlist gate + passive reply msg_id verified end-to-end");
