import type { AssistantMessage, LlmContext, ModelInfo, Provider, StreamOpts, Usage } from "@mu/ai";
import type { AgentMessage } from "./messages.ts";
import { isContextTooLongResult } from "./recovery.ts";

// Layer 0 — accounting. Context usage is read from real API usage where
// available and estimated otherwise; the estimate is deliberately conservative
// (over- rather than under-reporting) so the trigger fires before a hard fail.
const CHARS_PER_TOKEN = 3.5;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (message.role === "toolResult" || message.role === "user" || message.role === "custom") {
      for (const block of message.content) {
        chars += block.type === "text" ? block.text.length : 1_500; // images are costly
      }
    } else {
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else chars += JSON.stringify(block.arguments).length + block.name.length;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface ContextState {
  tokens: number;
  limit: number;
  percent: number;
}

// The live context size is the input side of the most recent assistant turn
// (which the provider reports exactly), not the running session total.
export function contextState(
  model: ModelInfo,
  messages: AgentMessage[],
  lastUsage?: Usage,
  estimatedTokensAtLastUsage?: number,
): ContextState {
  const estimated = estimateTokens(messages);
  const reported = lastUsage
    ? lastUsage.inputTokens + lastUsage.cacheReadTokens + lastUsage.cacheWriteTokens
    : 0;
  const estimatedGrowth =
    lastUsage && estimatedTokensAtLastUsage !== undefined
      ? Math.max(0, estimated - estimatedTokensAtLastUsage)
      : 0;
  const tokens = Math.max(reported + estimatedGrowth, estimated);
  const limit = model.contextWindow;
  return { tokens, limit, percent: limit > 0 ? tokens / limit : 0 };
}

export const AUTO_COMPACT_THRESHOLD = 0.85;

export function shouldCompact(state: ContextState, threshold = AUTO_COMPACT_THRESHOLD): boolean {
  return state.percent >= threshold;
}

export interface CompactionRequest {
  messages: AgentMessage[];
  // Messages after this index are kept verbatim; everything before is summarized.
  keepFromIndex: number;
  carryover?: unknown;
}

export interface CompactionPlan {
  keepFromIndex: number;
  keptTokens: number;
  isSplitTurn: boolean;
  turnStartIndex: number | null;
}

export interface CompactionResult {
  summary: string;
  carryover?: unknown;
  keptMessages: AgentMessage[];
  tokensFreed: number;
  usage: Usage;
}

type CompactionTranscript = Omit<CompactionResult, "usage">;

export class CompactionError extends Error {
  constructor(
    message: string,
    readonly usage?: Usage,
  ) {
    super(message);
    this.name = "CompactionError";
  }
}

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

function turnStartBefore(messages: AgentMessage[], index: number): number | null {
  for (let i = Math.min(index, messages.length - 1); i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return null;
}

// Keeps a token-bounded recent tail intact so one huge tool result cannot
// defeat compaction merely by being a single message. A short transcript is
// summarized as a whole when compaction was explicitly requested.
export function planCompaction(
  messages: AgentMessage[],
  keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS,
): CompactionPlan {
  if (messages.length <= 4 && estimateTokens(messages) <= keepRecentTokens) {
    return {
      keepFromIndex: messages.length,
      keptTokens: 0,
      isSplitTurn: false,
      turnStartIndex: null,
    };
  }

  let keptTokens = 0;
  let index = messages.length;
  while (index > 0 && keptTokens < keepRecentTokens) {
    const candidateIndex = index - 1;
    const candidateTokens = estimateTokens([messages[candidateIndex] as AgentMessage]);
    if (keptTokens > 0 && keptTokens + candidateTokens > keepRecentTokens) break;
    index = candidateIndex;
    keptTokens += candidateTokens;
  }

  // A tool result belongs to the assistant tool call immediately before it.
  // Walk back across every adjacent result and retain the initiating assistant.
  while (index > 0 && messages[index]?.role === "toolResult") {
    index--;
    keptTokens += estimateTokens([messages[index] as AgentMessage]);
  }

  // Always summarize something when the transcript is larger than the target.
  // With one enormous first turn, keeping index zero would otherwise be a no-op.
  if (index === 0) {
    if (messages.length === 1) {
      // There is no exact suffix boundary inside one message. Summarizing the
      // oversized user message is the only operation that can free context.
      index = messages.length;
    } else {
      index = messages.findIndex(
        (message, messageIndex) => messageIndex > 0 && message.role !== "toolResult",
      );
      if (index < 0) index = messages.length;
    }
    keptTokens = estimateTokens(messages.slice(index));
  }

  const turnStartIndex = index < messages.length ? turnStartBefore(messages, index) : null;
  const isSplitTurn = turnStartIndex !== null && turnStartIndex < index;
  return { keepFromIndex: index, keptTokens, isSplitTurn, turnStartIndex };
}

export const SUMMARY_PROMPT = `Summarize the conversation so far so that work can continue without the original transcript.

Preserve, in this order:
1. What the user asked for — the goal, in their terms, including any constraints they stated.
2. Decisions taken and why, including approaches tried and rejected.
3. Current task state: what is done, what is in progress, what remains.
4. Concrete facts discovered that would be expensive to rediscover (file locations, API shapes, error messages, command invocations that work).
5. Anything the user corrected you on.

Be specific and factual. Do not include pleasantries or narration. This summary replaces the transcript, so anything you omit is lost.`;

const SPLIT_TURN_PROMPT = `The retained transcript begins part-way through a large user turn. Preserve the original request and the early progress needed to understand the retained suffix. Do not imply that the retained suffix starts a new task.`;

const TOOL_RESULT_MAX_CHARS = 2_000;
const TOOL_ARGUMENT_MAX_CHARS = 4_000;
const MAX_COMPACTOR_ATTEMPTS = 3;

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... ${text.length - maxChars} characters omitted]`;
}

function textBlocks(message: AgentMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// A single labelled user message keeps the summarizer from continuing the
// transcript as a chat. Large reproducible outputs and tool arguments are
// bounded without modifying the real session history.
export function serializeCompactionMessages(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textBlocks(message);
      if (text) parts.push(`[User]\n${text}`);
      if (message.content.some((block) => block.type === "image")) {
        parts.push("[User image omitted from compaction input]");
      }
      continue;
    }
    if (message.role === "custom") {
      const text = textBlocks(message);
      if (text) parts.push(`[Injected context: ${message.customType}]\n${text}`);
      continue;
    }
    if (message.role === "toolResult") {
      const text = truncateForSummary(textBlocks(message), TOOL_RESULT_MAX_CHARS);
      parts.push(
        `[Tool result: ${message.toolName}${message.isError ? " (error)" : ""}]\n${text || "(non-text output omitted)"}`,
      );
      continue;
    }

    const thinking = message.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("\n");
    const text = textBlocks(message);
    const calls = message.content
      .filter((block) => block.type === "toolCall")
      .map(
        (block) =>
          `${block.name}(${truncateForSummary(JSON.stringify(block.arguments), TOOL_ARGUMENT_MAX_CHARS)})`,
      )
      .join("\n");
    if (thinking) parts.push(`[Assistant thinking]\n${thinking}`);
    if (text) parts.push(`[Assistant]\n${text}`);
    if (calls) parts.push(`[Assistant tool calls]\n${calls}`);
  }
  return parts.join("\n\n");
}

export interface CompactorOptions {
  provider: Provider;
  model: ModelInfo;
  // Domain knowledge the kernel does not have — coding carries file lists.
  carryoverExtractor?: (messages: AgentMessage[]) => unknown;
  keepRecentTokens?: number;
  customInstructions?: string;
  signal?: AbortSignal;
  streamOpts?: StreamOpts;
}

// Layer 2 — full compaction. Core owns the machinery; the profile injects what
// its domain must not lose.
export async function compact(
  messages: AgentMessage[],
  options: CompactorOptions,
): Promise<CompactionResult> {
  const keepRecentTokens =
    options.keepRecentTokens ??
    Math.min(
      DEFAULT_KEEP_RECENT_TOKENS,
      Math.max(2, Math.floor(options.model.contextWindow * 0.2)),
    );
  const plan = planCompaction(messages, keepRecentTokens);
  const { keepFromIndex } = plan;
  const toSummarize = messages.slice(0, keepFromIndex);
  const keptMessages = messages.slice(keepFromIndex);

  if (toSummarize.length === 0) {
    return {
      summary: "",
      keptMessages: messages,
      tokensFreed: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    };
  }

  const carryover = options.carryoverExtractor?.(toSummarize);
  if (carryover !== undefined) assertJsonSerializable(carryover);

  const previousSummaryIndex = toSummarize.findIndex(
    (message) => message.role === "custom" && message.customType === "compaction-summary",
  );
  const previousSummary =
    previousSummaryIndex === -1
      ? undefined
      : textBlocks(toSummarize[previousSummaryIndex] as AgentMessage);
  let summarizationInput = toSummarize.filter((_, index) => index !== previousSummaryIndex);
  let result: AssistantMessage;
  let attempts = 0;
  for (;;) {
    const instructions = [
      SUMMARY_PROMPT,
      previousSummary ? "Update the previous summary with the newly summarized conversation." : "",
      plan.isSplitTurn ? SPLIT_TURN_PROMPT : "",
      options.customInstructions
        ? `Additional focus from the user: ${options.customInstructions}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const prompt = [
      `<conversation>\n${serializeCompactionMessages(summarizationInput)}\n</conversation>`,
      ...(previousSummary ? [`<previous-summary>\n${previousSummary}\n</previous-summary>`] : []),
      instructions,
      "Produce the summary now.",
    ].join("\n\n");
    const context: LlmContext = {
      systemPrompt: [
        {
          text: `You are a context summarization assistant. Do not continue the conversation. Output only the requested handoff summary.\n\n${SUMMARY_PROMPT}`,
        },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    };
    const stream = options.provider.stream(options.model, context, {
      ...options.streamOpts,
      sessionId: `${options.streamOpts?.sessionId ?? "mu"}:compact:${Date.now().toString(36)}:${attempts}`,
      maxTokens: Math.min(options.model.maxOutput, 8_192),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    result = await stream.result();
    if (
      !isContextTooLongResult(result) ||
      summarizationInput.length <= 1 ||
      attempts + 1 >= MAX_COMPACTOR_ATTEMPTS
    )
      break;
    // Preserve recent input and retry. The profile carryover still protects
    // authoritative structured state even when very old raw output is dropped.
    summarizationInput = summarizationInput.slice(
      Math.max(1, Math.floor(summarizationInput.length / 2)),
    );
    attempts++;
  }

  if (result.stopReason !== "end") {
    throw new CompactionError(
      `Compaction failed: ${result.errorMessage ?? `incomplete response (${result.stopReason})`}`,
      result.usage,
    );
  }

  const summary = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (summary.length === 0) {
    throw new CompactionError(
      "Compaction failed: the provider returned no usable summary",
      result.usage,
    );
  }

  const compacted: CompactionResult = {
    summary,
    ...(carryover !== undefined ? { carryover } : {}),
    keptMessages,
    tokensFreed: 0,
    usage: result.usage,
  };
  compacted.tokensFreed = Math.max(
    0,
    estimateTokens(messages) - estimateTokens(applyCompaction(compacted)),
  );
  return compacted;
}

// Renders a completed compaction back into a transcript: a typed summary
// message followed by the untouched tail.
export function applyCompaction(result: CompactionTranscript): AgentMessage[] {
  if (result.summary.length === 0) return result.keptMessages;

  return [compactionSummaryMessage(result.summary, result.carryover), ...result.keptMessages];
}

export function compactionSummaryMessage(
  summary: string,
  carryover?: unknown,
  timestamp = Date.now(),
): AgentMessage {
  const carryoverText =
    carryover === undefined ? "" : `\n\nCarried forward:\n${formatCarryover(carryover)}`;
  return {
    role: "custom",
    customType: "compaction-summary",
    content: [
      {
        type: "text",
        text: `Summary of the earlier conversation:\n\n${summary}${carryoverText}`,
      },
    ],
    display: false,
    timestamp,
  };
}

export function formatCarryover(carryover: unknown): string {
  if (typeof carryover === "string") return carryover;
  assertJsonSerializable(carryover);
  return JSON.stringify(sortJson(carryover), null, 2);
}

function assertJsonSerializable(value: unknown, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new CompactionError("Compaction failed: carryover must be JSON-serializable");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new CompactionError("Compaction failed: carryover must contain only plain objects");
  }
  if (seen.has(value)) {
    throw new CompactionError("Compaction failed: carryover must not contain cycles");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSerializable(item, seen);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertJsonSerializable(item, seen);
    }
  }
  seen.delete(value);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
