// RPC mode: newline-delimited JSON over stdio. Events out, ops in — the same
// AgentEvent union every other surface consumes.
import type { Agent, AgentEvent, CommandResult } from "mu";

export type RpcOp =
  | { type: "input"; text: string }
  | { type: "steer"; text: string }
  | { type: "follow_up"; text: string }
  | { type: "permission_reply"; requestId: string; outcome: "allow" | "deny" }
  | { type: "command"; text: string }
  | { type: "abort" }
  | { type: "shutdown" };

export type RpcOut =
  | { type: "event"; event: AgentEvent }
  | { type: "error"; message: string }
  | { type: "ready" }
  | { type: "command_result"; message?: string; data?: unknown }
  | { type: "shutdown" };

export interface RpcIo {
  write: (line: string) => void;
  lines: AsyncIterable<string>;
}

export interface RpcDeps {
  // Created per input op so each prompt is its own run.
  agent: Agent;
  // Resolves a pending permission ask; returns false when the id is unknown.
  resolvePermission?: (requestId: string, outcome: "allow" | "deny") => boolean;
  runCommand?: (text: string) => Promise<CommandResult>;
}

export function parseOp(line: string): RpcOp | { type: "parse_error"; message: string } {
  try {
    const parsed = JSON.parse(line) as RpcOp;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
      return { type: "parse_error", message: "op must be an object with a type" };
    }
    return parsed;
  } catch (error) {
    return {
      type: "parse_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runRpc(io: RpcIo, deps: RpcDeps): Promise<void> {
  const send = (out: RpcOut) => io.write(`${JSON.stringify(out)}\n`);
  send({ type: "ready" });

  let active: Promise<unknown> | undefined;

  for await (const line of io.lines) {
    if (line.trim().length === 0) continue;
    const op = parseOp(line);

    switch (op.type) {
      case "parse_error":
        send({ type: "error", message: `invalid op: ${op.message}` });
        break;

      case "input": {
        const stream = deps.agent.stream(op.text);
        active = (async () => {
          for await (const event of stream) send({ type: "event", event });
          await stream.result().catch((error: unknown) => {
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
        })();
        break;
      }

      case "steer":
        deps.agent.send(op.text);
        break;

      case "follow_up":
        deps.agent.followUp(op.text);
        break;

      case "permission_reply": {
        const ok = deps.resolvePermission?.(op.requestId, op.outcome) ?? false;
        if (!ok) send({ type: "error", message: `unknown permission request: ${op.requestId}` });
        break;
      }

      case "command": {
        const result = (await deps.runCommand?.(op.text)) ?? { handled: false };
        send({
          type: "command_result",
          ...(result.message ? { message: result.message } : {}),
          ...(result.data !== undefined ? { data: result.data } : {}),
        });
        break;
      }

      case "abort":
        deps.agent.abort();
        break;

      case "shutdown":
        // Graceful: let an in-flight run finish. Callers wanting to cut it
        // short send `abort` first — that is what that op is for.
        await active;
        send({ type: "shutdown" });
        return;

      default:
        send({ type: "error", message: `unknown op type: ${(op as { type: string }).type}` });
    }
  }

  await active;
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
