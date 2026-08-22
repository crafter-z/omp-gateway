/**
 * QqGateway — official QQ Bot API v2 WebSocket gateway client.
 *
 * Real protocol (verified against wss://api.sgroup.qq.com/websocket, 2026-08):
 * 1. GET /gateway (Bearer access_token) → { url: "wss://…/websocket" }
 * 2. WS connect (no auth header needed) → server sends op 10 Hello
 *    { d.heartbeat_interval } FIRST
 * 3. Client answers IDENTIFY op 2 with d.token = "QQBot <access_token>"
 *    (the token from getAppAccessToken — NOT appid.secret) or RESUME op 6
 * 4. READY op 0 (d.session_id/user/shard) starts the heartbeat loop and
 *    resolves connect()
 *
 * Dispatch frames are parsed and handed to the injected handler,
 * deduplicated by message id (sliding window of 1000). Connection loss
 * reconnects with exponential backoff 1s→2s→4s→…→60s, reset on READY.
 * The first reconnect after an abnormal close attempts op 6 RESUME with the
 * session id + last dispatch seq; a fresh READY afterwards falls back to
 * normal IDENTIFY on later reconnects. stop() tears everything down and
 * never reconnects.
 *
 * Op-code reference: Hello op 10 (server→client), IDENTIFY op 2,
 * HEARTBEAT op 1, HEARTBEAT_ACK op 11, RESUME op 6, DISPATCH/READY op 0.
 */
import { parseEvent } from "./events.ts";
import type { InboundMessage, QqConfig, QqGatewayOptions } from "./types.ts";
import { isRecord } from "../util/record.ts";

// Event-name constants used by both intents and dispatch routing.
const C2C = "C2C_MESSAGE_CREATE";
const GROUP_AT = "GROUP_AT_MESSAGE_CREATE";
const DIRECT_MESSAGE = "DIRECT_MESSAGE_CREATE";
const INTERACTION = "INTERACTION_CREATE";

const API_BASE = "https://api.sgroup.qq.com";
/** Fallback when GET /gateway fails; the discovered URL normally ends in /websocket. */
const FALLBACK_WS_URL = "wss://api.sgroup.qq.com/websocket";
const DEFAULT_INTENTS = [C2C, GROUP_AT];
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_DEDUP = 1_000;
/** Dedup entries older than this are evicted even when the window is not full. */
const DEDUP_WINDOW_MS = 300_000;
/** Fail the connect attempt when the server's op 10 Hello never arrives. */
const HELLO_TIMEOUT_MS = 10_000;
/** Heartbeats are sent at 80% of the server interval to survive jitter. */
const HEARTBEAT_SAFETY = 0.8;
/** Consecutive disconnects within this window indicate connection flapping. */
const QUICK_DISCONNECT_WINDOW_MS = 15_000;
const MAX_QUICK_DISCONNECT_COUNT = 3;

/**
 * QQ official intent bitmask: C2C and group @ events share the
 * GROUP_AND_C2C_EVENT bucket (bit 25); public guild messages are bit 30;
 * guild direct messages bit 12; button interactions bit 26.
 */
const INTENT_BITS: Record<string, number> = {
  [C2C]: 1 << 25,
  [GROUP_AT]: 1 << 25,
  GROUP_MESSAGE_CREATE: 1 << 25,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  [DIRECT_MESSAGE]: 1 << 12,
  [INTERACTION]: 1 << 26,
};

function computeIntentMask(intents?: string[]): number {
  const list = intents && intents.length > 0 ? intents : DEFAULT_INTENTS;
  let mask = 0;
  for (const name of list) mask |= INTENT_BITS[name] ?? 0;
  return mask === 0 ? 1 << 25 : mask;
}

export class QqGateway {
  private readonly cfg: QqConfig;
  private readonly handler: (m: InboundMessage) => Promise<void>;
  private readonly opts: QqGatewayOptions;
  private readonly intentMask: number;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private ready = false;
  private stopped = false;

  /** Session state for RESUME (op 6): session id from READY, last dispatch seq. */
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  /** One RESUME attempt per abnormal disconnect; reset after a fresh READY. */
  private resumePending = false;

  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: Error) => void) | null = null;

  /** Dedup window: Set lookup + insertion-order queue, FIFO capped at MAX_DEDUP
   *  with time-based eviction (DEDUP_WINDOW_MS). */
  private readonly seenIds = new Set<string>();
  private readonly idQueue: string[] = [];
  private readonly idTimes = new Map<string, number>();
  /** Close timestamps for quick-disconnect (flapping) detection. */
  private readonly closeTimes: number[] = [];
  private flappingLogged = false;

  constructor(
    cfg: QqConfig,
    handler: (m: InboundMessage) => Promise<void>,
    opts: QqGatewayOptions = {},
  ) {
    this.cfg = cfg;
    this.handler = handler;
    this.opts = opts;
    this.intentMask = computeIntentMask(cfg.intents);
  }

  /** True while the socket is READY (heartbeat running). */
  get connected(): boolean {
    return this.ready;
  }

  /**
   * Establish the connection. Resolves once READY is received (heartbeat
   * started); rejects when the gateway is stopped before that happens.
   * Safe to call again while a connection attempt is in flight.
   */
  connect(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("QqGateway is stopped"));
    if (this.connectPromise) return this.connectPromise;
    if (this.ready) return Promise.resolve();
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      if (!this.ws && !this.reconnectTimer) this.openSocket();
    });
    return this.connectPromise;
  }

  /**
   * Stop the gateway: cancel timers, close the current socket and never
   * reconnect. Idempotent.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, "gateway stop");
      } catch {
        // socket already closed
      }
    }
    if (this.rejectConnect) {
      const reject = this.rejectConnect;
      this.rejectConnect = null;
      this.resolveConnect = null;
      this.connectPromise = null;
      reject(new Error("QqGateway stopped before READY"));
    }
  }

  private openSocket(): void {
    void this.openSocketAsync();
  }

  /**
   * Resolve the WS URL (opts.wsUrl override → cfg.ws_url → GET /gateway with
   * the access token → fallback), then connect. Auth happens in-band via the
   * IDENTIFY/RESUME token, not upgrade headers.
   */
  private async openSocketAsync(): Promise<void> {
    let url: string;
    if (this.opts.wsUrl) {
      url = this.opts.wsUrl;
    } else if (this.cfg.ws_url && this.cfg.ws_url.trim() !== "") {
      url = this.cfg.ws_url;
    } else {
      url = await this.discoverGatewayUrl().catch(() => FALLBACK_WS_URL);
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener("open", () => this.onOpen(ws));
    ws.addEventListener("message", (ev) => this.onMessage(ws, ev.data));
    ws.addEventListener("close", () => this.onClose(ws));
    // The close event drives reconnection; error alone needs no action.
    ws.addEventListener("error", () => {});
  }

  /** GET /gateway with a fresh access token; returns the official WS URL. */
  private async discoverGatewayUrl(): Promise<string> {
    if (!this.opts.tokenProvider) return FALLBACK_WS_URL;
    const token = await this.opts.tokenProvider();
    const res = await fetch(`${API_BASE}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
    });
    if (!res.ok) throw new Error(`GET /gateway failed (${res.status})`);
    const body = (await res.json()) as { url?: unknown };
    if (typeof body.url !== "string" || body.url === "") throw new Error("GET /gateway missing url");
    return body.url;
  }

  /**
   * Server speaks first: op 10 Hello { d.heartbeat_interval }. IDENTIFY or
   * RESUME is sent only after Hello arrives (sending earlier is tolerated by
   * some gateways but not guaranteed). The heartbeat interval also comes from
   * Hello — READY no longer carries it.
   */
  private onOpen(ws: WebSocket & { helloSeen?: boolean }): void {
    if (this.ws !== ws) return;
    // Safety net: if Hello never arrives, fail the pending connect so the
    // normal close/backoff cycle takes over.
    setTimeout(() => {
      if (this.ws === ws && !this.ready && !this.stopped && !ws.helloSeen) {
        try {
          ws.close(4000, "hello timeout");
        } catch {
          // already closed
        }
      }
    }, HELLO_TIMEOUT_MS);
  }

  private async sendHandshake(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    const token = this.opts.tokenProvider ? await this.opts.tokenProvider() : "";
    // One RESUME attempt per abnormal disconnect (op 6); afterwards fresh IDENTIFY.
    if (this.resumePending && this.sessionId && this.lastSeq !== null) {
      this.resumePending = false;
      ws.send(
        JSON.stringify({
          op: 6,
          d: {
            token: `QQBot ${token}`,
            session_id: this.sessionId,
            seq: this.lastSeq,
          },
        }),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: this.intentMask,
          shard: [0, 1],
          properties: {
            $os: process.platform,
            $browser: "omp-gateway",
            $device: "omp-gateway",
          },
        },
      }),
    );
  }

  private onMessage(ws: WebSocket & { helloSeen?: boolean }, data: unknown): void {
    if (this.ws !== ws) return;
    let frame: unknown;
    try {
      frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    const op = frame.op;
    if (op === 10) {
      // Hello: server always speaks first. Start heartbeats and identify/resume.
      ws.helloSeen = true;
      const d = isRecord(frame.d) ? frame.d : null;
      const interval = d && typeof d.heartbeat_interval === "number" ? d.heartbeat_interval : 30_000;
      this.startHeartbeat(interval);
      void this.sendHandshake();
      return;
    }
    if (op === 1) {
      // Server heartbeat request → reply immediately.
      this.sendHeartbeat();
      return;
    }
    if (op === 11) return; // HEARTBEAT_ACK
    if (op === 7) {
      // Server Reconnect (load balancing / maintenance): close the socket so
      // the normal close path reconnects with RESUME.
      this.log("server requested reconnect (op 7)");
      try {
        ws.close(4000, "server reconnect");
      } catch {
        // already closing
      }
      return;
    }
    if (op === 9) {
      // Invalid Session: d=true → session resumable; d=false → must re-identify.
      const resumable = frame.d !== false;
      if (!resumable) {
        this.sessionId = null;
        this.lastSeq = null;
        this.resumePending = false;
        this.log("invalid session (op 9, not resumable) — re-identifying");
      } else {
        this.log("invalid session (op 9, resumable)");
      }
      try {
        ws.close(4000, "invalid session");
      } catch {
        // already closing
      }
      return;
    }
    if (op !== 0) return; // not a dispatch frame
    if (typeof frame.s === "number") this.lastSeq = frame.s;
    const t = frame.t;
    if (t === "READY" || t === "RESUMED") {
      this.handleReady(frame);
      return;
    }
    const msg = parseEvent(frame);
    if (!msg) return;
    if (!this.recordId(msg.id)) return;
    // The handler owns its errors (daemon wiring should log/report them);
    // a rejection must not crash the gateway's event loop.
    void this.handler(msg).catch(() => {});
  }

  private handleReady(frame: Record<string, unknown>): void {
    const d = isRecord(frame.d) ? frame.d : null;
    if (typeof d?.session_id === "string") this.sessionId = d.session_id;
    this.backoffMs = INITIAL_BACKOFF_MS; // READY ⇒ healthy connection; reset backoff
    this.ready = true;
    const resolve = this.resolveConnect;
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.connectPromise = null;
    resolve?.();
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.ready = false;
    this.clearHeartbeat();
    this.trackClose();
    if (this.stopped) return;
    // Arm one RESUME attempt for the upcoming reconnect (session id + last seq).
    if (this.sessionId && this.lastSeq !== null) this.resumePending = true;
    this.scheduleReconnect();
  }

  /** Connection-flapping detection: N disconnects inside a short window. */
  private trackClose(): void {
    const now = Date.now();
    this.closeTimes.push(now);
    while (this.closeTimes.length > 0 && now - this.closeTimes[0]! > QUICK_DISCONNECT_WINDOW_MS) {
      this.closeTimes.shift();
    }
    if (this.closeTimes.length >= MAX_QUICK_DISCONNECT_COUNT && !this.flappingLogged) {
      this.flappingLogged = true;
      this.log(`connection flapping: ${this.closeTimes.length} disconnects within ${QUICK_DISCONNECT_WINDOW_MS}ms`);
    } else if (this.closeTimes.length === 0) {
      this.flappingLogged = false;
    }
  }


  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.ws) return;
      this.openSocket();
    }, delay);
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    // Send at 80% of the server interval to survive jitter (hermes parity).
    const safe = Math.max(1_000, Math.round(intervalMs * HEARTBEAT_SAFETY));
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), safe);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // The gateway expects the latest dispatch seq in `d` (or null).
      ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
    }
  }

  /** Returns false when the id is a duplicate within the sliding window. */
  private recordId(id: string): boolean {
    const now = Date.now();
    if (this.seenIds.has(id)) return false;
    this.seenIds.add(id);
    this.idQueue.push(id);
    this.idTimes.set(id, now);
    if (this.idQueue.length > MAX_DEDUP) {
      const oldest = this.idQueue.shift();
      if (oldest !== undefined) {
        this.seenIds.delete(oldest);
        this.idTimes.delete(oldest);
      }
    }
    // Time-based eviction: drop entries older than the window even when the
    // FIFO cap has not been reached (low-traffic sessions otherwise pin stale
    // ids forever).
    if (this.idTimes.size > 0) {
      const cutoff = now - DEDUP_WINDOW_MS;
      let pruned = 0;
      for (const [queued, ts] of this.idTimes) {
        if (ts < cutoff) {
          this.seenIds.delete(queued);
          this.idTimes.delete(queued);
          pruned++;
        }
      }
      if (pruned > 0) {
        // Compact the FIFO by dropping pruned entries from its front.
        let drop = 0;
        while (drop < this.idQueue.length && !this.idTimes.has(this.idQueue[drop]!)) drop++;
        if (drop > 0) this.idQueue.splice(0, drop);
      }
    }
    return true;
  }

  private log(message: string): void {
    // Lightweight internal log; the daemon's own logger sees connection state
    // via the status endpoint. Avoids a logger dependency in the qq module.
    if (this.opts.onLog) this.opts.onLog(message);
  }
}
