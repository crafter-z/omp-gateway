/**
 * Integration tests: QqGateway ↔ local QQ gateway mock (tests/fixtures/ws-server.ts).
 *
 * Covers the handshake (IDENTIFY/READY), dispatch delivery with normalization,
 * message-id dedup, exponential-backoff reconnection after a dropped
 * connection, and stop() permanently cancelling reconnection.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createWsServer, type WsServerHandle } from "../fixtures/ws-server.ts";
import { QqGateway } from "../../src/qq/gateway.ts";
import type { InboundMessage } from "../../src/qq/types.ts";

const CFG = { app_id: "test-app", app_secret: "test-secret" };
const DEFAULT_OPENID = "user_openid_001";

const openGateways: QqGateway[] = [];
const openServers: WsServerHandle[] = [];

afterEach(async () => {
  for (const gw of openGateways.splice(0)) await gw.stop();
  for (const s of openServers.splice(0)) await s.close();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await delay(stepMs);
  }
}

function firstSocket(h: WsServerHandle): ServerWebSocket<undefined> {
  const ws = h.sockets.values().next().value;
  if (!ws) throw new Error("no active socket");
  return ws;
}

async function startGateway(
  handler: (m: InboundMessage) => Promise<void>,
  url: string,
): Promise<QqGateway> {
  const gw = new QqGateway(CFG, handler, { wsUrl: url });
  openGateways.push(gw);
  await gw.connect();
  return gw;
}

function pushC2C(
  h: WsServerHandle,
  ws: ServerWebSocket<undefined>,
  id: string,
  content: string,
  extra: Record<string, unknown> = {},
): void {
  h.pushEvent(ws, "C2C_MESSAGE_CREATE", {
    id,
    author: { user_openid: DEFAULT_OPENID },
    content,
    attachments: [],
    timestamp: Date.now(),
    ...extra,
  });
}

describe("QqGateway", () => {
  test("connect resolves on READY; handshake frames never reach the handler", async () => {
    const h = await createWsServer();
    openServers.push(h);
    const seen: InboundMessage[] = [];
    await startGateway(async (m) => {
      seen.push(m);
    }, h.url);

    expect(h.sockets.size).toBe(1);
    await delay(60); // no dispatch frames were pushed
    expect(seen).toHaveLength(0);
  });

  test("sends QQBot Authorization and X-Union-Appid headers on upgrade", async () => {
    const h = await createWsServer({ requireAuth: true });
    openServers.push(h);
    await startGateway(async () => {}, h.url);

    expect(h.sockets.size).toBe(1);
    expect(h.lastHeaders?.authorization).toBe("QQBot test-app.test-secret");
    expect(h.lastHeaders?.xUnionAppid).toBe("test-app");
  });

  test("C2C_MESSAGE_CREATE dispatch reaches the handler with normalized fields", async () => {
    const h = await createWsServer();
    openServers.push(h);
    const seen: InboundMessage[] = [];
    await startGateway(async (m) => {
      seen.push(m);
    }, h.url);

    pushC2C(h, firstSocket(h), "msg-1", "<@!bot123>hello world");
    await waitFor(() => seen.length === 1);

    expect(seen[0]).toMatchObject({
      id: "msg-1",
      chatKey: "c2c:user_openid_001",
      authorOpenid: "user_openid_001",
      text: "hello world",
    });
    expect(seen[0].attachments).toEqual([]);
  });

  test("GROUP_AT_MESSAGE_CREATE maps to group chatKey with member openid", async () => {
    const h = await createWsServer();
    openServers.push(h);
    const seen: InboundMessage[] = [];
    await startGateway(async (m) => {
      seen.push(m);
    }, h.url);

    h.pushEvent(firstSocket(h), "GROUP_AT_MESSAGE_CREATE", {
      id: "g-msg-1",
      author: { member_openid: "member_42", bot_openid: "bot_1" },
      group_openid: "group_777",
      content: "<@!bot_1>hello group",
      attachments: [],
      timestamp: Date.now(),
    });
    await waitFor(() => seen.length === 1);

    expect(seen[0]).toMatchObject({
      id: "g-msg-1",
      chatKey: "group:group_777",
      authorOpenid: "member_42",
      text: "hello group",
    });
  });

  test("attachments normalize by content_type and carry asr text", async () => {
    const h = await createWsServer();
    openServers.push(h);
    const seen: InboundMessage[] = [];
    await startGateway(async (m) => {
      seen.push(m);
    }, h.url);

    pushC2C(h, firstSocket(h), "msg-att", "look", {
      attachments: [
        { content_type: "image/png", url: "https://x/img.png" },
        { content_type: "audio/mp3", url: "https://x/v.mp3", asr_refer_text: "转写文本" },
        { content_type: "application/octet-stream", url: "https://x/f.bin" },
      ],
    });
    await waitFor(() => seen.length === 1);

    expect(seen[0].attachments).toEqual([
      { type: "image", url: "https://x/img.png" },
      { type: "voice", url: "https://x/v.mp3", asrText: "转写文本" },
      { type: "file", url: "https://x/f.bin" },
    ]);
  });

  test("duplicate event id is delivered to the handler only once", async () => {
    const h = await createWsServer();
    openServers.push(h);
    const seen: InboundMessage[] = [];
    await startGateway(async (m) => {
      seen.push(m);
    }, h.url);

    const ws = firstSocket(h);
    pushC2C(h, ws, "dup-1", "first");
    await waitFor(() => seen.length === 1);
    pushC2C(h, ws, "dup-1", "second");
    await delay(120);

    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe("first");
  });

  test("reconnects with backoff after the server drops the connection", async () => {
    const h = await createWsServer();
    openServers.push(h);
    const seen: InboundMessage[] = [];
    await startGateway(async (m) => {
      seen.push(m);
    }, h.url);
    expect(h.sockets.size).toBe(1);

    const old = firstSocket(h);
    h.kill(old);
    // Backoff starts at 1s; the reconnect must bring a fresh socket.
    await waitFor(() => h.sockets.size === 1 && firstSocket(h) !== old);

    pushC2C(h, firstSocket(h), "after-reconnect", "back");
    await waitFor(() => seen.length === 1);
    expect(seen[0].text).toBe("back");
  });

  test("stop cancels reconnection", async () => {
    const h = await createWsServer();
    openServers.push(h);
    let calls = 0;
    const gw = await startGateway(async () => {
      calls++;
    }, h.url);
    expect(h.sockets.size).toBe(1);

    h.kill(firstSocket(h));
    await delay(150); // let the client observe the close and arm the 1s backoff
    await gw.stop();
    await delay(1600); // longer than the first backoff would have been

    expect(h.sockets.size).toBe(0);
    expect(calls).toBe(0);
  });
});
