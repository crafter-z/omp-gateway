/**
 * QqGateway — official QQ Bot API v2 WebSocket gateway client.
 *
 * Lifecycle: connect() → TCP/WS open → IDENTIFY (op 2) → READY (op 0,
 * t "READY", d.heartbeat_interval) starts the heartbeat loop and resolves
 * connect(). Dispatch frames (op 0 with t C2C_MESSAGE_CREATE /
 * GROUP_AT_MESSAGE_CREATE) are parsed and handed to the injected handler,
 * deduplicated by message id (sliding window of 1000). Connection loss
 * reconnects with exponential backoff 1s→2s→4s→…→60s, reset on READY.
 * stop() tears everything down and never reconnects.
 *
 * Op-code reference (QQ official protocol): IDENTIFY op 2 (d.token =
 * "QQBot <appid>.<secret>"), HEARTBEAT op 1, HEARTBEAT_ACK op 11,
 * READY / DISPATCH op 0 (t on dispatch frames).
 */
import { parseEvent } from "./events.ts";
import type { InboundMessage, QqConfig, QqGatewayOptions } from "./types.ts";

// Event-name constants used by both intents and dispatch routing.
const C2C = "C2C_MESSAGE_CREATE";
const GROUP_AT = "GROUP_AT_MESSAGE_CREATE";

const DEFAULT_WS_URL = "wss://api.sgroup.qq.com/";
const DEFAULT_INTENTS = [C2C, GROUP_AT];
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_DEDUP = 1_000;

/**
 * QQ official intent bitmask: C2C and group @ events share the
 * GROUP_AND_C2C_EVENT bucket (bit 25); public guild messages are bit 30.
 */
const INTENT_BITS: Record<string, number> = {
  [C2C]: 1 << 25,
  [GROUP_AT]: 1 << 25,
  GROUP_MESSAGE_CREATE: 1 << 25,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

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

  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: Error) => void) | null = null;

  /** Dedup window: Set lookup + insertion-order queue, FIFO capped at MAX_DEDUP. */
  private readonly seenIds = new Set<string>();
  private readonly idQueue: string[] = [];

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
    const url = this.opts.wsUrl ?? DEFAULT_WS_URL;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `QQBot ${this.cfg.app_id}.${this.cfg.app_secret}`,
        "X-Union-Appid": this.cfg.app_id,
      },
    });
    this.ws = ws;
    ws.addEventListener("open", () => this.onOpen(ws));
    ws.addEventListener("message", (ev) => this.onMessage(ws, ev.data));
    ws.addEventListener("close", () => this.onClose(ws));
    // The close event drives reconnection; error alone needs no action.
    ws.addEventListener("error", () => {});
  }

  private onOpen(ws: WebSocket): void {
    if (this.ws !== ws) return;
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${this.cfg.app_id}.${this.cfg.app_secret}`,
          intents: this.intentMask,
          shard: [0, 1],
        },
      }),
    );
  }

  private onMessage(ws: WebSocket, data: unknown): void {
    if (this.ws !== ws) return;
    let frame: unknown;
    try {
      frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    const op = frame.op;
    if (op === 1) {
      // Server heartbeat request → reply immediately.
      this.sendHeartbeat();
      return;
    }
    if (op === 11) return; // HEARTBEAT_ACK
    if (op !== 0) return; // not a dispatch frame
    const t = frame.t;
    if (t === "READY") {
      this.handleReady(frame);
      return;
    }
    if (t === "RESUMED") return;
    const msg = parseEvent(frame);
    if (!msg) return;
    if (!this.recordId(msg.id)) return;
    // The handler owns its errors (daemon wiring should log/report them);
    // a rejection must not crash the gateway's event loop.
    void this.handler(msg).catch(() => {});
  }

  private handleReady(frame: Record<string, unknown>): void {
    const d = isRecord(frame.d) ? frame.d : null;
    const interval = d && typeof d.heartbeat_interval === "number" ? d.heartbeat_interval : 30_000;
    this.startHeartbeat(interval);
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
    if (this.stopped) return;
    this.scheduleReconnect();
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
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
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
      ws.send(JSON.stringify({ op: 1 }));
    }
  }

  /** Returns false when the id is a duplicate within the sliding window. */
  private recordId(id: string): boolean {
    if (this.seenIds.has(id)) return false;
    this.seenIds.add(id);
    this.idQueue.push(id);
    if (this.idQueue.length > MAX_DEDUP) {
      const oldest = this.idQueue.shift();
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    return true;
  }
}
