import { AiError } from "../errors.ts";
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
import { credentialBaseUrl, credentialHeaders, resolveProviderCredential } from "./request.ts";
import { driveStream, postSse, updateCost } from "./shared.ts";

type Json = Record<string, unknown>;

function convertContents(messages: AiMessage[]): {
  contents: Json[];
  toolNames: Map<string, string>;
} {
  const contents: Json[] = [];
  const toolNames = new Map<string, string>(); // toolCallId -> function name

  const push = (role: "user" | "model", parts: Json[]) => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      (last.parts as Json[]).push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      push(
        "user",
        msg.content.map((block) =>
          block.type === "text"
            ? { text: block.text }
            : { inlineData: { mimeType: block.mimeType, data: block.data } },
        ),
      );
    } else if (msg.role === "assistant") {
      const parts: Json[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) parts.push({ text: block.text });
        } else if (block.type === "thinking") {
          // Gemini replays thoughts only via thought signatures on later parts;
          // plain thinking text is not resent.
        } else {
          toolNames.set(block.id, block.name);
          parts.push({
            functionCall: { name: block.name, args: block.arguments ?? {} },
            ...(block.signature ? { thoughtSignature: block.signature } : {}),
          });
        }
      }
      push("model", parts);
    } else {
      const name = toolNames.get(msg.toolCallId) ?? msg.toolName;
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const parts: Json[] = [
        {
          functionResponse: {
            name,
            response: msg.isError ? { error: text } : { output: text },
          },
        },
      ];
      for (const block of msg.content) {
        if (block.type === "image") {
          parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
        }
      }
      push("user", parts);
    }
  }
  return { contents, toolNames };
}

function thinkingBudget(level: ThinkingLevel): number {
  switch (level) {
    case "off":
      return 0;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 24576;
  }
}

function buildBody(model: ModelInfo, ctx: LlmContext, opts?: StreamOpts): Json {
  const body: Json = { contents: convertContents(ctx.messages).contents };
  if (ctx.systemPrompt && ctx.systemPrompt.length > 0) {
    body.systemInstruction = { parts: ctx.systemPrompt.map((s) => ({ text: s.text })) };
  }
  if (ctx.tools && ctx.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: ctx.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      },
    ];
  }
  const generationConfig: Json = { maxOutputTokens: opts?.maxTokens ?? model.maxOutput };
  if (opts?.temperature !== undefined) generationConfig.temperature = opts.temperature;
  if (model.thinking && opts?.thinkingLevel) {
    generationConfig.thinkingConfig = {
      thinkingBudget: thinkingBudget(opts.thinkingLevel),
      includeThoughts: opts.thinkingLevel !== "off",
    };
  }
  body.generationConfig = generationConfig;
  return body;
}

function mapFinishReason(
  reason: string,
  sawToolCall: boolean,
): { stopReason: "end" | "toolUse" | "length" | "error"; errorMessage?: string } {
  switch (reason) {
    case "STOP":
      return { stopReason: sawToolCall ? "toolUse" : "end" };
    case "MAX_TOKENS":
      return { stopReason: "length" };
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return { stopReason: "error", errorMessage: `Generation stopped: ${reason}` };
    default:
      return { stopReason: sawToolCall ? "toolUse" : "end" };
  }
}

export function streamGemini(
  model: ModelInfo,
  ctx: LlmContext,
  opts?: StreamOpts,
): AssistantStream {
  return driveStream(model, opts, async (stream, output) => {
    const body = buildBody(model, ctx, opts);
    const response = await withRetries(
      async () => {
        const credential = await resolveProviderCredential(model, opts);
        if (credential.type !== "apiKey") {
          throw new AiError("auth", `${model.provider} requires API-key auth`);
        }
        const baseUrl = credentialBaseUrl(model, credential, opts).replace(/\/+$/, "");
        const path =
          model.provider === "google-vertex"
            ? `/models/${model.id}:streamGenerateContent?alt=sse`
            : `/models/${model.id}:streamGenerateContent?alt=sse`;
        const url = `${baseUrl}${path}`;
        return postSse(
          url,
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
    let openText = -1; // content index of the text/thinking block currently accumulating
    let openThinking = -1;
    let toolCallCounter = 0;
    let sawToolCall = false;
    let finishReason: string | undefined;
    const responseBody = response.body as ReadableStream<Uint8Array>;

    const closeOpenBlocks = () => {
      if (openText !== -1) {
        const block = output.content[openText];
        if (block?.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: openText,
            content: block.text,
            partial: output,
          });
        }
        openText = -1;
      }
      if (openThinking !== -1) {
        const block = output.content[openThinking];
        if (block?.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex: openThinking,
            content: block.thinking,
            partial: output,
          });
        }
        openThinking = -1;
      }
    };

    for await (const sse of iterateSse(responseBody, opts?.signal)) {
      if (!sse.data) continue;
      const chunk = JSON.parse(sse.data) as Json;
      const candidate = (chunk.candidates as Json[] | undefined)?.[0];

      const usage = chunk.usageMetadata as Json | undefined;
      if (usage) {
        const cached = (usage.cachedContentTokenCount as number) ?? 0;
        output.usage.inputTokens = ((usage.promptTokenCount as number) ?? 0) - cached;
        output.usage.cacheReadTokens = cached;
        output.usage.outputTokens =
          ((usage.candidatesTokenCount as number) ?? 0) +
          ((usage.thoughtsTokenCount as number) ?? 0);
        updateCost(model, output);
      }
      if (!candidate) continue;

      const parts = ((candidate.content as Json | undefined)?.parts as Json[] | undefined) ?? [];
      for (const part of parts) {
        if (typeof part.text === "string") {
          if (part.thought === true) {
            if (openThinking === -1) {
              openThinking = output.content.length;
              output.content.push({ type: "thinking", thinking: "" });
              stream.push({ type: "thinking_start", contentIndex: openThinking, partial: output });
            }
            const block = output.content[openThinking];
            if (block?.type === "thinking") {
              block.thinking += part.text;
              if (typeof part.thoughtSignature === "string") {
                block.signature = part.thoughtSignature;
              }
              stream.push({
                type: "thinking_delta",
                contentIndex: openThinking,
                delta: part.text,
                partial: output,
              });
            }
          } else {
            if (openText === -1) {
              openText = output.content.length;
              output.content.push({ type: "text", text: "" });
              stream.push({ type: "text_start", contentIndex: openText, partial: output });
            }
            const block = output.content[openText];
            if (block?.type === "text") {
              block.text += part.text;
              stream.push({
                type: "text_delta",
                contentIndex: openText,
                delta: part.text,
                partial: output,
              });
            }
          }
        } else if (part.functionCall) {
          sawToolCall = true;
          const call = part.functionCall as Json;
          const contentIndex = output.content.length;
          const toolCall = {
            type: "toolCall" as const,
            id: `call_${toolCallCounter++}_${call.name as string}`,
            name: call.name as string,
            arguments: (call.args as Record<string, unknown>) ?? {},
            ...(typeof part.thoughtSignature === "string"
              ? { signature: part.thoughtSignature }
              : {}),
          };
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
        }
      }

      if (typeof candidate.finishReason === "string") {
        finishReason = candidate.finishReason;
      }
    }

    closeOpenBlocks();
    const mapped = mapFinishReason(finishReason ?? "STOP", sawToolCall);
    output.stopReason = mapped.stopReason;
    if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
  });
}

export const gemini: Provider = { id: "google", stream: streamGemini };
