/**
 * Local QQ gateway mock (test fixture).
 *
 * Behaves like the official gateway for the subset the client exercises:
 * - on IDENTIFY (op 2) replies READY (op 0, t "READY", d.heartbeat_interval)
 * - answers HEARTBEAT (op 1) with HEARTBEAT_ACK (op 11)
 * - pushEvent(ws, t, d) sends a DISPATCH frame (op 0 with incrementing s)
 * - kill(ws) force-closes a socket so tests can exercise reconnection
 * - sockets exposes live server-side sockets for assertions
 *
 * Upgrade uses Bun's server.upgrade; with requireAuth the Authorization
 * header must start with "QQBot " or the upgrade is refused (401).
 */
import type { Server, ServerWebSocket } from "bun";

export interface WsServerOptions {
  /** Refuse upgrades without an `Authorization: QQBot …` header. */
  requireAuth?: boolean;
  /** heartbeat_interval advertised in READY (ms); default 30_000. */
  heartbeatInterval?: number;
}

export interface WsServerHandle {
  /** ws:// URL pointing at the local gateway mock. */
  url: string;
  server: Server<undefined>;
  /** Live server-side sockets (Set preserves insertion order). */
  sockets: Set<ServerWebSocket<undefined>>;
  /** Authorization / X-Union-Appid headers of the last upgrade request. */
  lastHeaders: { authorization?: string; xUnionAppid?: string } | null;
  /** Push a DISPATCH frame (op 0, t, d) to the given socket. */
  pushEvent(ws: ServerWebSocket<undefined>, t: string, d: unknown): void;
  /** Force-close a server-side socket (client sees a dropped connection). */
  kill(ws: ServerWebSocket<undefined>): void;
  /** Stop the server and terminate all open connections. */
  close(): Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export async function createWsServer(opts: WsServerOptions = {}): Promise<WsServerHandle> {
  const sockets = new Set<ServerWebSocket<undefined>>();
  const heartbeatInterval = opts.heartbeatInterval ?? 30_000;
  let seq = 0;
  let lastHeaders: WsServerHandle["lastHeaders"] = null;

  const server = Bun.serve<undefined>({
    port: 0,
    fetch(req, srv) {
      lastHeaders = {
        authorization: req.headers.get("Authorization") ?? undefined,
        xUnionAppid: req.headers.get("X-Union-Appid") ?? undefined,
      };
      if (opts.requireAuth) {
        const auth = req.headers.get("Authorization") ?? "";
        if (!auth.startsWith("QQBot ")) {
          return new Response("unauthorized", { status: 401 });
        }
      }
      if (srv.upgrade(req)) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      message(ws, message) {
        let frame: unknown;
        try {
          frame = JSON.parse(String(message));
        } catch {
          return;
        }
        if (!isRecord(frame)) return;
        if (frame.op === 2) {
          // IDENTIFY → READY
          ws.send(
            JSON.stringify({
              op: 0,
              s: ++seq,
              t: "READY",
              d: {
                version: 1,
                session_id: "mock-session",
                user: { id: "mock-bot", username: "mock-bot" },
                heartbeat_interval: heartbeatInterval,
              },
            }),
          );
        } else if (frame.op === 1) {
          // HEARTBEAT → HEARTBEAT_ACK
          ws.send(JSON.stringify({ op: 11, d: null }));
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}`,
    server,
    sockets,
    get lastHeaders() {
      return lastHeaders;
    },
    pushEvent(ws, t, d) {
      ws.send(JSON.stringify({ op: 0, s: ++seq, t, d }));
    },
    kill(ws) {
      ws.close(4000, "mock kill");
    },
    close() {
      // Bun bug oven-sh/bun#8707: after a server-side ws.close()/terminate(),
      // stop()'s promise never resolves even though shutdown completes.
      // Race it against a timeout instead of awaiting the broken promise.
      const stopPromise = server.stop(true);
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        stopPromise.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          () => {
            clearTimeout(timer);
            resolve();
          },
        );
      });
    },
  };
}
