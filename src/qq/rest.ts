/**
 * QQ outbound REST API (official QQ Bot API v2).
 *
 * App access token is fetched once per process and cached until it is within
 * 60s of expiring (module-level singleton; resetAccessTokenCache exists for
 * tests / config reload). sendText posts a plain-text (msg_type 0) message to
 * /v2/users|groups/{openid}/messages, choosing the path from the chatKey
 * prefix. All HTTP goes through the global fetch so tests can mock it.
 */
import type { ChatRef, QqConfig } from "./types.ts";

const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 7200;

let cachedToken: string | null = null;
let tokenExpiresAtMs = 0;
let tokenFetch: Promise<string> | null = null;

/** Reset the module-level token cache (tests / config reload). */
export function resetAccessTokenCache(): void {
  cachedToken = null;
  tokenExpiresAtMs = 0;
  tokenFetch = null;
}

function portalHost(cfg: QqConfig): string {
  return cfg.portal_host ?? "q.qq.com";
}

/**
 * Return a valid app access token, fetching (and caching) one when missing
 * or within {@link TOKEN_REFRESH_SKEW_MS} of expiry. Concurrent callers
 * share a single in-flight fetch.
 */
export async function getAccessToken(cfg: QqConfig): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAtMs - TOKEN_REFRESH_SKEW_MS) {
    return cachedToken;
  }
  if (tokenFetch) return tokenFetch;
  tokenFetch = (async () => {
    const res = await fetch(`https://apps.${portalHost(cfg)}/app/getAppAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: cfg.app_id, clientSecret: cfg.app_secret }),
    });
    const body = (await res.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!res.ok || !body || typeof body.access_token !== "string") {
      throw new Error(`QQ getAppAccessToken failed (${res.status}): ${JSON.stringify(body)}`);
    }
    cachedToken = body.access_token;
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    tokenExpiresAtMs = Date.now() + expiresIn * 1000;
    return cachedToken;
  })().finally(() => {
    tokenFetch = null;
  });
  return tokenFetch;
}

export interface SendTextOptions {
  /** Echo the inbound message id (msg_id) when replying passively. */
  msgId?: string;
}

/**
 * Send a plain-text (msg_type 0) message to a c2c user or a group.
 * Resolves with the created message id; throws with the response body
 * included on non-2xx responses.
 */
export async function sendText(
  cfg: QqConfig,
  chat: ChatRef,
  text: string,
  opts: SendTextOptions = {},
): Promise<{ id: string }> {
  const token = await getAccessToken(cfg);
  const kind = chat.chatKey.startsWith("group:") ? "groups" : "users";
  const res = await fetch(
    `https://api.${portalHost(cfg)}/v2/${kind}/${encodeURIComponent(chat.openid)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: text,
        msg_type: 0,
        ...(opts.msgId ? { msg_id: opts.msgId } : {}),
      }),
    },
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
  const kindPath = chat.chatKey.startsWith("group:") ? "groups" : "users";
  const fileType = kind === "image" ? 1 : 3;

  const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
  const form = new FormData();
  form.append("file_uuid", new Blob([bytes]), filePath.split(/[\\/]/).pop() ?? "file");
  form.append("file_type", String(fileType));

  const uploadRes = await fetch(
    `https://api.${portalHost(cfg)}/v2/${kindPath}/${encodeURIComponent(chat.openid)}/files`,
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

  const res = await fetch(
    `https://api.${portalHost(cfg)}/v2/${kindPath}/${encodeURIComponent(chat.openid)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: " ",
        msg_type: 0,
        ...(opts.msgId ? { msg_id: opts.msgId } : {}),
        media: { file_uuid: fileUuid },
      }),
    },
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
