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
// Providers reject a tool call that has no result, so every call sent is paired:
// an interrupted stream's unanswered calls are dropped (their arguments may be
// partial), and any other unanswered call gets a result saying it never ran.
export function toAiMessages(messages: AgentMessage[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as AgentMessage;
    if (message.role === "custom") {
      out.push(renderCustomMessage(message));
      continue;
    }
    if (message.role !== "assistant") {
      out.push(message);
      continue;
    }
    if (message.stopReason === "error") continue;
    const calls = message.content.filter((block) => block.type === "toolCall");
    if (calls.length === 0) {
      out.push(message);
      continue;
    }
    const answered = new Set<string>();
    let next = i + 1;
    for (; next < messages.length; next++) {
      const result = messages[next];
      if (result?.role !== "toolResult") break;
      answered.add(result.toolCallId);
    }
    const unanswered = calls.filter((call) => !answered.has(call.id));
    if (unanswered.length === 0) {
      out.push(message);
      continue;
    }
    if (message.stopReason === "aborted") {
      const content = message.content.filter(
        (block) => block.type !== "toolCall" || answered.has(block.id),
      );
      if (content.length > 0) out.push({ ...message, content });
    } else out.push(message);
    for (; i + 1 < next; i++) out.push(messages[i + 1] as ToolResultMessage);
    if (message.stopReason === "aborted") continue;
    for (const call of unanswered) {
      out.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: `Tool call "${call.name}" was interrupted before it returned a result.`,
          },
        ],
        isError: true,
        timestamp: message.timestamp,
      });
    }
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
