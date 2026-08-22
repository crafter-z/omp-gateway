/**
 * Unit tests for the QQ REST client (rest.ts) using a global fetch mock.
 * Verifies token acquisition + caching, sendText URL/body/headers, and
 * sendMedia's upload-then-message flow.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resetAccessTokenCache, sendMedia, sendText } from "../../src/qq/rest.ts";
import type { ChatRef, QqConfig } from "../../src/qq/types.ts";

const CFG: QqConfig = { app_id: "app-1", app_secret: "sec-1" };
const realFetch = globalThis.fetch;

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
/** expires_in returned by the mocked token endpoint (per-test override). */
let tokenExpiresIn = 7200;
/** body returned by the mocked message endpoint (per-test override). */
let sendStatus: { status: number; body: unknown } = { status: 200, body: { id: "send-ok-1" } };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  resetAccessTokenCache();
  fetchCalls = [];
  tokenExpiresIn = 7200;
  sendStatus = { status: 200, body: { id: "send-ok-1" } };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init });
    if (url.includes("/app/getAppAccessToken")) {
      return jsonResponse({ access_token: "tok-123", expires_in: tokenExpiresIn });
    }
    return jsonResponse(sendStatus.body, sendStatus.status);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function bodyOf(call: { init?: RequestInit }): unknown {
  return JSON.parse(String(call.init?.body));
}

describe("sendText", () => {
  test("fetches token then posts to /v2/users/{openid}/messages with QQBot auth", async () => {
    const chat: ChatRef = { chatKey: "c2c:u1", openid: "u1" };
    const res = await sendText(CFG, chat, "hi there");

    expect(res).toEqual({ id: "send-ok-1" });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://bots.qq.com/app/getAppAccessToken",
      "https://api.sgroup.qq.com/v2/users/u1/messages",
    ]);
    expect(bodyOf(fetchCalls[0])).toEqual({ appId: "app-1", clientSecret: "sec-1" });
    expect(bodyOf(fetchCalls[1])).toEqual({ content: "hi there", msg_type: 0 });
    expect(fetchCalls[1].init?.headers).toMatchObject({ Authorization: "QQBot tok-123" });
  });

  test("routes group chats to /v2/groups/{group_openid}/messages", async () => {
    const res = await sendText(CFG, { chatKey: "group:g9", openid: "g9" }, "yo");
    expect(fetchCalls[1].url).toBe("https://api.sgroup.qq.com/v2/groups/g9/messages");
    expect(res.id).toBe("send-ok-1");
  });

  test("API base is api.sgroup.qq.com regardless of portal_host; echoes msg_id for passive replies", async () => {
    const cfg: QqConfig = { app_id: "app-1", app_secret: "sec-1", portal_host: "sandbox.q.qq.com" };
    await sendText(cfg, { chatKey: "c2c:u1", openid: "u1" }, "reply", { msgId: "in-99" });
    expect(fetchCalls[0].url).toBe("https://bots.qq.com/app/getAppAccessToken");
    expect(fetchCalls[1].url).toBe("https://api.sgroup.qq.com/v2/users/u1/messages");
    expect(bodyOf(fetchCalls[1])).toEqual({ content: "reply", msg_type: 0, msg_id: "in-99" });
  });

  test("caches the access token across sends", async () => {
    await sendText(CFG, { chatKey: "c2c:u1", openid: "u1" }, "a");
    await sendText(CFG, { chatKey: "c2c:u1", openid: "u1" }, "b");
    const tokenCalls = fetchCalls.filter((c) => c.url.includes("/app/getAppAccessToken"));
    expect(tokenCalls).toHaveLength(1);
  });

  test("refetches the token once it is inside the 60s refresh skew", async () => {
    tokenExpiresIn = 1; // expires in 1s → immediately within the refresh window
    await sendText(CFG, { chatKey: "c2c:u1", openid: "u1" }, "a");
    await sendText(CFG, { chatKey: "c2c:u1", openid: "u1" }, "b");
    const tokenCalls = fetchCalls.filter((c) => c.url.includes("/app/getAppAccessToken"));
    expect(tokenCalls).toHaveLength(2);
  });

  test("throws with the response body on non-2xx send", async () => {
    sendStatus = { status: 400, body: { code: 9, message: "bad request" } };
    await expect(sendText(CFG, { chatKey: "c2c:u1", openid: "u1" }, "x")).rejects.toThrow(/400.*bad request/);
  });

  test("surfaces token fetch failures", async () => {
    globalThis.fetch = mock(async () => {
      return jsonResponse({ message: "invalid app secret" }, 401);
    }) as unknown as typeof fetch;
    await expect(sendText(CFG, { chatKey: "c2c:u1", openid: "u1" }, "x")).rejects.toThrow(
      /getAppAccessToken failed \(401\)/,
    );
  });
});

describe("sendMedia", () => {
  const MEDIA_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  let tmpFile: string | null = null;

  afterEach(async () => {
    if (tmpFile) {
      await unlink(tmpFile).catch(() => {});
      tmpFile = null;
    }
  });

  function makeMediaFile(): string {
    tmpFile = join(tmpdir(), `omp-gw-rest-media-${crypto.randomUUID()}.png`);
    return tmpFile;
  }

  /** Happy-path mock: token → upload (file_uuid) → message (id). */
  function mediaMock() {
    return mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push({ url, init });
      if (url.includes("/app/getAppAccessToken")) {
        return jsonResponse({ access_token: "tok-123", expires_in: 7200 });
      }
      if (url.includes("/files")) return jsonResponse({ file_uuid: "uuid-1" });
      return jsonResponse({ id: "media-msg-1" });
    }) as unknown as typeof fetch;
  }

  test("uploads image file then posts media message", async () => {
    const filePath = makeMediaFile();
    await Bun.write(filePath, MEDIA_BYTES);
    globalThis.fetch = mediaMock();

    const res = await sendMedia(CFG, { chatKey: "c2c:u1", openid: "u1" }, filePath, "image");

    expect(res).toEqual({ id: "media-msg-1" });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://bots.qq.com/app/getAppAccessToken",
      "https://api.sgroup.qq.com/v2/users/u1/files",
      "https://api.sgroup.qq.com/v2/users/u1/messages",
    ]);
    // upload: multipart form with the raw bytes + file_type 1
    const upload = fetchCalls[1]!;
    expect(upload.init?.method).toBe("POST");
    expect(upload.init?.headers).toMatchObject({ Authorization: "QQBot tok-123" });
    const form = upload.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("file_type")).toBe("1");
    const filePart = form.get("file_uuid") as File;
    expect(filePart.name).toBe(basename(filePath));
    expect(new Uint8Array(await filePart.arrayBuffer())).toEqual(MEDIA_BYTES);
    // message: media reference
    expect(bodyOf(fetchCalls[2]!)).toEqual({ content: " ", msg_type: 0, media: { file_uuid: "uuid-1" } });
  });

  test("routes group uploads to /v2/groups/{gid}/files", async () => {
    const filePath = makeMediaFile();
    await Bun.write(filePath, MEDIA_BYTES);
    globalThis.fetch = mediaMock();

    const res = await sendMedia(CFG, { chatKey: "group:g9", openid: "g9" }, filePath, "image");
    expect(res.id).toBe("media-msg-1");
    expect(fetchCalls[1]!.url).toBe("https://api.sgroup.qq.com/v2/groups/g9/files");
    expect(fetchCalls[2]!.url).toBe("https://api.sgroup.qq.com/v2/groups/g9/messages");
  });

  test("file kind uploads with file_type 3", async () => {
    const filePath = makeMediaFile();
    await Bun.write(filePath, MEDIA_BYTES);
    globalThis.fetch = mediaMock();

    await sendMedia(CFG, { chatKey: "c2c:u1", openid: "u1" }, filePath, "file");
    const form = fetchCalls[1]!.init?.body as FormData;
    expect(form.get("file_type")).toBe("3");
  });

  test("echoes msg_id on the media message", async () => {
    const filePath = makeMediaFile();
    await Bun.write(filePath, MEDIA_BYTES);
    globalThis.fetch = mediaMock();

    await sendMedia(CFG, { chatKey: "c2c:u1", openid: "u1" }, filePath, "image", { msgId: "in-7" });
    expect(bodyOf(fetchCalls[2]!)).toEqual({
      content: " ",
      msg_type: 0,
      msg_id: "in-7",
      media: { file_uuid: "uuid-1" },
    });
  });

  test("media upload and message calls use the api.sgroup.qq.com base regardless of portal_host", async () => {
    const filePath = makeMediaFile();
    await Bun.write(filePath, MEDIA_BYTES);
    const cfg: QqConfig = { app_id: "app-1", app_secret: "sec-1", portal_host: "sandbox.q.qq.com" };
    globalThis.fetch = mediaMock();

    await sendMedia(cfg, { chatKey: "c2c:u1", openid: "u1" }, filePath, "image");
    expect(fetchCalls[1]!.url).toBe("https://api.sgroup.qq.com/v2/users/u1/files");
    expect(fetchCalls[2]!.url).toBe("https://api.sgroup.qq.com/v2/users/u1/messages");
  });

  test("throws with the response body when the upload fails", async () => {
    const filePath = makeMediaFile();
    await Bun.write(filePath, MEDIA_BYTES);
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push({ url });
      if (url.includes("/app/getAppAccessToken")) {
        return jsonResponse({ access_token: "tok-123", expires_in: 7200 });
      }
      return jsonResponse({ code: 9, message: "upload refused" }, 400);
    }) as unknown as typeof fetch;

    await expect(sendMedia(CFG, { chatKey: "c2c:u1", openid: "u1" }, filePath, "image")).rejects.toThrow(
      /400.*upload refused/,
    );
    expect(fetchCalls).toHaveLength(2); // token + failed upload, no message call
  });

  test("throws when the upload response lacks file_uuid", async () => {
    const filePath = makeMediaFile();
    await Bun.write(filePath, MEDIA_BYTES);
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push({ url });
      if (url.includes("/app/getAppAccessToken")) {
        return jsonResponse({ access_token: "tok-123", expires_in: 7200 });
      }
      return jsonResponse({ id: "not-a-file-uuid" });
    }) as unknown as typeof fetch;

    await expect(sendMedia(CFG, { chatKey: "c2c:u1", openid: "u1" }, filePath, "image")).rejects.toThrow(
      /file_uuid/,
    );
    expect(fetchCalls).toHaveLength(2);
  });

  test("throws when the media message call fails", async () => {
    const filePath = makeMediaFile();
    await Bun.write(filePath, MEDIA_BYTES);
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push({ url });
      if (url.includes("/app/getAppAccessToken")) {
        return jsonResponse({ access_token: "tok-123", expires_in: 7200 });
      }
      if (url.includes("/files")) return jsonResponse({ file_uuid: "uuid-1" });
      return jsonResponse({ code: 50012, message: "media denied" }, 403);
    }) as unknown as typeof fetch;

    await expect(sendMedia(CFG, { chatKey: "c2c:u1", openid: "u1" }, filePath, "image")).rejects.toThrow(
      /403.*media denied/,
    );
    expect(fetchCalls).toHaveLength(3);
  });
});
