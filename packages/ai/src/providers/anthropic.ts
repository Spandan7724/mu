import { salvageToolArgs } from "../json.ts";
import { withRetries } from "../retry.ts";
import { iterateSse } from "../sse.ts";
import type { AssistantStream } from "../stream.ts";
import type {
  AiMessage,
  AssistantContent,
  LlmContext,
  ModelInfo,
  Provider,
  StopReason,
  StreamOpts,
  ThinkingLevel,
  ToolResultContent,
  UserContent,
} from "../types.ts";
import {
  apiPath,
  credentialBaseUrl,
  credentialHeaders,
  resolveProviderCredential,
} from "./request.ts";
import { driveStream, postSse, updateCost } from "./shared.ts";

const API_VERSION = "2023-06-01";

const CACHE_CONTROL = { type: "ephemeral" } as const;

type Json = Record<string, unknown>;

function convertUserBlocks(content: (UserContent | ToolResultContent)[]): Json[] {
  return content
    .filter((block) => block.type !== "text" || block.text.trim().length > 0)
    .map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : {
            type: "image",
            source: { type: "base64", media_type: block.mimeType, data: block.data },
          },
    );
}

function convertAssistantBlocks(content: AssistantContent[]): Json[] {
  const blocks: Json[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.trim().length === 0) continue;
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      if (block.redacted) {
        blocks.push({ type: "redacted_thinking", data: block.signature ?? "" });
      } else if (block.signature) {
        blocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      } else if (block.thinking.trim().length > 0) {
        // Unsigned thinking (e.g. from an aborted stream) is replayed as text.
        blocks.push({ type: "text", text: block.thinking });
      }
    } else {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments ?? {},
      });
    }
  }
  return blocks;
}

function convertMessages(messages: AiMessage[], cacheControl: boolean): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as AiMessage;
    if (msg.role === "user") {
      const blocks = convertUserBlocks(msg.content);
      if (blocks.length > 0) out.push({ role: "user", content: blocks });
    } else if (msg.role === "assistant") {
      const blocks = convertAssistantBlocks(msg.content);
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
    } else {
      // Group consecutive tool results into one user message.
      const results: Json[] = [];
      while (i < messages.length) {
        const m = messages[i];
        if (!m || m.role !== "toolResult") break;
        results.push({
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: convertUserBlocks(m.content),
          is_error: m.isError,
        });
        i++;
      }
      i--;
      out.push({ role: "user", content: results });
    }
  }
  // Recent-message cache breakpoint.
  const last = out[out.length - 1];
  if (cacheControl && last && last.role === "user") {
    const content = last.content as Json[];
    const lastBlock = content[content.length - 1];
    if (lastBlock) lastBlock.cache_control = CACHE_CONTROL;
  }
  return out;
}

function buildThinking(model: ModelInfo, level: ThinkingLevel | undefined, body: Json): void {
  if (!model.thinking || level === undefined) return;
  if (level === "off") {
    body.thinking = { type: "disabled" };
    return;
  }
  if (model.thinkingMode === "budget") {
    const budgets: Record<string, number> = { low: 4096, medium: 8192, high: 16384 };
    body.thinking = {
      type: "enabled",
      budget_tokens: budgets[level] ?? 8192,
      display: "summarized",
    };
    return;
  }
  body.thinking = { type: "adaptive", display: "summarized" };
  body.output_config = { effort: level };
}

function buildBody(model: ModelInfo, ctx: LlmContext, opts?: StreamOpts): Json {
  const cacheControl = model.provider === "anthropic";
  const body: Json = {
    model: model.id,
    max_tokens: opts?.maxTokens ?? model.maxOutput,
    messages: convertMessages(ctx.messages, cacheControl),
    stream: true,
  };

  if (ctx.systemPrompt && ctx.systemPrompt.length > 0) {
    const lastStatic = ctx.systemPrompt.reduce(
      (acc, section, i) => (section.dynamic ? acc : i),
      -1,
    );
    body.system = ctx.systemPrompt.map((section, i) => ({
      type: "text",
      text: section.text,
      // Cache breakpoint at the static→dynamic boundary.
      ...(cacheControl && i === lastStatic ? { cache_control: CACHE_CONTROL } : {}),
    }));
  }

  if (ctx.tools && ctx.tools.length > 0) {
    body.tools = ctx.tools.map((tool, i) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(cacheControl && i === (ctx.tools?.length ?? 0) - 1
        ? { cache_control: CACHE_CONTROL }
        : {}),
    }));
  }

  if (opts?.temperature !== undefined) body.temperature = opts.temperature;
  buildThinking(model, opts?.thinkingLevel, body);
  return body;
}

function mapStopReason(reason: string): { stopReason: StopReason; errorMessage?: string } {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return { stopReason: "end" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return { stopReason: "error", errorMessage: "The model refused to complete the request" };
    case "model_context_window_exceeded":
      return { stopReason: "error", errorMessage: "Context window exceeded" };
    default:
      return { stopReason: "end" };
  }
}

interface BlockState {
  contentIndex: number;
  partialJson: string;
}

export function streamAnthropic(
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
        const headers: Record<string, string> = {
          "anthropic-version": API_VERSION,
          ...credentialHeaders(model, credential),
          ...opts?.headers,
        };
        return postSse(apiPath(baseUrl, "/v1/messages"), headers, body, opts);
      },
      {
        ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      },
    );

    stream.push({ type: "start", partial: output });
    const blocks = new Map<number, BlockState>();
    const responseBody = response.body as ReadableStream<Uint8Array>;

    for await (const sse of iterateSse(responseBody, opts?.signal)) {
      if (sse.event === "error") throw new Error(sse.data);
      if (!sse.data) continue;
      const event = JSON.parse(sse.data) as Json;
      const type = event.type as string;

      if (type === "message_start") {
        const usage = (event.message as Json | undefined)?.usage as Json | undefined;
        if (usage) {
          output.usage.inputTokens = (usage.input_tokens as number) ?? 0;
          output.usage.outputTokens = (usage.output_tokens as number) ?? 0;
          output.usage.cacheReadTokens = (usage.cache_read_input_tokens as number) ?? 0;
          output.usage.cacheWriteTokens = (usage.cache_creation_input_tokens as number) ?? 0;
          updateCost(model, output);
        }
      } else if (type === "content_block_start") {
        const apiIndex = event.index as number;
        const blockDef = event.content_block as Json;
        const contentIndex = output.content.length;
        blocks.set(apiIndex, { contentIndex, partialJson: "" });
        const kind = blockDef.type as string;
        if (kind === "text") {
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex, partial: output });
        } else if (kind === "thinking") {
          output.content.push({ type: "thinking", thinking: "", signature: "" });
          stream.push({ type: "thinking_start", contentIndex, partial: output });
        } else if (kind === "redacted_thinking") {
          output.content.push({
            type: "thinking",
            thinking: "[reasoning redacted]",
            signature: (blockDef.data as string) ?? "",
            redacted: true,
          });
          stream.push({ type: "thinking_start", contentIndex, partial: output });
        } else if (kind === "tool_use") {
          output.content.push({
            type: "toolCall",
            id: blockDef.id as string,
            name: blockDef.name as string,
            arguments: (blockDef.input as Record<string, unknown>) ?? {},
          });
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
        } else {
          blocks.delete(apiIndex);
        }
      } else if (type === "content_block_delta") {
        const state = blocks.get(event.index as number);
        if (!state) continue;
        const block = output.content[state.contentIndex];
        const delta = event.delta as Json;
        const deltaType = delta.type as string;
        if (deltaType === "text_delta" && block?.type === "text") {
          block.text += delta.text as string;
          stream.push({
            type: "text_delta",
            contentIndex: state.contentIndex,
            delta: delta.text as string,
            partial: output,
          });
        } else if (deltaType === "thinking_delta" && block?.type === "thinking") {
          block.thinking += delta.thinking as string;
          stream.push({
            type: "thinking_delta",
            contentIndex: state.contentIndex,
            delta: delta.thinking as string,
            partial: output,
          });
        } else if (deltaType === "input_json_delta" && block?.type === "toolCall") {
          state.partialJson += delta.partial_json as string;
          block.arguments = salvageToolArgs(state.partialJson);
          stream.push({
            type: "toolcall_delta",
            contentIndex: state.contentIndex,
            delta: delta.partial_json as string,
            partial: output,
          });
        } else if (deltaType === "signature_delta" && block?.type === "thinking") {
          block.signature = (block.signature ?? "") + (delta.signature as string);
        }
      } else if (type === "content_block_stop") {
        const state = blocks.get(event.index as number);
        if (!state) continue;
        const block = output.content[state.contentIndex];
        if (block?.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: state.contentIndex,
            content: block.text,
            partial: output,
          });
        } else if (block?.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex: state.contentIndex,
            content: block.thinking,
            partial: output,
          });
        } else if (block?.type === "toolCall") {
          block.arguments = salvageToolArgs(state.partialJson);
          stream.push({
            type: "toolcall_end",
            contentIndex: state.contentIndex,
            toolCall: block,
            partial: output,
          });
        }
      } else if (type === "message_delta") {
        const delta = event.delta as Json | undefined;
        if (delta?.stop_reason) {
          const mapped = mapStopReason(delta.stop_reason as string);
          output.stopReason = mapped.stopReason;
          if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
        }
        const usage = event.usage as Json | undefined;
        if (usage) {
          if (usage.input_tokens != null) output.usage.inputTokens = usage.input_tokens as number;
          if (usage.output_tokens != null) {
            output.usage.outputTokens = usage.output_tokens as number;
          }
          if (usage.cache_read_input_tokens != null) {
            output.usage.cacheReadTokens = usage.cache_read_input_tokens as number;
          }
          if (usage.cache_creation_input_tokens != null) {
            output.usage.cacheWriteTokens = usage.cache_creation_input_tokens as number;
          }
          updateCost(model, output);
        }
      }
    }
  });
}

export const anthropic: Provider = { id: "anthropic", stream: streamAnthropic };
