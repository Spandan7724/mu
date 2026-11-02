import type {
  AiMessage,
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@mu/ai";

export type {
  AssistantContent,
  AssistantMessage,
  ImageContent,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultContent,
  ToolResultMessage,
  Usage,
  UserContent,
  UserMessage,
  WebSearchAction,
  WebSearchCitation,
  WebSearchContent,
} from "@mu/ai";

// Typed injected context. Per-turn dynamic information enters the transcript as
// one of these — NEVER as a system-prompt edit (prompt-cache hygiene).
export interface CustomMessage {
  role: "custom";
  customType: string; // "system-reminder" | "compaction-summary" | "task-notification" | ...
  content: (TextContent | ImageContent)[];
  display?: boolean; // whether a UI shows it
  // Keep the latest snapshot with this key verbatim across compaction.
  retention?: { key: string };
  // Renderer/session-visible only; never sent to the model.
  details?: unknown;
  // Provider usage this message accounts for (work finished outside a tool call).
  usage?: Usage;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

export function isCustomMessage(message: AgentMessage): message is CustomMessage {
  return message.role === "custom";
}

// Custom messages are rendered to the model as tagged user-role content so the
// model can tell injected context from what the user typed.
export function renderCustomMessage(message: CustomMessage): UserMessage {
  const tag = message.customType;
  const content: (TextContent | ImageContent)[] = [];
  for (const block of message.content) {
    content.push(
      block.type === "text" ? { type: "text", text: `<${tag}>\n${block.text}\n</${tag}>` } : block,
    );
  }
  return { role: "user", content, timestamp: message.timestamp };
}

// Boundary conversion: the transcript type the kernel works in → the wire type
// the provider layer accepts.
// A failed assistant attempt is kept in the transcript but never sent back: its
// content is incomplete and may hold tool calls that were never run.
export function toAiMessages(messages: AgentMessage[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.stopReason === "error") continue;
    out.push(message.role === "custom" ? renderCustomMessage(message) : message);
  }
  return out;
}

export function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

export function customMessage(customType: string, text: string, display = false): CustomMessage {
  return {
    role: "custom",
    customType,
    content: [{ type: "text", text }],
    display,
    timestamp: Date.now(),
  };
}
