/**
 * QQ outbound REST API (official QQ Bot API v2).
 *
 * - Access tokens: fetched from getAppAccessToken and cached per
 *   (app_id, portal_host); concurrent callers share one in-flight fetch.
 * - Passive replies: pass msgId (inbound message id) + msgSeq (>=2 for the
 *   second and later replies to the same msg_id) so sends ride the passive
 *   reply window instead of consuming active-message quota.
 * - Transient failures (429 with Retry-After, 500/502/503/504) are retried
 *   up to MAX_ATTEMPTS with linear backoff.
 */
import type { ChatRef, QqConfig } from "./types.ts";

const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 7200;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

/** Token cache keyed by `${app_id}@${portal_host}` (multi-config safe). */
const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();
const inFlightTokenFetches = new Map<string, Promise<string>>();

/** Reset the module-level token caches (tests / config reload). */
export function resetAccessTokenCache(): void {
	tokenCache.clear();
	inFlightTokenFetches.clear();
}

/**
 * v2 REST API base. The official host is api.sgroup.qq.com for ALL chat
 * types (c2c/group) — api.q.qq.com resolves but serves a generic 404 page.
 */
const API_BASE = "https://api.sgroup.qq.com";

function tokenKey(cfg: QqConfig): string {
	return cfg.app_id;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Token endpoint. The official host is bots.qq.com (NOT apps.q.qq.com — that
 * domain does not resolve) and is identical for production and sandbox apps.
 */
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

/**
 * POST JSON with retry on transient failures. Returns the final Response;
 * callers own body reading. Non-retryable statuses resolve immediately.
 * Retries honor a numeric Retry-After header (seconds) when present,
 * otherwise linear backoff RETRY_BASE_DELAY_MS * attempt.
 */
export async function postJsonWithRetry(
	url: string,
	headers: Record<string, string>,
	body: string,
): Promise<Response> {
	let lastRes: Response | null = null;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body,
		});
		if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) return res;
		lastRes = res;
		const retryAfter = Number(res.headers.get("retry-after"));
		const waitMs =
			Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_DELAY_MS * attempt;
		await delay(waitMs);
	}
	return lastRes!;
}


export interface SendTextOptions {
	/** Echo the inbound message id (msg_id) when replying passively. */
	msgId?: string;
	/** Passive-reply sequence: 1 for the first reply to a msg_id, increment
	 *  for each additional reply within the same reply window (segmented
	 *  delivery). Ignored without msgId. */
	msgSeq?: number;
	/**
	 * Send as rich Markdown (msg_type 2, body `markdown.content`). Requires
	 * the platform capability (c2c/group open since 2026-04; guilds invite-only).
	 * When set, the plain `content` field is omitted per the API contract.
	 */
	markdown?: boolean;
}

/**
 * Return a valid app access token, fetching (and caching) one when missing
 * or within {@link TOKEN_REFRESH_SKEW_MS} of expiry. Cache is keyed per
 * (app_id, portal_host); concurrent callers for the same key share a single
 * in-flight fetch.
 */
export async function getAccessToken(cfg: QqConfig): Promise<string> {
	const key = tokenKey(cfg);
	const cached = tokenCache.get(key);
	if (cached && Date.now() < cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
		return cached.token;
	}
	const inFlight = inFlightTokenFetches.get(key);
	if (inFlight) return inFlight;
	const fetchPromise = (async () => {
		const res = await postJsonWithRetry(
			TOKEN_URL,
			{ "Content-Type": "application/json" },
			JSON.stringify({ appId: cfg.app_id, clientSecret: cfg.app_secret }),
		);
		const body = (await res.json().catch(() => null)) as {
			access_token?: unknown;
			expires_in?: unknown;
		} | null;
		if (!res.ok || !body || typeof body.access_token !== "string") {
			throw new Error(`QQ getAppAccessToken failed (${res.status}): ${JSON.stringify(body)}`);
		}
		const expiresIn = typeof body.expires_in === "number" ? body.expires_in : DEFAULT_EXPIRES_IN_S;
		tokenCache.set(key, { token: body.access_token, expiresAtMs: Date.now() + expiresIn * 1000 });
		return body.access_token;
	})().finally(() => {
		inFlightTokenFetches.delete(key);
	});
	inFlightTokenFetches.set(key, fetchPromise);
	return fetchPromise;
}

/** Build the passive-reply fields for a message body. */
function replyFields(opts: SendTextOptions): Record<string, unknown> {
	if (!opts.msgId) return {};
	return { msg_id: opts.msgId, ...(opts.msgSeq !== undefined ? { msg_seq: opts.msgSeq } : {}) };
}

/**
 * Message body for a text/markdown send: plain (msg_type 0 + content) or
 * markdown (msg_type 2 + markdown.content — the API rejects a `content`
 * field alongside markdown).
 */
function messageBody(text: string, opts: SendTextOptions): Record<string, unknown> {
	if (opts.markdown) {
		return { msg_type: 2, markdown: { content: text }, ...replyFields(opts) };
	}
	return { content: text, msg_type: 0, ...replyFields(opts) };
}

/**
 * REST endpoint for a chat ref. c2c → /v2/users/{openid}/messages,
 * group → /v2/groups/{group_openid}/messages, guild → /channels/{channel_id}/messages.
 */
function messageEndpoint(chat: ChatRef): string {
  if (chat.chatKey.startsWith("group:")) {
    return `${API_BASE}/v2/groups/${encodeURIComponent(chat.openid)}/messages`;
  }
  if (chat.chatKey.startsWith("guild:")) {
    return `${API_BASE}/channels/${encodeURIComponent(chat.openid)}/messages`;
  }
  return `${API_BASE}/v2/users/${encodeURIComponent(chat.openid)}/messages`;
}

/**
 * Send a plain-text (msg_type 0) message to a c2c user, group, or guild
 * channel. Resolves with the created message id; throws with the response
 * body included on non-2xx responses.
 */
export async function sendText(
	cfg: QqConfig,
	chat: ChatRef,
	text: string,
	opts: SendTextOptions = {},
): Promise<{ id: string }> {
	const token = await getAccessToken(cfg);
	const res = await postJsonWithRetry(
		messageEndpoint(chat),
		{
			Authorization: `QQBot ${token}`,
			"Content-Type": "application/json",
		},
		JSON.stringify(messageBody(text, opts)),
	);
	const raw = await res.text();
	if (!res.ok) {
		throw new Error(`QQ sendText failed (${res.status}): ${raw}`);
	}
	let id = "";
	try {
		const parsed = JSON.parse(raw) as { id?: unknown };
		if (typeof parsed.id === "string") id = parsed.id;
	} catch {
		// 2xx without a JSON body — an empty id is acceptable
	}
	return { id };
}

/**
 * Typing indicator (msg_type 6 input_notify). Only supported for c2c chats —
 * no-ops for group/guild. Debounce is the caller's responsibility.
 */
export async function sendInputNotify(
	cfg: QqConfig,
	chat: ChatRef,
	opts: { msgId?: string; seconds?: number } = {},
): Promise<void> {
	if (!chat.chatKey.startsWith("c2c:")) return;
	if (!opts.msgId) return; // QQ requires the originating message id
	const token = await getAccessToken(cfg);
	const res = await postJsonWithRetry(
		messageEndpoint(chat),
		{
			Authorization: `QQBot ${token}`,
			"Content-Type": "application/json",
		},
		JSON.stringify({
			msg_type: 6,
			msg_id: opts.msgId,
			msg_seq: Math.floor(Date.now() / 1000) % 65536,
			input_notify: { input_type: 1, input_second: opts.seconds ?? 60 },
		}),
	);
	const raw = await res.text();
	if (!res.ok) {
		// Best-effort: a failed typing indicator must never break the reply.
		throw new Error(`QQ sendInputNotify failed (${res.status}): ${raw}`);
	}
}

/**
 * Send an image or file attachment (contract 02 §6.2): uploads the local file
 * to /v2/{users|groups}/{openid}/files (multipart form: `file_uuid` = bytes,
 * `file_type` 1 = image, 3 = file), then posts a media message referencing the
 * returned file_uuid ({ content: " ", msg_type: 0, media: { file_uuid } }).
 * All HTTP goes through the global fetch so tests can mock it. Resolves with
 * the created message id; throws with the response body on non-2xx.
 */
export async function sendMedia(
  cfg: QqConfig,
  chat: ChatRef,
  filePath: string,
  kind: "image" | "file",
  opts: SendTextOptions = {},
): Promise<{ id: string }> {
  const token = await getAccessToken(cfg);
  const guildChat = chat.chatKey.startsWith("guild:");
  const kindPath = chat.chatKey.startsWith("group:") || guildChat ? "groups" : "users";
  const uploadTarget = guildChat
    ? `${API_BASE}/channels/${encodeURIComponent(chat.openid)}/files`
    : `${API_BASE}/v2/${kindPath}/${encodeURIComponent(chat.openid)}/files`;
  const fileType = kind === "image" ? 1 : 3;

  const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
  const form = new FormData();
  form.append("file_uuid", new Blob([bytes]), filePath.split(/[\\/]/).pop() ?? "file");
  form.append("file_type", String(fileType));

  const uploadRes = await fetch(
    uploadTarget,
    {
      method: "POST",
      headers: { Authorization: `QQBot ${token}` },
      body: form,
    },
  );
  const uploadRaw = await uploadRes.text();
  if (!uploadRes.ok) {
    throw new Error(`QQ upload file failed (${uploadRes.status}): ${uploadRaw}`);
  }
  let fileUuid = "";
  try {
    const parsed = JSON.parse(uploadRaw) as { file_uuid?: unknown };
    if (typeof parsed.file_uuid === "string") fileUuid = parsed.file_uuid;
  } catch {
    // fall through to the missing-file_uuid error
  }
  if (!fileUuid) {
    throw new Error(`QQ upload file missing file_uuid: ${uploadRaw}`);
  }

  const res = await postJsonWithRetry(
    messageEndpoint(chat),
    {
      Authorization: `QQBot ${token}`,
      "Content-Type": "application/json",
    },
    JSON.stringify({
      content: " ",
      msg_type: 0,
      ...replyFields(opts),
      media: { file_uuid: fileUuid },
    }),
  );
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`QQ sendMedia failed (${res.status}): ${raw}`);
  }
  let id = "";
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id === "string") id = parsed.id;
  } catch {
    // 2xx without a JSON body — an empty id is acceptable
  }
  return { id };
}
