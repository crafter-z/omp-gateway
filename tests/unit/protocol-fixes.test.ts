/**
 * Regression tests for the 2026-08 protocol/utility fix batch:
 * - QQ dispatch parsing: voice attachments, file attachments, quoted-message
 *   context (message_type 103), guild chatKey mapping
 * - isSafeUrl SSRF guard, silence marker/narration handling
 * - summarizeFailure classification, DeadTargetRegistry, DeliveryLedger
 *   recovery semantics, scanLifecycleThreat lifecycle guard
 * - QqGateway protocol behavior against the local ws mock: heartbeat `d`
 *   field, op 7 reconnect, op 9 d=false re-identify
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { parseEvent } from "../../src/qq/events.ts";
import { isSafeUrl } from "../../src/util/urlsafe.ts";
import { isAutonomousSilenceResponse, filterSilenceNarration } from "../../src/util/silence.ts";
import { summarizeFailure } from "../../src/util/classify.ts";
import { DeadTargetRegistry, isDeadTargetError } from "../../src/util/deadTargets.ts";
import { DeliveryLedger, MAX_ATTEMPTS } from "../../src/util/deliveryLedger.ts";
import { scanLifecycleThreat } from "../../src/scheduler/preflight.ts";
import { QqGateway } from "../../src/qq/gateway.ts";
import type { InboundMessage } from "../../src/qq/types.ts";
import { createWsServer, type WsServerHandle } from "../fixtures/ws-server.ts";

// ---------------------------------------------------------------------------
// parseEvent
// ---------------------------------------------------------------------------

function c2cFrame(d: Record<string, unknown>): Record<string, unknown> {
  return { t: "C2C_MESSAGE_CREATE", d: { id: "m-1", author: { user_openid: "u1" }, content: "", attachments: [], ...d } };
}

describe("parseEvent attachments", () => {
  test("content_type voice → type voice with asrText and voiceWavUrl carried", () => {
    const msg = parseEvent(
      c2cFrame({
        content: "voice note",
        attachments: [
          {
            content_type: "voice",
            url: "https://x/rec.silk",
            filename: "rec.silk",
            asr_refer_text: "你好",
            voice_wav_url: "https://x/rec.wav",
          },
        ],
      }),
    );
    expect(msg).not.toBeNull();
    expect(msg!.attachments).toEqual([
      { type: "voice", url: "https://x/rec.silk", filename: "rec.silk", asrText: "你好", voiceWavUrl: "https://x/rec.wav" },
    ]);
  });

  test("content_type file with a .wav filename stays a file (no STT misroute)", () => {
    const msg = parseEvent(
      c2cFrame({
        content: "uploaded file",
        attachments: [{ content_type: "file", url: "https://x/rec.wav", filename: "rec.wav" }],
      }),
    );
    expect(msg).not.toBeNull();
    expect(msg!.attachments).toEqual([{ type: "file", url: "https://x/rec.wav", filename: "rec.wav" }]);
  });
});

describe("parseEvent quoted context", () => {
  test("message_type 103 surfaces msg_elements content + image attachments as quoted", () => {
    const msg = parseEvent(
      c2cFrame({
        message_type: 103,
        msg_elements: [
          {
            content: "被引用的消息",
            attachments: [
              { content_type: "image/png", url: "https://x/q.png" },
              { content_type: "application/octet-stream", url: "https://x/q.bin" },
            ],
          },
        ],
      }),
    );
    expect(msg).not.toBeNull();
    expect(msg!.quoted).toEqual({ text: "被引用的消息", images: ["https://x/q.png"] });
  });

  test("image-only quote reply yields the (image) marker", () => {
    const msg = parseEvent(
      c2cFrame({
        message_type: 103,
        msg_elements: [{ content: "", attachments: [{ content_type: "image/png", url: "https://x/i.png" }] }],
      }),
    );
    expect(msg).not.toBeNull();
    expect(msg!.quoted).toEqual({ text: "(image)", images: ["https://x/i.png"] });
  });

  test("non-103 messages carry no quoted context", () => {
    const msg = parseEvent(c2cFrame({ message_type: 2 }));
    expect(msg).not.toBeNull();
    expect(msg!.quoted).toBeUndefined();
  });
});

describe("parseEvent guild messages", () => {
  test("GUILD_MESSAGE_CREATE maps to guild chatKey with author.id", () => {
    const msg = parseEvent({
      t: "GUILD_MESSAGE_CREATE",
      d: { id: "g-1", channel_id: "channel_88", author: { id: "author_99" }, content: "hi", attachments: [] },
    });
    expect(msg).not.toBeNull();
    expect(msg!.chatKey).toBe("guild:channel_88");
    expect(msg!.authorOpenid).toBe("author_99");
  });

  test("GUILD_AT_MESSAGE_CREATE maps the same way", () => {
    const msg = parseEvent({
      t: "GUILD_AT_MESSAGE_CREATE",
      d: { id: "g-2", channel_id: "ch_1", author: { id: "a_2" }, content: "<@!bot>hey", attachments: [] },
    });
    expect(msg).not.toBeNull();
    expect(msg!.chatKey).toBe("guild:ch_1");
    expect(msg!.authorOpenid).toBe("a_2");
  });
});

// ---------------------------------------------------------------------------
// isSafeUrl
// ---------------------------------------------------------------------------

describe("isSafeUrl", () => {
  test("rejects loopback, private, link-local and non-http schemes", () => {
    for (const bad of [
      "http://localhost",
      "http://localhost:8080/x",
      "http://127.0.0.1",
      "http://10.0.0.1",
      "http://[::1]",
      "http://192.168.1.1",
      "http://169.254.1.1",
      "ftp://x",
      "file:///etc/passwd",
    ]) {
      expect(isSafeUrl(bad)).toBe(false);
    }
  });

  test("allows public https hosts", () => {
    expect(isSafeUrl("https://multimedia.nt.qq.com.cn/x.png")).toBe(true);
    expect(isSafeUrl("https://example.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// silence handling
// ---------------------------------------------------------------------------

describe("isAutonomousSilenceResponse", () => {
  test("bracketed marker as the whole response is silent", () => {
    expect(isAutonomousSilenceResponse("[SILENT]")).toBe(true);
    expect(isAutonomousSilenceResponse("[NO_REPLY]")).toBe(true);
  });

  test("bare SILENT as the last line is silent", () => {
    expect(isAutonomousSilenceResponse("SILENT")).toBe(true);
    expect(isAutonomousSilenceResponse("Here is my answer\nSILENT")).toBe(true);
    expect(isAutonomousSilenceResponse("text\n[SILENT]")).toBe(true);
  });

  test("mid-sentence occurrences are not treated as silent", () => {
    expect(isAutonomousSilenceResponse("say [SILENT] now")).toBe(false);
    expect(isAutonomousSilenceResponse("I am SILENT about this")).toBe(false);
  });
});

describe("filterSilenceNarration", () => {
  test("drops hallucinated silence tokens", () => {
    expect(filterSilenceNarration("*(silent)*")).toBe("");
    expect(filterSilenceNarration("🔇")).toBe("");
  });

  test("drops bare-dot lines", () => {
    expect(filterSilenceNarration("...")).toBe("");
    expect(filterSilenceNarration("a\n.\nb")).toBe("ab");
  });
});

// ---------------------------------------------------------------------------
// summarizeFailure
// ---------------------------------------------------------------------------

describe("summarizeFailure", () => {
  test("classifies rate limits", () => {
    expect(summarizeFailure("Rate limit exceeded (429)", "job").kind).toBe("rate_limit");
  });

  test("classifies timeouts", () => {
    expect(summarizeFailure("request timed out", "job").kind).toBe("timeout");
  });

  test("classifies auth failures", () => {
    expect(summarizeFailure("401 unauthorized", "job").kind).toBe("auth");
  });

  test("generic failures keep a snippet and stay within 180 chars", () => {
    const s = summarizeFailure("Something weird happened", "job");
    expect(s.kind).toBe("generic");
    expect(s.message).toContain("Something weird happened");
    expect(s.message.length).toBeLessThanOrEqual(180);

    const long = summarizeFailure("x".repeat(400), "very-long-job-name-".repeat(10));
    expect(long.kind).toBe("generic");
    expect(long.message.length).toBeLessThanOrEqual(180);
    expect(long.message.endsWith("...")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DeadTargetRegistry
// ---------------------------------------------------------------------------

describe("DeadTargetRegistry", () => {
  test("isDead → markDead → isDead → clear lifecycle", () => {
    const db = new Database(":memory:");
    const reg = new DeadTargetRegistry(db);
    expect(reg.isDead("group:1")).toBe(false);
    reg.markDead("group:1", "bot is not in the group");
    expect(reg.isDead("group:1")).toBe(true);
    reg.clear("group:1");
    expect(reg.isDead("group:1")).toBe(false);
    db.close();
  });

  test("isDeadTargetError only matches unreachable-chat hints", () => {
    expect(isDeadTargetError("bot is not in the group")).toBe(true);
    expect(isDeadTargetError("network error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DeliveryLedger
// ---------------------------------------------------------------------------

/** Backdate a row past the default 24h sweep window to simulate a crash-stale row. */
function backdate(db: Database, id: string): void {
  db.run("UPDATE deliveries SET updated_at = ? WHERE id = ?", [new Date(Date.now() - 25 * 3600_000).toISOString(), id]);
}

describe("DeliveryLedger", () => {
  test("record → sweepRecoverable returns the pending obligation unrecovered", () => {
    const db = new Database(":memory:");
    const ledger = new DeliveryLedger(db);
    const id = ledger.record("group:1", "hello")!;
    expect(id).toBeTruthy();
    backdate(db, id);
    const recovered = ledger.sweepRecoverable();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id, chatKey: "group:1", text: "hello", recovered: false });
    db.close();
  });

  test("attempting rows sweep with recovered=true", () => {
    const db = new Database(":memory:");
    const ledger = new DeliveryLedger(db);
    const id = ledger.record("group:1", "hello")!;
    ledger.markAttempting(id);
    backdate(db, id);
    const recovered = ledger.sweepRecoverable();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id, recovered: true });
    db.close();
  });

  test("delivered rows are terminal and never sweeped", () => {
    const db = new Database(":memory:");
    const ledger = new DeliveryLedger(db);
    const id = ledger.record("group:1", "hello")!;
    ledger.markAttempting(id);
    ledger.markDelivered(id);
    backdate(db, id);
    expect(ledger.sweepRecoverable()).toEqual([]);
    db.close();
  });

  test("failed rows retry below MAX_ATTEMPTS and are excluded once exhausted", () => {
    expect(MAX_ATTEMPTS).toBe(3);
    const db = new Database(":memory:");
    const ledger = new DeliveryLedger(db);
    const id = ledger.record("group:1", "hello")!;
    ledger.markAttempting(id);
    ledger.markFailed(id, "boom");
    backdate(db, id);
    expect(ledger.sweepRecoverable()).toHaveLength(1); // 1 failure → retry allowed
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      ledger.markAttempting(id);
      ledger.markFailed(id, `boom ${i + 1}`);
    }
    backdate(db, id);
    expect(ledger.sweepRecoverable()).toEqual([]); // MAX_ATTEMPTS failures → exhausted
    db.close();
  });
});

// ---------------------------------------------------------------------------
// scanLifecycleThreat
// ---------------------------------------------------------------------------

describe("scanLifecycleThreat", () => {
  test("flags kill/terminate commands targeting the gateway", () => {
    expect(scanLifecycleThreat("taskkill /PID 123 omp-gateway")).not.toBeNull();
    expect(scanLifecycleThreat("pkill -f omp-gateway")).not.toBeNull();
  });

  test("flags gateway start/stop/restart subcommands", () => {
    expect(scanLifecycleThreat("omp-gateway stop")).not.toBeNull();
    expect(scanLifecycleThreat("omp-gateway restart")).not.toBeNull();
  });

  test("passes harmless text", () => {
    expect(scanLifecycleThreat("echo hello")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// QqGateway protocol behavior (mock ws server)
// ---------------------------------------------------------------------------

const CFG = { app_id: "test-app", app_secret: "test-secret" };
const DEFAULT_OPENID = "user_openid_001";

const openGateways: QqGateway[] = [];
const openServers: WsServerHandle[] = [];

afterEach(async () => {
  for (const gw of openGateways.splice(0)) await gw.stop();
  for (const s of openServers.splice(0)) await s.close();
});

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
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
): void {
  h.pushEvent(ws, "C2C_MESSAGE_CREATE", {
    id,
    author: { user_openid: DEFAULT_OPENID },
    content,
    attachments: [],
    timestamp: Date.now(),
  });
}

describe("QqGateway protocol fixes", () => {
  // These tests deliberately exercise real timer behavior (heartbeat interval,
  // reconnect backoff) against the platform clock via the mock ws server;
  // fake timers cannot drive the gateway's own setInterval/setTimeout paths,
  // so polling waitFor is used instead of guessed fixed sleeps.
  test("heartbeat frames after READY carry the dispatch seq in d", async () => {
    const h = await createWsServer({ heartbeatInterval: 1200 });
    openServers.push(h);
    await startGateway(async () => {}, h.url);

    pushC2C(h, firstSocket(h), "hb-1", "hi");
    await waitFor(() => h.frames.some((f) => f.op === 1 && typeof f.d === "number"));

    const hb = h.frames.find((f) => f.op === 1 && typeof f.d === "number")!;
    expect(hb.d).toBeGreaterThan(0);
  });

  test("op 7 Reconnect closes the socket and reconnects", async () => {
    const h = await createWsServer();
    openServers.push(h);
    const seen: InboundMessage[] = [];
    await startGateway(async (m) => {
      seen.push(m);
    }, h.url);

    const old = firstSocket(h);
    pushC2C(h, old, "r-1", "pre");
    await waitFor(() => seen.length === 1);

    old.send(JSON.stringify({ op: 7, d: null })); // server requests reconnect
    await waitFor(() => h.sockets.size === 1 && firstSocket(h) !== old);

    pushC2C(h, firstSocket(h), "r-2", "post");
    await waitFor(() => seen.length === 2);
    expect(seen[1]!.text).toBe("post");
  });

  test("op 9 d=false clears session state; reconnect sends IDENTIFY not RESUME", async () => {
    const h = await createWsServer();
    openServers.push(h);
    const seen: InboundMessage[] = [];
    await startGateway(async (m) => {
      seen.push(m);
    }, h.url);

    // Establish session state (session id + last seq) so a normal abnormal
    // close would have armed a RESUME on reconnect.
    const old = firstSocket(h);
    pushC2C(h, old, "s-1", "seq");
    await waitFor(() => seen.length === 1);

    old.send(JSON.stringify({ op: 9, d: false })); // invalid session, not resumable
    await waitFor(
      () =>
        h.sockets.size === 1 &&
        firstSocket(h) !== old &&
        h.frames.filter((f) => f.op === 2).length === 2,
    );

    expect(h.frames.filter((f) => f.op === 6)).toHaveLength(0); // never RESUME
    expect(h.lastIdentify?.op).toBe(2);
    expect(h.lastResume).toBeNull();
  });
});
