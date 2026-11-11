import { type AssistantMessage, StreamingToolArgs } from "@mu/ai";
import type { AgentEvent, StreamDelta } from "./events.ts";

// The event stream as it crosses a process boundary. In process, message_update
// carries the accumulating partial message by reference; serializing that on
// every delta is quadratic in the message size, so on the wire it carries the
// delta alone and the receiver rebuilds the partial.
export type WireAgentEvent =
  | Exclude<AgentEvent, { type: "message_update" }>
  | { type: "message_update"; delta: StreamDelta; message?: AssistantMessage };

export function toWireEvent(event: AgentEvent): WireAgentEvent {
  return event.type === "message_update" ? { type: "message_update", delta: event.delta } : event;
}

function emptyAssistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    model: "",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    stopReason: "end",
    timestamp: Date.now(),
  };
}

// Rebuilds in-process events from wire events, one decoder per event stream.
export class WireEventDecoder {
  private partial: AssistantMessage | undefined;
  private args = new Map<number, StreamingToolArgs>();

  decode(event: WireAgentEvent): AgentEvent {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.partial = { ...event.message, content: [...event.message.content] };
      this.args.clear();
      return event;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.partial = undefined;
      this.args.clear();
      return event;
    }
    if (event.type !== "message_update") return event;
    if (event.message)
      return { type: "message_update", message: event.message, delta: event.delta };
    this.partial ??= emptyAssistant();
    this.apply(this.partial, event.delta);
    return {
      type: "message_update",
      message: { ...this.partial, content: [...this.partial.content] },
      delta: event.delta,
    };
  }

  private apply(message: AssistantMessage, delta: StreamDelta): void {
    const index = delta.contentIndex;
    // Blocks that arrive outside the delta stream leave gaps to hold their place.
    while (message.content.length < index) message.content.push({ type: "text", text: "" });
    const block = message.content[index];
    switch (delta.kind) {
      case "text_start":
        message.content[index] = { type: "text", text: "" };
        return;
      case "text_delta":
        message.content[index] = {
          type: "text",
          text: (block?.type === "text" ? block.text : "") + delta.text,
        };
        return;
      case "thinking_start":
        message.content[index] = { type: "thinking", thinking: "" };
        return;
      case "thinking_delta":
        message.content[index] = {
          type: "thinking",
          thinking: (block?.type === "thinking" ? block.thinking : "") + delta.text,
        };
        return;
      case "toolcall_start":
        this.args.set(index, new StreamingToolArgs());
        message.content[index] = {
          type: "toolCall",
          id: delta.toolCallId ?? "",
          name: delta.toolName ?? "",
          arguments: {},
        };
        return;
      case "toolcall_delta": {
        let args = this.args.get(index);
        if (!args) {
          args = new StreamingToolArgs();
          this.args.set(index, args);
        }
        message.content[index] = {
          type: "toolCall",
          id: block?.type === "toolCall" ? block.id : "",
          name: block?.type === "toolCall" ? block.name : "",
          arguments: args.append(delta.argsFragment),
        };
        return;
      }
      case "toolcall_end":
        message.content[index] = {
          type: "toolCall",
          id: delta.toolCallId,
          name: delta.toolName ?? (block?.type === "toolCall" ? block.name : ""),
          arguments:
            delta.args ??
            this.args.get(index)?.finish() ??
            (block?.type === "toolCall" ? block.arguments : {}),
        };
        return;
      default:
        return;
    }
  }
}
