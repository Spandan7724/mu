import {
  type ClientFrame,
  decodeClientFrame,
  encodeFrame,
  type Origin,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "@mu/protocol";
import type { SessionHost, Subscription } from "./session-host.ts";

export interface ConnectionOptions {
  host: SessionHost;
  // Assigned from the authenticated connection, never read off a frame.
  origin: Origin;
  send: (line: string) => void;
  close: (reason: string) => void;
  hostName: string;
  version: string;
}

// One authenticated peer. Everything it can reach lives here, so the surface an
// unauthenticated peer touches stays as small as it can be (SECURITY.md §6).
export class Connection {
  private subscription: Subscription | undefined;
  private closed = false;

  constructor(private readonly options: ConnectionOptions) {}

  // Sent once, immediately after the handshake completes and never before.
  greet(): void {
    const { host } = this.options;
    this.send({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      host: {
        hostId: host.id,
        instanceId: host.instanceId,
        name: this.options.hostName,
        version: this.options.version,
        workspace: host.workspace,
      },
    });
    this.send({ t: "sessions", sessions: [host.summary()] });
  }

  async receive(line: string): Promise<void> {
    if (this.closed) return;
    const parsed = decodeClientFrame(line);
    if (!parsed.ok) {
      this.send({
        t: "reply",
        id: "",
        ok: false,
        error: { code: "unsupported", message: `invalid frame: ${parsed.message}` },
      });
      return;
    }
    await this.handle(parsed.value);
  }

  // Sends the frame and stops serving. Whether the socket itself is then
  // closed is the caller's: a revocation drops it, a server shutdown lets the
  // listener close every socket at once.
  bye(reason: "revoked" | "shutdown" | "protocol"): void {
    if (this.closed) return;
    this.send({ t: "bye", reason });
    this.dispose();
  }

  drop(reason: "revoked" | "shutdown" | "protocol"): void {
    this.bye(reason);
    this.options.close(reason);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscription?.close();
    this.subscription = undefined;
  }

  private async handle(frame: ClientFrame): Promise<void> {
    const { host } = this.options;
    switch (frame.t) {
      case "attach": {
        if (frame.session !== host.agent.sessionId) {
          this.send({
            t: "reply",
            id: "",
            ok: false,
            error: { code: "unknown_session", message: `no such session: ${frame.session}` },
          });
          return;
        }
        this.subscription?.close();
        this.subscription = host.subscribe(
          frame.policy,
          {
            event: ({ seq, event }) =>
              this.send({ t: "event", session: host.agent.sessionId, seq, event }),
            gap: (from, to) => this.send({ t: "gap", session: host.agent.sessionId, from, to }),
          },
          frame.sinceSeq,
        );
        // The snapshot follows the replay, so a client that took a gap has the
        // state it should fall back to without asking for it.
        this.send({
          t: "state",
          session: host.agent.sessionId,
          seq: host.seq,
          state: host.state(),
        });
        return;
      }

      case "detach":
        this.subscription?.close();
        this.subscription = undefined;
        return;

      case "op": {
        const result = await host.apply(frame.op, this.options.origin);
        this.send(
          result.ok
            ? {
                t: "reply",
                id: frame.id,
                ok: true,
                ...(result.data !== undefined ? { data: result.data } : {}),
              }
            : { t: "reply", id: frame.id, ok: false, error: result.error },
        );
        return;
      }
    }
  }

  private send(frame: ServerFrame): void {
    if (this.closed && frame.t !== "bye") return;
    this.options.send(encodeFrame(frame));
  }
}
