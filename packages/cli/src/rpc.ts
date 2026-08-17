// RPC mode: newline-delimited JSON over stdio. Events out, ops in — the same
// AgentEvent union every other surface consumes.
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentRunOptions,
  CommandResult,
  MarkdownCommandRun,
  Usage,
} from "mu";
import { z } from "zod";

export type RpcOp = (
  | { type: "input"; text: string }
  | { type: "steer"; text: string }
  | { type: "follow_up"; text: string }
  | {
      type: "permission_reply";
      requestId: string;
      outcome: "allow" | "deny";
      remember?: boolean | undefined;
    }
  | { type: "resume"; sessionId: string }
  | { type: "command"; text: string }
  | { type: "shell"; command: string }
  | { type: "remove_queued"; kind: "steer" | "follow-up"; text: string }
  | { type: "cycle_permission_mode" }
  | { type: "permission_mode"; id: string }
  | { type: "snapshot" }
  | { type: "resize"; cols: number; rows: number }
  | { type: "thinking"; level: string }
  | { type: "abort" }
  | { type: "shutdown" }
) & { operationId?: string | undefined };

export interface RpcRuntimeMetadata {
  sessionId: string;
  model: string;
  contextWindow: number;
  thinking: string;
  thinkingLevels: string[];
}

export interface RpcSnapshot extends RpcRuntimeMetadata {
  messages: AgentMessage[];
  usage: Usage;
  contextPercent: number;
  isRunning: boolean;
  events?: AgentEvent[];
  models?: { label: string; description?: string }[];
  permissionModes?: { id: string; label: string; description: string }[];
  permissionMode?: string;
  commands?: { label: string; description?: string }[];
}

export type RpcOut =
  | { type: "event"; event: AgentEvent }
  | { type: "error"; message: string }
  | ({ type: "ready" } & Partial<RpcRuntimeMetadata>)
  | { type: "snapshot"; snapshot: RpcSnapshot }
  | { type: "command_result"; message?: string; data?: unknown; runtime?: RpcRuntimeMetadata }
  | { type: "op_result"; operationId: string; ok: true }
  | { type: "op_result"; operationId: string; ok: false; message: string }
  | { type: "shutdown" };

export interface RpcIo {
  write: (line: string) => void;
  lines: AsyncIterable<string>;
}

export interface RpcDeps {
  // Created per input op so each prompt is its own run.
  agent: Agent;
  // Resolves a pending permission ask; returns false when the id is unknown.
  resolvePermission?: (requestId: string, outcome: "allow" | "deny", remember?: boolean) => boolean;
  cancelPermissions?: () => void;
  resumeSession?: (sessionId: string) => Promise<void>;
  runCommand?: (text: string) => Promise<CommandResult>;
  runShell?: (command: string, emit: (event: AgentEvent) => void) => Promise<void>;
  abortAuxiliary?: () => void;
  cyclePermissionMode?: () => string | undefined;
  setPermissionMode?: (id: string) => string | undefined;
  ready?: RpcRuntimeMetadata;
  snapshot?: () => RpcSnapshot;
}

const text = z.string().max(1_000_000);
const rpcOperationId = z.string().min(1).max(128);
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
      remember: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("resume"), sessionId: z.string().min(1).max(512) }).strict(),
  z.object({ type: z.literal("command"), text }).strict(),
  z.object({ type: z.literal("shell"), command: text }).strict(),
  z
    .object({
      type: z.literal("remove_queued"),
      kind: z.enum(["steer", "follow-up"]),
      text,
    })
    .strict(),
  z.object({ type: z.literal("cycle_permission_mode") }).strict(),
  z.object({ type: z.literal("permission_mode"), id: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("snapshot") }).strict(),
  z
    .object({
      type: z.literal("resize"),
      cols: z.number().int().min(1).max(2_000),
      rows: z.number().int().min(1).max(2_000),
    })
    .strict(),
  z.object({ type: z.literal("thinking"), level: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("abort") }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
]);

export function parseOp(
  line: string,
): RpcOp | { type: "parse_error"; message: string; operationId?: string | undefined } {
  if (line === RPC_LINE_TOO_LONG || line.length > MAX_RPC_LINE_CHARS) {
    return { type: "parse_error", message: "RPC input line exceeds the 2,000,000 character limit" };
  }
  try {
    const parsed: unknown = JSON.parse(line);
    const metadata = z
      .object({ operationId: rpcOperationId.optional() })
      .passthrough()
      .safeParse(parsed);
    const operationId = metadata.success ? metadata.data.operationId : undefined;
    if (metadata.success && typeof parsed === "object" && parsed !== null) {
      const { operationId: _operationId, ...value } = parsed as Record<string, unknown>;
      const result = rpcOpSchema.safeParse(value);
      if (result.success)
        return { ...result.data, ...(operationId ? { operationId } : {}) } as RpcOp;
      return {
        type: "parse_error",
        message: result.error.issues
          .map((issue) => `${issue.path.join(".") || "op"}: ${issue.message}`)
          .join("; "),
        ...(operationId ? { operationId } : {}),
      };
    }
    const result = rpcOpSchema.safeParse(parsed);
    if (result.success) return result.data as RpcOp;
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
  send({ type: "ready", ...(deps.ready ?? {}) });

  let active: Promise<void> | undefined;
  const runtimeMetadata = (): RpcRuntimeMetadata | undefined => {
    const snapshot = deps.snapshot?.();
    if (!snapshot) return undefined;
    return {
      sessionId: snapshot.sessionId,
      model: snapshot.model,
      contextWindow: snapshot.contextWindow,
      thinking: snapshot.thinking,
      thinkingLevels: snapshot.thinkingLevels,
    };
  };

  const accept = (op: { operationId?: string | undefined }): void => {
    if (op.operationId) send({ type: "op_result", operationId: op.operationId, ok: true });
  };
  const reject = (op: { operationId?: string | undefined }, message: string): void => {
    if (op.operationId) {
      send({ type: "op_result", operationId: op.operationId, ok: false, message });
    } else {
      send({ type: "error", message });
    }
  };

  const launch = (text: string, options?: AgentRunOptions): string | undefined => {
    if (active || deps.agent.isRunning) {
      return "a run is already active; use steer or wait for it";
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
    return undefined;
  };

  try {
    for await (const line of io.lines) {
      if (line.trim().length === 0) continue;
      const op = parseOp(line);

      switch (op.type) {
        case "parse_error":
          reject(op, `invalid op: ${op.message}`);
          break;

        case "input": {
          const error = launch(op.text);
          if (error) reject(op, error);
          else accept(op);
          break;
        }

        case "steer":
          deps.agent.send(op.text);
          accept(op);
          break;

        case "follow_up":
          deps.agent.followUp(op.text);
          accept(op);
          break;

        case "permission_reply": {
          const ok = deps.resolvePermission?.(op.requestId, op.outcome, op.remember) ?? false;
          if (!ok) reject(op, `unknown permission request: ${op.requestId}`);
          else accept(op);
          break;
        }

        case "resume": {
          if (active || deps.agent.isRunning) {
            reject(op, "cannot resume while a run is active");
            break;
          }
          if (!deps.resumeSession) {
            reject(op, "session resume is unavailable");
            break;
          }
          try {
            await deps.resumeSession(op.sessionId);
            const runtime = runtimeMetadata();
            send({
              type: "command_result",
              message: `Resumed session ${op.sessionId}`,
              data: { sessionId: deps.agent.sessionId },
              ...(runtime ? { runtime } : {}),
            });
            accept(op);
          } catch (error) {
            reject(op, error instanceof Error ? error.message : String(error));
          }
          break;
        }

        case "command": {
          try {
            const result = (await deps.runCommand?.(op.text)) ?? { handled: false };
            const runtime = runtimeMetadata();
            if (isMarkdownCommandRun(result.data)) {
              const launchError = launch(result.data.prompt, {
                ...(result.data.model ? { model: result.data.model } : {}),
                ...(result.data.allowedTools ? { allowedTools: result.data.allowedTools } : {}),
              });
              if (launchError) {
                reject(op, launchError);
                break;
              }
              send({
                type: "command_result",
                ...(result.message ? { message: result.message } : {}),
                ...(runtime ? { runtime } : {}),
              });
            } else {
              send({
                type: "command_result",
                ...(result.message ? { message: result.message } : {}),
                ...(result.data !== undefined ? { data: result.data } : {}),
                ...(runtime ? { runtime } : {}),
              });
            }
            accept(op);
          } catch (error) {
            reject(op, error instanceof Error ? error.message : String(error));
          }
          break;
        }

        case "shell": {
          if (!deps.runShell) {
            reject(op, "direct shell execution is unavailable");
            break;
          }
          if (active || deps.agent.isRunning) {
            reject(op, "a session operation is already active");
            break;
          }
          const task = deps
            .runShell(op.command, (event) => send({ type: "event", event }))
            .catch((error) =>
              send({
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              }),
            );
          active = task;
          void task.finally(() => {
            if (active === task) active = undefined;
          });
          accept(op);
          break;
        }

        case "remove_queued":
          if (!deps.agent.removeQueuedMessage(op.kind, op.text)) {
            reject(op, "queued input is no longer available");
          } else accept(op);
          break;

        case "cycle_permission_mode": {
          const label = deps.cyclePermissionMode?.();
          const runtime = runtimeMetadata();
          if (!label) reject(op, "permission modes are unavailable");
          else {
            send({
              type: "command_result",
              message: `Permissions set to ${label}.`,
              ...(runtime ? { runtime } : {}),
            });
            accept(op);
          }
          break;
        }

        case "permission_mode": {
          const label = deps.setPermissionMode?.(op.id);
          if (!label) reject(op, `unknown permission mode: ${op.id}`);
          else {
            send({ type: "command_result", message: `Permissions set to ${label}.` });
            accept(op);
          }
          break;
        }

        case "snapshot":
          if (!deps.snapshot) reject(op, "runtime snapshot is unavailable");
          else {
            send({ type: "snapshot", snapshot: deps.snapshot() });
            accept(op);
          }
          break;

        case "resize":
          deps.agent.resize(op.cols, op.rows);
          accept(op);
          break;

        case "thinking":
          try {
            deps.agent.setThinking(op.level);
            accept(op);
          } catch (error) {
            reject(op, error instanceof Error ? error.message : String(error));
          }
          break;

        case "abort":
          deps.cancelPermissions?.();
          deps.abortAuxiliary?.();
          deps.agent.abort();
          accept(op);
          break;

        case "shutdown":
          // Graceful: let an in-flight run finish. Callers wanting to cut it
          // short send `abort` first — that is what that op is for.
          deps.cancelPermissions?.();
          deps.abortAuxiliary?.();
          accept(op);
          await active;
          await deps.agent.waitForIdle();
          send({ type: "shutdown" });
          return;

        default:
          send({ type: "error", message: `unknown op type: ${(op as { type: string }).type}` });
      }
    }

    deps.cancelPermissions?.();
    deps.abortAuxiliary?.();
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
