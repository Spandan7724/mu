import { classifyHttpError } from "../errors.ts";
import { salvageToolArgs } from "../json.ts";
import { withRetries } from "../retry.ts";
import { iterateSse } from "../sse.ts";
import type { AssistantStream } from "../stream.ts";
import type {
  AiMessage,
  Credential,
  LlmContext,
  ModelInfo,
  Provider,
  ProviderModelDiscoveryOptions,
  StreamOpts,
} from "../types.ts";
import {
  apiPath,
  credentialBaseUrl,
  credentialHeaders,
  resolveProviderCredential,
} from "./request.ts";
import { driveStream, postSse, updateCost } from "./shared.ts";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const MAX_OPENAI_CACHE_KEY_LENGTH = 64;
const DEFAULT_CODEX_MAX_OUTPUT = 128_000;
const ZERO_PRICING = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type Json = Record<string, unknown>;

function codexSessionId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, MAX_OPENAI_CACHE_KEY_LENGTH) : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function codexModelInfo(
  value: unknown,
  currentModels: readonly ModelInfo[],
): (ModelInfo & { priority: number }) | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const model = value as Json;
  if (
    typeof model.slug !== "string" ||
    model.slug.length === 0 ||
    model.supported_in_api === false ||
    (typeof model.visibility === "string" && model.visibility !== "list")
  ) {
    return undefined;
  }
  const fallback = currentModels.find(
    (candidate) => candidate.provider === "openai-codex" && candidate.id === model.slug,
  );
  const contextWindow =
    positiveNumber(model.context_window) ??
    positiveNumber(model.max_context_window) ??
    fallback?.contextWindow;
  if (!contextWindow) return undefined;
  const inputModalities = Array.isArray(model.input_modalities)
    ? model.input_modalities.filter((item): item is string => typeof item === "string")
    : [];
  const modalities: ModelInfo["modalities"] = ["text"];
  if (inputModalities.includes("image") || fallback?.modalities.includes("image")) {
    modalities.push("image");
  }
  const reasoningLevels = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
    : [];
  return {
    provider: "openai-codex",
    id: model.slug,
    ...(typeof model.display_name === "string" ? { name: model.display_name } : {}),
    contextWindow,
    maxOutput: fallback?.maxOutput ?? DEFAULT_CODEX_MAX_OUTPUT,
    modalities,
    ...(reasoningLevels.length > 0 || fallback?.thinking ? { thinking: true } : {}),
    pricing: fallback?.pricing ?? ZERO_PRICING,
    priority: finiteNumber(model.priority) ?? Number.MAX_SAFE_INTEGER,
  };
}

export async function discoverOpenAICodexModels(
  options: ProviderModelDiscoveryOptions,
): Promise<ModelInfo[] | undefined> {
  const credential = await options.getCredentials?.();
  if (!credential || credential.type !== "oauth" || !credential.accountId) return undefined;

  const url = new URL(`${CODEX_BASE_URL}/models`);
  url.searchParams.set("client_version", options.clientVersion ?? "0.0.0");
  const response = await (options.fetch ?? fetch)(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential.accessToken}`,
      "chatgpt-account-id": credential.accountId,
      originator: "mu",
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw classifyHttpError(response.status, await response.text(), response.headers);
  }
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as Json).models)) {
    throw new Error("Could not discover ChatGPT models: invalid catalog response");
  }
  const catalogModels = (payload as { models: unknown[] }).models;
  if (catalogModels.length === 0) {
    throw new Error("Could not discover ChatGPT models: catalog returned no models");
  }
  const discovered = catalogModels
    .map((model) => codexModelInfo(model, options.currentModels))
    .filter((model): model is ModelInfo & { priority: number } => model !== undefined)
    .sort((left, right) => left.priority - right.priority)
    .map(({ priority: _priority, ...model }) => model);
  if (discovered.length === 0) {
    throw new Error("Could not discover ChatGPT models: catalog contained no compatible models");
  }
  return discovered;
}

function resolveAuthMode(
  credential: Credential,
  opts?: StreamOpts,
  model?: ModelInfo,
): { url: string; headers: Record<string, string> } {
  if (model?.provider === "openai-codex") {
    if (credential.type !== "oauth" || !credential.accountId) {
      throw new Error("OpenAI Codex requires a ChatGPT account credential");
    }
    const base = (opts?.baseUrl ?? CODEX_BASE_URL).replace(/\/+$/, "");
    const sessionId = codexSessionId(opts?.sessionId);
    return {
      url: `${base}/responses`,
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "chatgpt-account-id": credential.accountId,
        originator: "mu",
        "openai-beta": "responses=experimental",
        ...(sessionId
          ? {
              "session-id": sessionId,
              "x-client-request-id": sessionId,
            }
          : {}),
      },
    };
  }
  if (!model) throw new Error("A model is required");
  const base = credentialBaseUrl(model, credential, opts);
  return {
    url: apiPath(base, "/responses"),
    headers: credentialHeaders(model, credential),
  };
}

interface ReasoningSignature {
  id: string;
  encrypted_content?: string;
}

function convertInput(messages: AiMessage[]): Json[] {
  const items: Json[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      items.push({
        role: "user",
        content: msg.content.map((block) =>
          block.type === "text"
            ? { type: "input_text", text: block.text }
            : { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` },
        ),
      });
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          items.push({ role: "assistant", content: [{ type: "output_text", text: block.text }] });
        } else if (block.type === "thinking") {
          if (!block.signature) continue;
          try {
            const sig = JSON.parse(block.signature) as ReasoningSignature;
            items.push({
              type: "reasoning",
              id: sig.id,
              summary: [],
              ...(sig.encrypted_content ? { encrypted_content: sig.encrypted_content } : {}),
            });
          } catch {
            // Unparseable signature: drop the reasoning item.
          }
        } else {
          items.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.arguments ?? {}),
          });
        }
      }
    } else {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      items.push({ type: "function_call_output", call_id: msg.toolCallId, output: text });
    }
  }
  return items;
}

function buildBody(model: ModelInfo, ctx: LlmContext, opts?: StreamOpts): Json {
  const isCodex = model.provider === "openai-codex";
  const body: Json = {
    model: model.id,
    input: convertInput(ctx.messages),
    stream: true,
    store: false,
  };
  if (!isCodex) body.max_output_tokens = opts?.maxTokens ?? model.maxOutput;
  if (ctx.systemPrompt && ctx.systemPrompt.length > 0) {
    body.instructions = ctx.systemPrompt.map((s) => s.text).join("\n\n");
  } else if (isCodex) {
    body.instructions = "You are a helpful assistant.";
  }
  if (ctx.tools && ctx.tools.length > 0) {
    body.tools = ctx.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: isCodex ? null : false,
    }));
  }
  if (isCodex) {
    body.text = { verbosity: "low" };
    body.include = ["reasoning.encrypted_content"];
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
    const sessionId = codexSessionId(opts?.sessionId);
    if (sessionId) body.prompt_cache_key = sessionId;
  }
  if (opts?.temperature !== undefined) body.temperature = opts.temperature;
  if (model.thinking && opts?.thinkingLevel && opts.thinkingLevel !== "off") {
    body.reasoning = { effort: opts.thinkingLevel, summary: "auto" };
    if (!isCodex) body.include = ["reasoning.encrypted_content"];
  }
  return body;
}

interface ItemState {
  contentIndex: number;
  kind: "text" | "reasoning" | "function_call";
  partialJson: string;
}

export function streamOpenAI(
  model: ModelInfo,
  ctx: LlmContext,
  opts?: StreamOpts,
): AssistantStream {
  return driveStream(model, opts, async (stream, output) => {
    const body = buildBody(model, ctx, opts);
    const response = await withRetries(
      async () => {
        const credential = await resolveProviderCredential(model, opts);
        const { url, headers } = resolveAuthMode(credential, opts, model);
        return postSse(url, { ...headers, ...opts?.headers }, body, opts);
      },
      {
        ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      },
    );

    stream.push({ type: "start", partial: output });
    const items = new Map<number, ItemState>();
    let sawFunctionCall = false;
    const responseBody = response.body as ReadableStream<Uint8Array>;

    for await (const sse of iterateSse(responseBody, opts?.signal)) {
      if (!sse.data || sse.data === "[DONE]") continue;
      const event = JSON.parse(sse.data) as Json;
      const type = event.type as string;

      if (type === "response.output_item.added") {
        const item = event.item as Json;
        const outputIndex = event.output_index as number;
        const kind = item.type as string;
        const contentIndex = output.content.length;
        if (kind === "message") {
          items.set(outputIndex, { contentIndex, kind: "text", partialJson: "" });
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex, partial: output });
        } else if (kind === "reasoning") {
          items.set(outputIndex, { contentIndex, kind: "reasoning", partialJson: "" });
          output.content.push({
            type: "thinking",
            thinking: "",
            signature: JSON.stringify({ id: item.id as string }),
          });
          stream.push({ type: "thinking_start", contentIndex, partial: output });
        } else if (kind === "function_call") {
          sawFunctionCall = true;
          items.set(outputIndex, { contentIndex, kind: "function_call", partialJson: "" });
          output.content.push({
            type: "toolCall",
            id: (item.call_id as string) ?? (item.id as string),
            name: item.name as string,
            arguments: {},
          });
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
        }
      } else if (type === "response.output_text.delta") {
        const state = items.get(event.output_index as number);
        const block = state && output.content[state.contentIndex];
        if (state && block?.type === "text") {
          block.text += event.delta as string;
          stream.push({
            type: "text_delta",
            contentIndex: state.contentIndex,
            delta: event.delta as string,
            partial: output,
          });
        }
      } else if (type === "response.reasoning_summary_text.delta") {
        const state = items.get(event.output_index as number);
        const block = state && output.content[state.contentIndex];
        if (state && block?.type === "thinking") {
          block.thinking += event.delta as string;
          stream.push({
            type: "thinking_delta",
            contentIndex: state.contentIndex,
            delta: event.delta as string,
            partial: output,
          });
        }
      } else if (type === "response.function_call_arguments.delta") {
        const state = items.get(event.output_index as number);
        const block = state && output.content[state.contentIndex];
        if (state && block?.type === "toolCall") {
          state.partialJson += event.delta as string;
          block.arguments = salvageToolArgs(state.partialJson);
          stream.push({
            type: "toolcall_delta",
            contentIndex: state.contentIndex,
            delta: event.delta as string,
            partial: output,
          });
        }
      } else if (type === "response.output_item.done") {
        const state = items.get(event.output_index as number);
        if (!state) continue;
        const item = event.item as Json;
        const block = output.content[state.contentIndex];
        if (block?.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: state.contentIndex,
            content: block.text,
            partial: output,
          });
        } else if (block?.type === "thinking") {
          block.signature = JSON.stringify({
            id: item.id as string,
            ...(item.encrypted_content
              ? { encrypted_content: item.encrypted_content as string }
              : {}),
          } satisfies ReasoningSignature);
          stream.push({
            type: "thinking_end",
            contentIndex: state.contentIndex,
            content: block.thinking,
            partial: output,
          });
        } else if (block?.type === "toolCall") {
          const args = (item.arguments as string) ?? state.partialJson;
          block.arguments = salvageToolArgs(args);
          stream.push({
            type: "toolcall_end",
            contentIndex: state.contentIndex,
            toolCall: block,
            partial: output,
          });
        }
      } else if (
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed"
      ) {
        const resp = event.response as Json;
        const usage = resp.usage as Json | undefined;
        if (usage) {
          const details = usage.input_tokens_details as Json | undefined;
          const cached = (details?.cached_tokens as number) ?? 0;
          output.usage.inputTokens = ((usage.input_tokens as number) ?? 0) - cached;
          output.usage.cacheReadTokens = cached;
          output.usage.outputTokens = (usage.output_tokens as number) ?? 0;
          updateCost(model, output);
        }
        if (type === "response.completed") {
          output.stopReason = sawFunctionCall ? "toolUse" : "end";
        } else if (type === "response.incomplete") {
          const reason = (resp.incomplete_details as Json | undefined)?.reason as string;
          output.stopReason = reason === "max_output_tokens" ? "length" : "end";
        } else {
          const err = resp.error as Json | undefined;
          output.stopReason = "error";
          output.errorMessage = (err?.message as string) ?? "response failed";
        }
      } else if (type === "error") {
        throw new Error((event.message as string) ?? sse.data);
      }
    }
  });
}

export const openai: Provider = { id: "openai", stream: streamOpenAI };
export const openaiCodex: Provider = {
  id: "openai-codex",
  stream: streamOpenAI,
  discoverModels: discoverOpenAICodexModels,
};
