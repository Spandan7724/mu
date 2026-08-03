import type { ToolResultContent } from "@mu/ai";
import type { ToolPermissionDetails } from "./permission.ts";

export interface ToolResult {
  content: ToolResultContent[];
  details?: unknown; // renderer/session-visible only
  isError?: boolean;
  // When every call in a batch returns terminate, the loop stops after it.
  terminate?: boolean;
}

export interface Tool<Args = Record<string, unknown>> {
  name: string;
  description: string; // model-facing
  inputSchema: Record<string, unknown>; // JSON Schema for the wire
  // Concurrency predicate over parsed args. A throw is treated as unsafe.
  isConcurrencySafe?: (args: Args) => boolean;
  executionMode?: "sequential"; // hard override: never parallel with anything
  changesState?: boolean | ((args: Args) => boolean);
  // Profile-owned value matched by permission rules and persisted by "always allow".
  permissionPattern?: (args: Args) => string;
  permissionDetails?: (
    args: Args,
  ) => ToolPermissionDetails | undefined | Promise<ToolPermissionDetails | undefined>;
  execute: (
    toolCallId: string,
    args: Args,
    signal: AbortSignal,
    onUpdate?: (partial: ToolResultContent[]) => void,
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

export function concurrencySafe(tool: AnyTool, args: unknown): boolean {
  if (tool.executionMode === "sequential") return false;
  if (!tool.isConcurrencySafe) return false;
  try {
    return tool.isConcurrencySafe(args) === true;
  } catch {
    return false;
  }
}
