import type { ToolResultContent, Usage } from "@mu/ai";
import type { PermissionTarget, ToolPermissionDetails } from "./permission.ts";

export interface ToolResult {
  content: ToolResultContent[];
  details?: unknown; // renderer/session-visible only
  usage?: Usage; // provider usage incurred by work performed inside this tool
  isError?: boolean;
  // Emit this exact text as the final assistant response without another model call.
  directResponse?: string;
  // When every call in a batch returns terminate, the loop stops after it.
  terminate?: boolean;
  // Only the newest result carrying a key stays verbatim. Older results with the
  // same key are replaced by `summary` during microcompaction: within the last two turns
  // right away, earlier ones once the context is under pressure (prompt-cache prefix).
  retention?: { key: string; summary: string };
}

export interface Tool<Args = Record<string, unknown>> {
  name: string;
  description: string; // model-facing
  inputSchema: Record<string, unknown>; // JSON Schema for the wire
  // Concurrency predicate over parsed args. A throw is treated as unsafe.
  isConcurrencySafe?: (args: Args) => boolean;
  executionMode?: "sequential"; // hard override: never parallel with anything
  changesState?: boolean | ((args: Args) => boolean);
  // Every opaque checkpoint resource this call may change, when the tool can
  // name all of them, so the turn's checkpoint records only those. A throw
  // means unknown.
  changedResources?: (args: Args) => string[];
  // Profile-owned permission category derived from validated arguments. The
  // concrete tool name remains an additional match target, so broad rules such
  // as `bash: deny` still govern narrower scopes such as `bash:inspect`.
  permissionScope?: (args: Args) => string;
  // Profile-owned value matched by permission rules and persisted by "always allow".
  permissionPattern?: (args: Args) => string;
  // Every value the call is judged by, when one pattern cannot speak for the
  // whole call. Replaces scope and pattern for evaluation only.
  permissionTargets?: (args: Args) => PermissionTarget[];
  permissionDetails?: (
    args: Args,
  ) => ToolPermissionDetails | undefined | Promise<ToolPermissionDetails | undefined>;
  // Whether a running call can be handed to work that outlives it. When `background`
  // fires, execute resolves at once with a result saying where the work continues.
  canBackground?: (args: Args) => boolean;
  execute: (
    toolCallId: string,
    args: Args,
    signal: AbortSignal,
    onUpdate?: (partial: ToolResultContent[], details?: unknown) => void,
    background?: AbortSignal,
  ) => Promise<ToolResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: tool registries are heterogeneous by nature
export type AnyTool = Tool<any>;

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function canBackground(tool: AnyTool, args: unknown): boolean {
  if (!tool.canBackground) return false;
  try {
    return tool.canBackground(args) === true;
  } catch {
    return false;
  }
}

export function concurrencySafe(tool: AnyTool, args: unknown): boolean {
  if (tool.executionMode === "sequential") return false;
  if (!tool.isConcurrencySafe) return false;
  try {
    return tool.isConcurrencySafe(args) === true;
  } catch {
    return false;
  }
}
