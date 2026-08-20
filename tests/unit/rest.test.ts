/**
 * Unit tests for the QQ REST client (rest.ts) using a global fetch mock.
 * Verifies token acquisition + caching and sendText URL/body/headers.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAccessTokenCache, sendText } from "../../src/qq/rest.ts";
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
      "https://apps.q.qq.com/app/getAppAccessToken",
      "https://api.q.qq.com/v2/users/u1/messages",
    ]);
    expect(bodyOf(fetchCalls[0])).toEqual({ appId: "app-1", clientSecret: "sec-1" });
    expect(bodyOf(fetchCalls[1])).toEqual({ content: "hi there", msg_type: 0 });
    expect(fetchCalls[1].init?.headers).toMatchObject({ Authorization: "QQBot tok-123" });
  });

  test("routes group chats to /v2/groups/{group_openid}/messages", async () => {
    const res = await sendText(CFG, { chatKey: "group:g9", openid: "g9" }, "yo");
    expect(fetchCalls[1].url).toBe("https://api.q.qq.com/v2/groups/g9/messages");
    expect(res.id).toBe("send-ok-1");
  });

  test("honors portal_host and echoes msg_id for passive replies", async () => {
    const cfg: QqConfig = { app_id: "app-1", app_secret: "sec-1", portal_host: "sandbox.q.qq.com" };
    await sendText(cfg, { chatKey: "c2c:u1", openid: "u1" }, "reply", { msgId: "in-99" });
    expect(fetchCalls[0].url).toBe("https://apps.sandbox.q.qq.com/app/getAppAccessToken");
    expect(fetchCalls[1].url).toBe("https://api.sandbox.q.qq.com/v2/users/u1/messages");
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
