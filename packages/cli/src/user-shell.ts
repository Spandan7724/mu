import {
  type AgentEvent,
  type AnyTool,
  errorResult,
  type ToolResult,
  type ToolResultMessage,
} from "@mu/core";

export type UserShellEventSink = (event: AgentEvent) => void;

export interface UserShellRunOptions {
  toolCallId?: string;
}

export async function runUserShellCommand(
  tool: AnyTool,
  command: string,
  signal: AbortSignal,
  emit: UserShellEventSink,
  options: UserShellRunOptions = {},
): Promise<ToolResultMessage> {
  const toolCallId =
    options.toolCallId ??
    `user-shell-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

  emit({
    type: "tool_execution_start",
    toolCallId,
    toolName: "bash",
    args: { command, userShell: true },
  });

  let result: ToolResult;
  try {
    result = await tool.execute(toolCallId, { command }, signal, (partial) => {
      emit({ type: "tool_execution_update", toolCallId, partial });
    });
  } catch (error) {
    result = errorResult(error instanceof Error ? error.message : String(error));
  }

  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: result.content,
    ...(result.details !== undefined ? { details: result.details } : {}),
    isError: result.isError === true,
    timestamp: Date.now(),
  };
  emit({ type: "tool_execution_end", toolCallId, result: message });
  return message;
}

export function formatUserShellRecord(command: string, result: ToolResultMessage): string {
  const details = result.details as
    | { exitCode?: number | null; durationMs?: number; timedOut?: boolean }
    | undefined;
  const output = result.content
    .map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType}]`))
    .join("\n");
  const duration =
    details?.durationMs === undefined ? "unknown" : `${(details.durationMs / 1_000).toFixed(4)}s`;

  return [
    `<command>\n${command}\n</command>`,
    "<result>",
    `Exit code: ${details?.exitCode ?? "unknown"}`,
    `Duration: ${duration}`,
    ...(details?.timedOut ? ["Timed out: true"] : []),
    `Output:\n${output || "(no output)"}`,
    "</result>",
  ].join("\n");
}
