/**
 * JSONL frame encoding/decoding for the omp RPC transport, including
 * protocol v2 chunk reassembly.
 *
 * Wire reference: `@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-frame.ts`
 * (installed at C:/Users/craft/.bun/install/global/node_modules/...).
 * Protocol authority: docs/02-contracts.md §5.2.
 */

/** Maximum UTF-8 size (including trailing newline) of one physical RPC frame. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Maximum size of one logical frame reassembled from v2 chunks. */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** Payload budget per v2 chunk (matches the omp server's RPC_CHUNK_PAYLOAD_BYTES). */
const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialize one logical frame as a single JSONL line.
 *
 * Frames larger than MAX_RPC_FRAME_BYTES throw: M1 does not implement outgoing
 * v2 chunking (per the overflow simplification in the plan), so oversized
 * frames fail loudly instead of corrupting the stream.
 */
export function encodeFrame(obj: unknown): string {
	const json = JSON.stringify(obj);
	if (json === undefined) throw new Error("cannot encode undefined as an RPC frame");
	// +1 for the trailing newline that will be appended.
	if (Buffer.byteLength(json, "utf8") + 1 > MAX_RPC_FRAME_BYTES) {
		throw new Error(
			`RPC frame exceeds the ${MAX_RPC_FRAME_BYTES}-byte transport limit (${Buffer.byteLength(json, "utf8")} bytes); outgoing chunking is not implemented`,
		);
	}
	return json + "\n";
}

/** Protocol v2 chunk frame shape (`rpc_chunk`); `byteLength` is optional in our decoder. */
export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength?: number;
	data: string; // base64-encoded bytes of this chunk
}

function isChunkFrame(value: unknown): value is RpcChunkFrame {
	if (!isRecord(value) || value.type !== "rpc_chunk") return false;
	const { chunkId, index, count, data } = value;
	return (
		typeof chunkId === "string" &&
		chunkId.length > 0 &&
		chunkId.length <= 128 &&
		Number.isSafeInteger(index) &&
		Number.isSafeInteger(count) &&
		typeof data === "string" &&
		data.length > 0
	);
}

function decodeBase64(data: string): Uint8Array {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
		throw new Error("invalid rpc chunk data (not base64)");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) throw new Error("invalid rpc chunk data");
	return bytes;
}

interface PendingChunks {
	chunkId: string;
	count: number;
	byteLength: number; // 0 = not declared by the peer; length validated after concatenation instead
	nextIndex: number;
	chunks: Uint8Array[];
	receivedBytes: number;
}

/**
 * Reassembles protocol v2 chunk frames. Feed every parsed JSONL line into
 * `push`; non-chunk frames pass through unchanged, and a complete chunk
 * sequence yields the decoded logical frame (also an object).
 */
export class RpcFrameDecoder {
	#pending: PendingChunks | null = null;

	/**
	 * @param line a JSON-parsed line from the stdout stream
	 * @returns the logical frame, or `undefined` while a chunk sequence is still accumulating
	 */
	push(line: unknown): unknown {
		if (!isChunkFrame(line)) {
			if (this.#pending) throw new Error("rpc chunk sequence interrupted");
			if (!isRecord(line)) throw new Error("rpc frame must be an object");
			return line;
		}

		const { chunkId, index, count, data } = line;
		if (index < 0 || count < 2 || index >= count) throw new Error("invalid rpc chunk metadata");
		const declaredByteLength = line.byteLength;
		if (declaredByteLength !== undefined && !Number.isSafeInteger(declaredByteLength)) {
			throw new Error("invalid rpc chunk metadata");
		}
		const bytes = decodeBase64(data);
		if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
			throw new Error("rpc chunk payload exceeds the transport limit");
		}

		if (!this.#pending) {
			if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
			this.#pending = {
				chunkId,
				count,
				byteLength: typeof declaredByteLength === "number" ? declaredByteLength : 0,
				nextIndex: 0,
				chunks: [],
				receivedBytes: 0,
			};
		}
		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.nextIndex !== index ||
			(pending.byteLength !== 0 && declaredByteLength !== pending.byteLength)
		) {
			throw new Error("rpc chunk sequence mismatch");
		}
		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex++;
		if (pending.receivedBytes > MAX_RPC_REASSEMBLED_BYTES) {
			throw new Error("rpc chunk sequence exceeds the reassembled limit");
		}
		if (pending.nextIndex < pending.count) return undefined;
		if (pending.byteLength !== 0 && pending.receivedBytes !== pending.byteLength) {
			throw new Error("rpc chunk sequence length mismatch");
		}

		this.#pending = null;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
		const frame: unknown = JSON.parse(decoded);
		if (!isRecord(frame)) throw new Error("rpc frame must be an object");
		return frame;
	}

	/** True while a partial chunk sequence is being accumulated. */
	get hasPending(): boolean {
		return this.#pending !== null;
	}
}
