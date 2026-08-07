// RPC mode: newline-delimited JSON over stdio, carrying the same frames the
// WebSocket transport does. Events out, ops in — one contract, one envelope.
import {
  type ClientFrame,
  decodeClientFrame,
  encodeFrame,
  FULL_FIDELITY,
  type Origin,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "@mu/protocol";
import type { SessionHost } from "@mu/server";

export interface RpcIo {
  write: (line: string) => void;
  lines: AsyncIterable<string>;
}

export interface RpcDeps {
  host: SessionHost;
  version?: string;
  name?: string;
}

// Stdio is the local surface: the process on the other end already has the
// user's terminal, so nothing is narrowed and nothing is budgeted away.
const LOCAL: Origin = { kind: "local" };

export function parseFrame(line: string): ClientFrame | { t: "parse_error"; message: string } {
  const parsed = decodeClientFrame(line);
  return parsed.ok ? parsed.value : { t: "parse_error", message: parsed.message };
}

export async function runRpc(io: RpcIo, deps: RpcDeps): Promise<void> {
  const { host } = deps;
  const send = (frame: ServerFrame) => io.write(`${encodeFrame(frame)}\n`);
  const session = host.agent.sessionId;

  const subscription = host.subscribe(
    FULL_FIDELITY,
    {
      event: ({ seq, event }) => send({ t: "event", session: host.agent.sessionId, seq, event }),
      gap: (from, to) => send({ t: "gap", session: host.agent.sessionId, from, to }),
    },
    undefined,
  );

  send({
    t: "hello",
    protocol: PROTOCOL_VERSION,
    host: {
      hostId: host.id,
      instanceId: host.instanceId,
      name: deps.name ?? "local",
      version: deps.version ?? "0.0.0",
      workspace: host.workspace,
    },
  });
  send({ t: "state", session, seq: host.seq, state: host.state() });

  try {
    for await (const line of io.lines) {
      if (line.trim().length === 0) continue;
      const frame = parseFrame(line);

      if (frame.t === "parse_error") {
        send({
          t: "reply",
          id: "",
          ok: false,
          error: { code: "unsupported", message: `invalid frame: ${frame.message}` },
        });
        continue;
      }

      if (frame.t === "attach") {
        send({
          t: "state",
          session: host.agent.sessionId,
          seq: host.seq,
          state: host.state(),
        });
        continue;
      }

      if (frame.t === "detach") continue;

      const result = await host.apply(frame.op, LOCAL);
      send(
        result.ok
          ? {
              t: "reply",
              id: frame.id,
              ok: true,
              ...(result.data !== undefined ? { data: result.data } : {}),
            }
          : { t: "reply", id: frame.id, ok: false, error: result.error },
      );
    }

    // Stdin closing is how this transport ends. A run already in flight is
    // allowed to finish; a caller wanting it cut short sends `abort` first.
    await host.idle();
  } finally {
    subscription.close();
    send({ t: "bye", reason: "shutdown" });
  }
}

export async function* linesFrom(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.trim().length > 0) yield buffer;
}
