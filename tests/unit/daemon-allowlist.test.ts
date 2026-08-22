/**
 * Daemon-level regression tests: allowlist enforcement in the QQ inbound
 * path. Uses a real Daemon against a local WS mock (no QQ network) and a
 * fail-fast fake omp CLI (tests/fixtures/fake-omp-fail.ts) so an allowed
 * message reaches the runner and the delivery REST call is observed, while
 * a denied message never touches the network or spawns a process.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { Daemon } from "../../src/daemon.ts";
import { createLogger } from "../../src/util/logger.ts";
import { resolve } from "node:path";
import type { GatewayConfig } from "../../src/config/schema.ts";
import type { InboundMessage } from "../../src/qq/types.ts";
import { createWsServer, type WsServerHandle } from "../fixtures/ws-server.ts";

const realFetch = globalThis.fetch;
const openServers: WsServerHandle[] = [];
const daemons: Daemon[] = [];

afterEach(async () => {
	for (const d of daemons.splice(0)) await d.stop();
	for (const s of openServers.splice(0)) await s.close();
	globalThis.fetch = realFetch;
});

/**
 * Absolute path of the fake omp RPC server (echo mode by default): an
 * allowed message runs a full agent round and the delivery REST call is
 * observed. RpcRunner spawns `bun <cliPath> --mode rpc`; the fixture reads
 * FAKE_OMP_MODE from env (inherited), defaulting to "echo".
 */
function fakeOmpCli(): string {
	return resolve(import.meta.dir, "..", "fixtures", "fake-omp.ts");
}

function makeCfg(allowOverrides: Partial<GatewayConfig["qq"]["allow"]> = {}): GatewayConfig {
	return {
		timezone: "Asia/Shanghai",
		log: { level: "error", file: "" },
		admin: { host: "127.0.0.1", port: 0, token: "" },
	qq: {
		app_id: "app",
		app_secret: "sec",
		portal_host: "q.qq.com",
		ws_url: "",
		intents: [],
		markdown_support: false,
		typing_indicator: false,
		stt: { provider: "none", base_url: "", api_key: "", model: "" },
		allow: { users: [], groups: [], allow_all_users: false, ...allowOverrides },
	},
		omp: {
			binary: fakeOmpCli(), // fail-fast fake：允许路径的 run 在毫秒级失败
			model: "",
			thinking: "auto",
			approval: "yolo",
			rpc_timeout_ms: 300_000,
			session_dir: "",
			extra_args: [],
		},
		scheduler: {
			enabled: false, // 不启动 croner/tick，只测消息门控
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
}

function msg(partial: Partial<InboundMessage> = {}): InboundMessage {
	return {
		id: `m-${crypto.randomUUID().slice(0, 8)}`,
		chatKey: "c2c:userA",
		authorOpenid: "userA",
		text: "hello",
		attachments: [],
		raw: {},
		...partial,
	};
}

/** Start a daemon whose QQ gateway connects to a local WS mock (no real network). */
async function startDaemon(cfg: GatewayConfig): Promise<Daemon> {
	const h = await createWsServer();
	openServers.push(h);
	const d = new Daemon(cfg, createLogger({ level: "error" }));
	await d.start();
	daemons.push(d);
	return d;
}

describe("daemon allowlist enforcement", () => {
	test("c2c denied when user not listed and allow_all_users=false — no network, no delivery", async () => {
		globalThis.fetch = (() => {
			throw new Error("network must not be touched");
		}) as unknown as typeof fetch;
		const d = await startDaemon(makeCfg({ users: ["userB"] }));
		const events = (d as unknown as { listeners: Set<(e: unknown) => void> }).listeners;
		const seen: unknown[] = [];
		events.add((e) => seen.push(e));
		await d["handleQqMessage"](msg());
		expect(seen).toHaveLength(0); // 未进 runner、未投递、未 emit
	});

	test("c2c allowed when allow_all_users=true — delivery REST is reached even on runner failure", async () => {
		let sendCalls = 0;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/app/getAppAccessToken")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: 200 });
			}
			sendCalls++;
			return new Response(JSON.stringify({ id: "out-1" }), { status: 200 });
		}) as unknown as typeof fetch;
		const d = await startDaemon(makeCfg({ allow_all_users: true }));
		await d["handleQqMessage"](msg());
		expect(sendCalls).toBeGreaterThan(0);
	});

	test("group denied when group not listed — no network", async () => {
		globalThis.fetch = (() => {
			throw new Error("network must not be touched");
		}) as unknown as typeof fetch;
		const d = await startDaemon(makeCfg({ groups: ["groupX"], users: ["userA"], allow_all_users: true }));
		// 拒绝路径静默返回；若误放行会抛 network must not be touched 并使测试失败
		await d["handleQqMessage"](msg({ chatKey: "group:not-listed", authorOpenid: "userA" }));
	});

	test("group allowed when listed — delivery REST is reached", async () => {
		let sendCalls = 0;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/app/getAppAccessToken")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: 200 });
			}
			sendCalls++;
			return new Response(JSON.stringify({ id: "out-1" }), { status: 200 });
		}) as unknown as typeof fetch;
		const d = await startDaemon(makeCfg({ groups: ["groupY"] }));
		await d["handleQqMessage"](msg({ chatKey: "group:groupY", authorOpenid: "whoever" }));
		expect(sendCalls).toBeGreaterThan(0);
	});
});

describe("per-chat message serialization", () => {
	test("same chatKey: messages run FIFO, never overlapping", async () => {
		let inFlight = 0;
		let peak = 0;
		const order: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/app/getAppAccessToken")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: 200 });
			}
			return new Response(JSON.stringify({ id: "out" }), { status: 200 });
		}) as unknown as typeof fetch;
		const d = await startDaemon(makeCfg({ allow_all_users: true }));
		// 替换 runner 为可控 fake：记录并发峰值与完成顺序
		const slowRunner = {
			run: async (prompt: string) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await Bun.sleep(30);
				order.push(prompt);
				inFlight--;
				return { ok: true, output: `done:${prompt}` };
			},
		} as never;
		(d as unknown as { runner: unknown }).runner = slowRunner;

		await Promise.all([
			d["handleQqMessage"](msg({ id: "m1", text: "first" })),
			d["handleQqMessage"](msg({ id: "m2", text: "second" })),
			d["handleQqMessage"](msg({ id: "m3", text: "third" })),
		]);
		expect(peak).toBe(1); // 同 chat 严格串行
		expect(order).toEqual(["first", "second", "third"]); // FIFO
	});

	test("different chatKeys run concurrently", async () => {
		let inFlight = 0;
		let peak = 0;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/app/getAppAccessToken")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: 200 });
			}
			return new Response(JSON.stringify({ id: "out" }), { status: 200 });
		}) as unknown as typeof fetch;
		const d = await startDaemon(makeCfg({ allow_all_users: true }));
		const gate = Promise.withResolvers<void>();
		const slowRunner = {
			run: async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await gate.promise;
				inFlight--;
				return { ok: true, output: "ok" };
			},
		} as never;
		(d as unknown as { runner: unknown }).runner = slowRunner;

		const a = d["handleQqMessage"](msg({ id: "a1", chatKey: "c2c:userA", authorOpenid: "userA", text: "a" }));
		const b = d["handleQqMessage"](msg({ id: "b1", chatKey: "c2c:userB", authorOpenid: "userB", text: "b" }));
		await Bun.sleep(20);
		expect(peak).toBe(2); // 不同 chat 并行
		gate.resolve();
		await Promise.all([a, b]);
	});
});
