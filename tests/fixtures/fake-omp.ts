/**
 * Fake omp RPC server for integration tests (tests/integration/client.test.ts).
 *
 * Spawned by OmpRpcClient as `bun tests/fixtures/fake-omp.ts --mode rpc`
 * (the `--mode rpc` arg is ignored). Behavior is driven by FAKE_OMP_MODE:
 * - echo (default): ready (v1+v2) -> answer negotiate_protocol -> on prompt,
 *   stream the message back as text_delta chunks, then agent_end + response.
 * - v1: same as echo but ready only advertises protocol v1 (no negotiation).
 * - crash: writes a marker to stderr and exits 1 before emitting ready.
 * - slow: like echo but sleeps 5s before answering a prompt (timeout tests).
 * - idle: emits ready, then never responds to anything.
 *
 * The emitted event frames use the real omp shapes so the client's
 * normalization is exercised against authentic wire format.
 */

const MODE = (Bun.env.FAKE_OMP_MODE ?? "echo") as "echo" | "v1" | "crash" | "slow" | "idle";
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

const out = Bun.stdout.writer();

function send(obj: unknown): void {
	out.write(JSON.stringify(obj));
	out.write("\n");
	out.flush();
}

function isCommand(value: unknown): value is Record<string, unknown> & { type: string; id?: string } {
	return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string";
}

function success(id: string | undefined, command: string, data?: unknown): void {
	send({ type: "response", id, command, success: true, ...(data !== undefined ? { data } : {}) });
}

function failure(id: string | undefined, command: string, error: string): void {
	send({ type: "response", id, command, success: false, error });
}

async function* readJsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (line.length === 0) continue;
				yield JSON.parse(line);
			}
		}
		const tail = buffer.trim();
		if (tail.length > 0) yield JSON.parse(tail);
	} finally {
		reader.releaseLock();
	}
}

async function handlePrompt(cmd: Record<string, unknown> & { type: string; id?: string }): Promise<void> {
	if (MODE === "idle") return; // never respond
	if (MODE === "slow") await Bun.sleep(5000);
	const message = typeof cmd.message === "string" ? cmd.message : "";
	const chunks = message.match(/.{1,4}/gs) ?? [message];
	for (const chunk of chunks) {
		await Bun.sleep(5);
		send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
	}
	send({ type: "agent_end", isTerminal: true });
	success(cmd.id, "prompt", { agentInvoked: true });
}

async function main(): Promise<void> {
	if (MODE === "crash") {
		await Bun.stderr.write("fake-omp crash: boom before ready\n");
		process.exit(1);
	}

	const supportedProtocolVersions = MODE === "v1" ? [1] : [1, 2];
	send({
		type: "ready",
		protocolVersion: 1,
		supportedProtocolVersions,
		maxFrameBytes: MAX_FRAME_BYTES,
		maxReassembledFrameBytes: MAX_REASSEMBLED_BYTES,
	});

	for await (const raw of readJsonLines(Bun.stdin.stream())) {
		if (!isCommand(raw)) continue;
		switch (raw.type) {
			case "negotiate_protocol": {
				await Bun.stderr.write(`[fake-omp] received negotiate_protocol v${String(raw.protocolVersion)}\n`);
				success(raw.id, "negotiate_protocol", { protocolVersion: raw.protocolVersion });
				break;
			}
			case "prompt":
				await handlePrompt(raw);
				break;
			case "steer":
			case "follow_up":
			case "abort":
			case "set_model":
			case "set_thinking_level":
			case "set_host_tools":
				success(raw.id, raw.type);
				break;
			default:
				failure(raw.id, raw.type, `fake-omp does not handle command ${raw.type}`);
				break;
		}
	}
}

if (import.meta.main) {
	await main();
}
