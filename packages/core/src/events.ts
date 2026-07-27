import type { AssistantMessage, ToolResultContent, ToolResultMessage, Usage } from "@mu/ai";
import type { AgentMessage } from "./messages.ts";
import type { PermissionRequest } from "./permission.ts";

// Fine-grained deltas for renderers that stream. Carried alongside the
// accumulating partial message on message_update.
export type StreamDelta =
  | { kind: "text_start"; contentIndex: number }
  | { kind: "text_delta"; contentIndex: number; text: string }
  | { kind: "text_end"; contentIndex: number }
  | { kind: "thinking_start"; contentIndex: number }
  | { kind: "thinking_delta"; contentIndex: number; text: string }
  | { kind: "thinking_end"; contentIndex: number }
  | { kind: "toolcall_start"; contentIndex: number }
  | { kind: "toolcall_delta"; contentIndex: number; argsFragment: string }
  | { kind: "toolcall_end"; contentIndex: number; toolCallId: string };

export type AgentEndReason = "done" | "aborted" | "budget" | "maxTurns" | "error";

// THE contract. Every consumer (UI, session persistence, extensions, RPC
// clients, SDK streaming) reads this union, and nothing user-visible happens
// outside it. Every member must be JSON-serializable.
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; reason: AgentEndReason }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AssistantMessage; delta: StreamDelta }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; partial: ToolResultContent[] }
  | { type: "tool_execution_end"; toolCallId: string; result: ToolResultMessage }
  | { type: "permission_asked"; request: PermissionRequest }
  | {
      type: "permission_resolved";
      requestId: string;
      outcome: "allow" | "deny";
      remembered?: boolean;
    }
  | { type: "compaction_start"; layer: 1 | 2 | 3 }
  | { type: "compaction_end"; layer: 1 | 2 | 3; tokensFreed: number; summaryEntryId?: string }
  | { type: "task_started"; taskId: string; command: string; background: boolean }
  | { type: "task_output"; taskId: string; chunk: string }
  | {
      type: "task_exited";
      taskId: string;
      exitCode: number | null;
      status?: "exited" | "killed";
    }
  | {
      type: "usage_updated";
      sessionTotals: Usage;
      contextTokens: number;
      contextPercent: number;
    };

export type AgentEventType = AgentEvent["type"];

export type EventSink = (event: AgentEvent) => void | Promise<void>;
