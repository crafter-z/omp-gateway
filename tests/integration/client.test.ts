/**
 * Integration tests for the omp driver (src/omp) against the fake-omp fixture.
 * Covers: v2 negotiation, prompt streaming, v1 fallback, crash stderr capture,
 * prompt timeout with process reaping, idle timeouts, close idempotency,
 * request-response commands, plus unit checks for protocol.ts and session.ts.
 */
import { describe, expect, test } from "bun:test";
import { OmpRpcClient } from "../../src/omp/client.ts";
import { RpcFrameDecoder, encodeFrame, MAX_RPC_FRAME_BYTES } from "../../src/omp/protocol.ts";
import { buildArgs } from "../../src/omp/session.ts";
import type { AgentEvent } from "../../src/omp/types.ts";

const FAKE_OMP = import.meta.dir + "/../fixtures/fake-omp.ts";

function makeClient(mode: string, extra: Partial<{ timeoutMs: number }> = {}): OmpRpcClient {
	return new OmpRpcClient({ cliPath: FAKE_OMP, env: { FAKE_OMP_MODE: mode }, ...extra });
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(25);
	}
	expect(condition()).toBe(true);
}

function textDeltas(events: AgentEvent[]): string {
	return events
		.filter((e): e is Extract<AgentEvent, { kind: "text_delta" }> => e.kind === "text_delta")
		.map(e => e.text)
		.join("");
}

function agentEnds(events: AgentEvent[]): Array<Extract<AgentEvent, { kind: "agent_end" }>> {
	return events.filter((e): e is Extract<AgentEvent, { kind: "agent_end" }> => e.kind === "agent_end");
}

async function collectPrompt(client: OmpRpcClient, message: string): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of client.prompt({ message })) events.push(event);
	return events;
}

describe("connect", () => {
	test("negotiates protocol v2 and confirms via logs", async () => {
		const client = makeClient("echo");
		await client.connect();
		expect(client.protocolVersion).toBe(2);
		// The fake reports every received negotiate_protocol on stderr; the
		// client's stderr capture is the observable log of the negotiation.
		await waitFor(() => client.stderrLog.includes("negotiate_protocol"), 3000);
		expect(client.stderrLog).toContain("v2");
		await client.close();
	});

	test("falls back to protocol v1 when the server only supports v1", async () => {
		const client = makeClient("v1");
		await client.connect();
		expect(client.protocolVersion).toBe(1);
		const events = await collectPrompt(client, "v1 echo");
		expect(textDeltas(events)).toBe("v1 echo");
		await client.close();
	});

	test("crash mode: connect rejects and the error includes stderr", async () => {
		const client = makeClient("crash");
		await expect(client.connect()).rejects.toThrow(/boom/);
		await client.close();
	});
});

describe("prompt", () => {
	test("streams echoed text deltas and a terminal agent_end", async () => {
		const client = makeClient("echo");
		await client.connect();
		const message = "hello from fake omp";
		const events = await collectPrompt(client, message);
		expect(textDeltas(events)).toBe(message);
		const ends = agentEnds(events);
		expect(ends).toHaveLength(1);
		expect(ends[0].isTerminal).toBe(true);
		expect(events[events.length - 1].kind).toBe("agent_end");
		await client.close();
	});

	test("slow mode: prompt rejects on timeout and the process is reaped", async () => {
		const client = makeClient("slow", { timeoutMs: 1000 });
		await client.connect();
		const started = Date.now();
		let caught: unknown;
		try {
			await collectPrompt(client, "slow reply");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("timed out");
		expect(Date.now() - started).toBeLessThan(4000); // rejects well before the 5s fake reply
		await waitFor(() => client.exitCode !== null, 5000); // taskkill reaped the tree
		expect(client.exitCode).not.toBeNull();
	});

	test("idle mode: prompt with a short timeout rejects", async () => {
		const client = makeClient("idle", { timeoutMs: 500 });
		await client.connect();
		let caught: unknown;
		try {
			await collectPrompt(client, "anyone there?");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("timed out");
		await waitFor(() => client.exitCode !== null, 5000);
	});

	test("request-response commands resolve against the fake", async () => {
		const client = makeClient("echo");
		await client.connect();
		await client.steer("continue");
		await client.followUp("and then?");
		await client.abort();
		await client.setModel("anthropic", "claude-sonnet-4-5");
		await client.setThinkingLevel("medium");
		await client.setHostTools([
			{ name: "qq_send", description: "send a QQ message", parameters: { chatKey: { type: "string" } } },
		]);
		await client.close();
	});

	test("close is idempotent and reaps the process", async () => {
		const client = makeClient("echo");
		await client.connect();
		expect(client.exitCode).toBeNull();
		await client.close();
		await client.close(); // second call must not throw
		expect(client.exitCode).not.toBeNull();
	});
});

describe("protocol", () => {
	test("encodeFrame serializes a JSONL line", () => {
		expect(encodeFrame({ type: "abort", id: "req_1" })).toBe('{"type":"abort","id":"req_1"}\n');
	});

	test("encodeFrame throws when a frame exceeds the 1MB transport limit", () => {
		expect(() => encodeFrame({ big: "x".repeat(MAX_RPC_FRAME_BYTES) })).toThrow(/exceeds/);
	});

	test("RpcFrameDecoder passes non-chunk frames through", () => {
		const decoder = new RpcFrameDecoder();
		expect(decoder.push({ type: "ready" })).toEqual({ type: "ready" });
	});

	test("RpcFrameDecoder reassembles a v2 chunk sequence", () => {
		const decoder = new RpcFrameDecoder();
		const logical = {
			type: "response",
			id: "req_7",
			command: "get_state",
			success: true,
			data: { note: "x".repeat(600_000) },
		};
		const bytes = Buffer.from(JSON.stringify(logical), "utf8");
		const chunkSize = 256 * 1024;
		const count = Math.ceil(bytes.length / chunkSize);
		for (let index = 0; index < count; index++) {
			const data = bytes.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, bytes.length)).toString("base64");
			const out = decoder.push({ type: "rpc_chunk", chunkId: "c1", index, count, byteLength: bytes.length, data });
			if (index < count - 1) expect(out).toBeUndefined();
			else expect(out).toEqual(logical);
		}
	});

	test("RpcFrameDecoder rejects an interrupted chunk sequence", () => {
		const decoder = new RpcFrameDecoder();
		const bytes = Buffer.from(JSON.stringify({ a: 1 }), "utf8");
		decoder.push({ type: "rpc_chunk", chunkId: "c1", index: 0, count: 2, data: bytes.toString("base64") });
		expect(() => decoder.push({ type: "ready" })).toThrow(/interrupted/);
	});

	test("RpcFrameDecoder rejects a sequence not starting at index 0", () => {
		const decoder = new RpcFrameDecoder();
		const bytes = Buffer.from(JSON.stringify({ a: 1 }), "utf8");
		expect(() => decoder.push({ type: "rpc_chunk", chunkId: "c1", index: 1, count: 2, data: bytes.toString("base64") })).toThrow(/start at index 0/);
	});
});

describe("session buildArgs", () => {
	test("ephemeral cron runs use --no-session", () => {
		expect(buildArgs({ noSession: true })).toEqual(["--no-session"]);
	});

	test("QQ resume reuses a session via -r <path>", () => {
		expect(buildArgs({ sessionPath: "C:/sessions/chat-c2c-openid.jsonl" })).toEqual(["-r", "C:/sessions/chat-c2c-openid.jsonl"]);
	});

	test("noSession wins over sessionPath", () => {
		expect(buildArgs({ noSession: true, sessionPath: "C:/x.jsonl" })).toEqual(["--no-session"]);
	});

	test("extra args are appended after session flags", () => {
		expect(buildArgs({ sessionPath: "s.jsonl", extra: ["--no-tools"] })).toEqual(["-r", "s.jsonl", "--no-tools"]);
	});

	test("empty options produce no args", () => {
		expect(buildArgs()).toEqual([]);
		expect(buildArgs({})).toEqual([]);
	});
});
