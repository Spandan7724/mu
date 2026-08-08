// RPC mode: newline-delimited JSON over stdio. Events out, ops in — the same
// AgentEvent union every other surface consumes.
import type { Agent, AgentEvent, AgentRunOptions, CommandResult, MarkdownCommandRun } from "mu";
import { z } from "zod";

export type RpcOp =
  | { type: "input"; text: string }
  | { type: "steer"; text: string }
  | { type: "follow_up"; text: string }
  | { type: "permission_reply"; requestId: string; outcome: "allow" | "deny" }
  | { type: "resume"; sessionId: string }
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
  cancelPermissions?: () => void;
  resumeSession?: (sessionId: string) => Promise<void>;
  runCommand?: (text: string) => Promise<CommandResult>;
}

const text = z.string().max(1_000_000);
const MAX_RPC_LINE_CHARS = 2_000_000;
const RPC_LINE_TOO_LONG = "__mu_rpc_line_too_long__";
const rpcOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), text }).strict(),
  z.object({ type: z.literal("steer"), text }).strict(),
  z.object({ type: z.literal("follow_up"), text }).strict(),
  z
    .object({
      type: z.literal("permission_reply"),
      requestId: z.string().min(1).max(256),
      outcome: z.enum(["allow", "deny"]),
    })
    .strict(),
  z.object({ type: z.literal("resume"), sessionId: z.string().min(1).max(512) }).strict(),
  z.object({ type: z.literal("command"), text }).strict(),
  z.object({ type: z.literal("abort") }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
]);

export function parseOp(line: string): RpcOp | { type: "parse_error"; message: string } {
  if (line === RPC_LINE_TOO_LONG || line.length > MAX_RPC_LINE_CHARS) {
    return { type: "parse_error", message: "RPC input line exceeds the 2,000,000 character limit" };
  }
  try {
    const parsed: unknown = JSON.parse(line);
    const result = rpcOpSchema.safeParse(parsed);
    if (result.success) return result.data;
    return {
      type: "parse_error",
      message: result.error.issues
        .map((issue) => `${issue.path.join(".") || "op"}: ${issue.message}`)
        .join("; "),
    };
  } catch (error) {
    return {
      type: "parse_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runRpc(io: RpcIo, deps: RpcDeps): Promise<void> {
  const send = (out: RpcOut) => io.write(`${JSON.stringify(out)}\n`);
  const unsubscribe = deps.agent.subscribe((event) => send({ type: "event", event }));
  send({ type: "ready" });

  let active: Promise<void> | undefined;

  const launch = (text: string, options?: AgentRunOptions): boolean => {
    if (active || deps.agent.isRunning) {
      send({ type: "error", message: "a run is already active; use steer or wait for it" });
      return false;
    }
    const task = (async () => {
      await deps.agent.run(text, options).catch((error: unknown) => {
        send({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    })();
    active = task;
    void task.finally(() => {
      if (active === task) active = undefined;
    });
    return true;
  };

  try {
    for await (const line of io.lines) {
      if (line.trim().length === 0) continue;
      const op = parseOp(line);

      switch (op.type) {
        case "parse_error":
          send({ type: "error", message: `invalid op: ${op.message}` });
          break;

        case "input": {
          launch(op.text);
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

        case "resume": {
          if (active || deps.agent.isRunning) {
            send({ type: "error", message: "cannot resume while a run is active" });
            break;
          }
          if (!deps.resumeSession) {
            send({ type: "error", message: "session resume is unavailable" });
            break;
          }
          try {
            await deps.resumeSession(op.sessionId);
            send({
              type: "command_result",
              message: `Resumed session ${op.sessionId}`,
              data: { sessionId: deps.agent.sessionId },
            });
          } catch (error) {
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }

        case "command": {
          try {
            const result = (await deps.runCommand?.(op.text)) ?? { handled: false };
            if (isMarkdownCommandRun(result.data)) {
              launch(result.data.prompt, {
                ...(result.data.model ? { model: result.data.model } : {}),
                ...(result.data.allowedTools ? { allowedTools: result.data.allowedTools } : {}),
              });
              send({
                type: "command_result",
                ...(result.message ? { message: result.message } : {}),
              });
            } else {
              send({
                type: "command_result",
                ...(result.message ? { message: result.message } : {}),
                ...(result.data !== undefined ? { data: result.data } : {}),
              });
            }
          } catch (error) {
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }

        case "abort":
          deps.cancelPermissions?.();
          deps.agent.abort();
          break;

        case "shutdown":
          // Graceful: let an in-flight run finish. Callers wanting to cut it
          // short send `abort` first — that is what that op is for.
          deps.cancelPermissions?.();
          await active;
          await deps.agent.waitForIdle();
          send({ type: "shutdown" });
          return;

        default:
          send({ type: "error", message: `unknown op type: ${(op as { type: string }).type}` });
      }
    }

    deps.cancelPermissions?.();
    await active;
    await deps.agent.waitForIdle();
  } finally {
    unsubscribe();
  }
}

function isMarkdownCommandRun(data: unknown): data is MarkdownCommandRun {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "markdown-command" &&
    typeof (data as { prompt?: unknown }).prompt === "string"
  );
}

export async function* linesFrom(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffer = "";
  let droppingOversizedLine = false;
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (droppingOversizedLine) {
      const end = buffer.indexOf("\n");
      if (end === -1) {
        buffer = "";
        continue;
      }
      buffer = buffer.slice(end + 1);
      droppingOversizedLine = false;
    }
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      yield line.length > MAX_RPC_LINE_CHARS ? RPC_LINE_TOO_LONG : line;
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_RPC_LINE_CHARS) {
      buffer = "";
      droppingOversizedLine = true;
      yield RPC_LINE_TOO_LONG;
    }
  }
  buffer += decoder.decode();
  if (!droppingOversizedLine && buffer.trim().length > 0) yield buffer;
}
