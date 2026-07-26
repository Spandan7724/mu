import type {
  AiMessage,
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
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
} from "@mu/ai";

// Typed injected context. Per-turn dynamic information enters the transcript as
// one of these — NEVER as a system-prompt edit (prompt-cache hygiene).
export interface CustomMessage {
  role: "custom";
  customType: string; // "system-reminder" | "compaction-summary" | "task-notification" | ...
  content: (TextContent | ImageContent)[];
  display?: boolean; // whether a UI shows it
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
export function toAiMessages(messages: AgentMessage[]): AiMessage[] {
  return messages.map((message) =>
    message.role === "custom" ? renderCustomMessage(message) : message,
  );
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
