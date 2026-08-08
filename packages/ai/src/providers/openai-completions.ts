import { salvageToolArgs } from "../json.ts";
import { withRetries } from "../retry.ts";
import { iterateSse } from "../sse.ts";
import type { AssistantStream } from "../stream.ts";
import type {
  AiMessage,
  LlmContext,
  ModelInfo,
  Provider,
  StreamOpts,
  ThinkingLevel,
} from "../types.ts";
import {
  apiPath,
  credentialBaseUrl,
  credentialHeaders,
  resolveProviderCredential,
} from "./request.ts";
import { driveStream, postSse, updateCost } from "./shared.ts";

type Json = Record<string, unknown>;

function textFromResult(message: Extract<AiMessage, { role: "toolResult" }>): string {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return text || "(image result attached in the following user message)";
}

function userContent(message: Extract<AiMessage, { role: "user" }>): string | Json[] {
  if (message.content.every((block) => block.type === "text")) {
    return message.content.map((block) => block.text).join("\n");
  }
  return message.content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : {
          type: "image_url",
          image_url: { url: `data:${block.mimeType};base64,${block.data}` },
        },
  );
}

function convertMessages(messages: AiMessage[], systemPrompt: LlmContext["systemPrompt"]): Json[] {
  const converted: Json[] = [];
  if (systemPrompt && systemPrompt.length > 0) {
    converted.push({
      role: "system",
      content: systemPrompt.map((section) => section.text).join("\n\n"),
    });
  }
  let pendingToolImages: Extract<AiMessage, { role: "toolResult" }>["content"] = [];
  const flushToolImages = () => {
    const images = pendingToolImages.filter((block) => block.type === "image");
    if (images.length > 0) {
      converted.push({
        role: "user",
        content: [
          { type: "text", text: "Images returned by the preceding tool calls:" },
          ...images.map((block) => ({
            type: "image_url",
            image_url: { url: `data:${block.mimeType};base64,${block.data}` },
          })),
        ],
      });
    }
    pendingToolImages = [];
  };
  for (const message of messages) {
    if (message.role !== "toolResult") flushToolImages();
    if (message.role === "user") {
      converted.push({ role: "user", content: userContent(message) });
      continue;
    }
    if (message.role === "toolResult") {
      converted.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: textFromResult(message),
      });
      pendingToolImages.push(...message.content);
      continue;
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const reasoning = message.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("\n");
    const toolCalls = message.content
      .filter((block) => block.type === "toolCall")
      .map((block) => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
      }));
    if (!text && !reasoning && toolCalls.length === 0) continue;
    converted.push({
      role: "assistant",
      content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  flushToolImages();
  return converted;
}

function enabled(level: ThinkingLevel | undefined): boolean {
  return level !== undefined && level !== "off";
}

function addThinking(body: Json, model: ModelInfo, level: ThinkingLevel | undefined): void {
  if (!model.thinking || level === undefined) return;
  if (model.provider === "zai") {
    body.thinking = { type: enabled(level) ? "enabled" : "disabled" };
    if (enabled(level) && model.id === "glm-5.2") body.reasoning_effort = level;
    return;
  }
  if (model.provider.startsWith("qwen-token-plan")) {
    body.enable_thinking = enabled(level);
    return;
  }
  if (model.provider === "deepseek" || model.provider === "moonshotai") {
    body.thinking = { type: enabled(level) ? "enabled" : "disabled" };
    if (enabled(level)) body.reasoning_effort = level;
    return;
  }
  if (model.provider === "openrouter") {
    if (enabled(level)) body.reasoning = { effort: level };
    return;
  }
  if (enabled(level)) body.reasoning_effort = level;
}

function buildBody(model: ModelInfo, ctx: LlmContext, opts?: StreamOpts): Json {
  const body: Json = {
    model: model.id,
    messages: convertMessages(ctx.messages, ctx.systemPrompt),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: opts?.maxTokens ?? model.maxOutput,
  };
  if (ctx.tools && ctx.tools.length > 0) {
    body.tools = ctx.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    body.tool_choice = "auto";
  }
  if (opts?.temperature !== undefined) body.temperature = opts.temperature;
  if (opts?.sessionId) {
    if (model.provider === "openrouter") {
      body.user = opts.sessionId;
    } else {
      body.prompt_cache_key = opts.sessionId;
    }
  }
  addThinking(body, model, opts?.thinkingLevel);
  return body;
}

interface ToolState {
  contentIndex: number;
  partialJson: string;
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function streamOpenAICompletions(
  model: ModelInfo,
  ctx: LlmContext,
  opts?: StreamOpts,
): AssistantStream {
  return driveStream(model, opts, async (stream, output) => {
    const body = buildBody(model, ctx, opts);
    const response = await withRetries(
      async () => {
        const credential = await resolveProviderCredential(model, opts);
        const baseUrl = credentialBaseUrl(model, credential, opts);
        return postSse(
          apiPath(baseUrl, "/chat/completions"),
          { ...credentialHeaders(model, credential), ...opts?.headers },
          body,
          opts,
        );
      },
      {
        ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      },
    );

    stream.push({ type: "start", partial: output });
    let textIndex = -1;
    let thinkingIndex = -1;
    const tools = new Map<number, ToolState>();
    const responseBody = response.body as ReadableStream<Uint8Array>;

    for await (const sse of iterateSse(responseBody, opts?.signal)) {
      if (!sse.data || sse.data === "[DONE]") continue;
      const event = JSON.parse(sse.data) as Json;
      const usage = event.usage as Json | undefined;
      if (usage) {
        const promptDetails = usage.prompt_tokens_details as Json | undefined;
        const cached = usageNumber(promptDetails?.cached_tokens);
        output.usage.inputTokens = Math.max(0, usageNumber(usage.prompt_tokens) - cached);
        output.usage.cacheReadTokens = cached;
        output.usage.outputTokens = usageNumber(usage.completion_tokens);
        updateCost(model, output);
      }

      const choice = (event.choices as Json[] | undefined)?.[0];
      if (!choice) continue;
      const delta = (choice.delta as Json | undefined) ?? {};
      const reasoning =
        typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : "";
      if (reasoning) {
        if (thinkingIndex === -1) {
          thinkingIndex = output.content.length;
          output.content.push({ type: "thinking", thinking: "" });
          stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
        }
        const block = output.content[thinkingIndex];
        if (block?.type === "thinking") {
          block.thinking += reasoning;
          stream.push({
            type: "thinking_delta",
            contentIndex: thinkingIndex,
            delta: reasoning,
            partial: output,
          });
        }
      }

      if (typeof delta.content === "string" && delta.content) {
        if (textIndex === -1) {
          textIndex = output.content.length;
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
        }
        const block = output.content[textIndex];
        if (block?.type === "text") {
          block.text += delta.content;
          stream.push({
            type: "text_delta",
            contentIndex: textIndex,
            delta: delta.content,
            partial: output,
          });
        }
      }

      for (const toolDelta of (delta.tool_calls as Json[] | undefined) ?? []) {
        const apiIndex = usageNumber(toolDelta.index);
        let state = tools.get(apiIndex);
        const fn = (toolDelta.function as Json | undefined) ?? {};
        if (!state) {
          const contentIndex = output.content.length;
          state = { contentIndex, partialJson: "" };
          tools.set(apiIndex, state);
          output.content.push({
            type: "toolCall",
            id: String(toolDelta.id ?? `call_${apiIndex}`),
            name: String(fn.name ?? ""),
            arguments: {},
          });
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
        }
        const block = output.content[state.contentIndex];
        if (block?.type !== "toolCall") continue;
        if (typeof toolDelta.id === "string") block.id = toolDelta.id;
        if (typeof fn.name === "string" && fn.name) block.name += fn.name;
        if (typeof fn.arguments === "string") {
          state.partialJson += fn.arguments;
          block.arguments = salvageToolArgs(state.partialJson);
          stream.push({
            type: "toolcall_delta",
            contentIndex: state.contentIndex,
            delta: fn.arguments,
            partial: output,
          });
        }
      }

      const finishReason = choice.finish_reason;
      if (typeof finishReason === "string") {
        output.stopReason =
          finishReason === "length"
            ? "length"
            : finishReason === "tool_calls" || tools.size > 0
              ? "toolUse"
              : "end";
      }
    }

    if (thinkingIndex !== -1) {
      const block = output.content[thinkingIndex];
      if (block?.type === "thinking") {
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingIndex,
          content: block.thinking,
          partial: output,
        });
      }
    }
    if (textIndex !== -1) {
      const block = output.content[textIndex];
      if (block?.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: textIndex,
          content: block.text,
          partial: output,
        });
      }
    }
    for (const state of tools.values()) {
      const block = output.content[state.contentIndex];
      if (block?.type !== "toolCall") continue;
      block.arguments = salvageToolArgs(state.partialJson);
      stream.push({
        type: "toolcall_end",
        contentIndex: state.contentIndex,
        toolCall: block,
        partial: output,
      });
    }
    if (tools.size > 0 && output.stopReason === "end") output.stopReason = "toolUse";
  });
}

export const openaiCompletions: Provider = {
  id: "openai-completions",
  stream: streamOpenAICompletions,
};
