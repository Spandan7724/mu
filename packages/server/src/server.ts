import type { Origin } from "@mu/protocol";
import { Connection } from "./connection.ts";
import type { SessionHost } from "./session-host.ts";

// The seam the handshake plugs into. Until `origin` is set, the connection has
// emitted nothing and accepted nothing — that is the whole invariant this type
// exists to make structural rather than remembered (PROTOCOL.md §8.3).
export interface SecureChannel {
  readonly origin: Origin | undefined;
  // Fed every message received while unauthenticated. Returns the reply to
  // send back, or throws to reject the connection.
  advance: (message: Uint8Array) => Uint8Array | undefined;
  seal: (plaintext: string) => Uint8Array;
  open: (ciphertext: Uint8Array) => string;
}

export type ChannelFactory = (peer: string) => SecureChannel;

export interface ServeOptions {
  host: SessionHost;
  hostName: string;
  version: string;
  // Loopback binds this; a LAN transport binds a specific interface. Never
  // 0.0.0.0 implicitly (SECURITY.md §6).
  hostname?: string;
  // 0 lets the OS assign. Ports are ephemeral by design (RD9).
  port?: number;
  // Absent means loopback: same machine, no sealing, origin is local.
  channel?: ChannelFactory;
  // Refuses a connection before the handshake starts. R4 rate limiting.
  admit?: (peer: string) => { ok: true } | { ok: false; reason: string };
  onConnection?: (origin: Origin) => void;
}

interface SocketState {
  peer: string;
  channel: SecureChannel | undefined;
  connection: Connection | undefined;
}

export interface RunningServer {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  // Drops every live connection. Revocation uses this, which is why it takes a
  // predicate rather than closing everything unconditionally.
  disconnect: (reason: "revoked" | "shutdown", match?: (origin: Origin) => boolean) => void;
  stop: () => Promise<void>;
}

function toBytes(message: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof message === "string") return new TextEncoder().encode(message);
  return message instanceof ArrayBuffer ? new Uint8Array(message) : message;
}

export function serve(options: ServeOptions): RunningServer {
  const live = new Map<unknown, { state: SocketState; close: (reason: string) => void }>();

  const server = Bun.serve<SocketState, never>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    fetch(request, self) {
      const peer = self.requestIP(request)?.address ?? "unknown";
      const admitted = options.admit?.(peer) ?? { ok: true as const };
      if (!admitted.ok) return new Response(admitted.reason, { status: 429 });
      const upgraded = self.upgrade(request, {
        data: { peer, channel: undefined, connection: undefined },
      });
      // Nothing but the WebSocket upgrade is served. There is no HTTP surface
      // to audit because there is no HTTP surface.
      return upgraded ? undefined : new Response("mu remote", { status: 426 });
    },
    websocket: {
      open(ws) {
        const state = ws.data;
        state.channel = options.channel?.(state.peer);
        live.set(ws, {
          state,
          close: (reason) => ws.close(1000, reason),
        });
        // Loopback has no handshake: same machine, same user, no network.
        if (!state.channel) attach(ws, { kind: "local" });
      },
      message(ws, message) {
        const state = ws.data;
        const channel = state.channel;
        if (channel && !channel.origin) {
          let reply: Uint8Array | undefined;
          try {
            reply = channel.advance(toBytes(message));
          } catch {
            ws.close(1008, "handshake");
            return;
          }
          if (reply) ws.send(reply);
          if (channel.origin) attach(ws, channel.origin);
          return;
        }
        const line = channel ? channel.open(toBytes(message)) : String(message);
        void state.connection?.receive(line);
      },
      close(ws) {
        live.get(ws)?.state.connection?.dispose();
        live.delete(ws);
      },
    },
  });

  function attach(ws: Bun.ServerWebSocket<SocketState>, origin: Origin): void {
    const state = ws.data;
    const channel = state.channel;
    state.connection = new Connection({
      host: options.host,
      origin,
      send: (line) => ws.send(channel ? channel.seal(line) : line),
      close: (reason) => ws.close(1000, reason),
      hostName: options.hostName,
      version: options.version,
    });
    state.connection.greet();
    options.onConnection?.(origin);
  }

  const port = server.port ?? 0;
  const hostname = server.hostname ?? options.hostname ?? "127.0.0.1";
  return {
    port,
    hostname,
    url: `ws://${hostname}:${port}`,
    disconnect: (reason, match) => {
      for (const [ws, entry] of live) {
        const origin = entry.state.connection ? originOf(entry.state) : undefined;
        if (match && (!origin || !match(origin))) continue;
        entry.state.connection?.drop(reason);
        live.delete(ws);
      }
    },
    stop: async () => {
      // Say goodbye, then let the listener close every socket. Closing them
      // here first is what makes Bun's forced stop never resolve.
      for (const entry of live.values()) entry.state.connection?.bye("shutdown");
      live.clear();
      await server.stop(true);
    },
  };
}

function originOf(state: SocketState): Origin | undefined {
  return state.channel?.origin ?? { kind: "local" };
}
