import type { LlmContext, ModelInfo, Provider, StreamOpts, Usage } from "@mu/ai";
import type { AgentMessage } from "./messages.ts";
import { toAiMessages } from "./messages.ts";

// Layer 0 — accounting. Context usage is read from real API usage where
// available and estimated otherwise; the estimate is deliberately conservative
// (over- rather than under-reporting) so the trigger fires before a hard fail.
const CHARS_PER_TOKEN = 3.5;

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

// Keeps a recent tail intact so the model retains immediate working state.
export function planCompaction(
  messages: AgentMessage[],
  keepRatio = 0.3,
): { keepFromIndex: number } {
  if (messages.length <= 4) return { keepFromIndex: messages.length };
  const keep = Math.max(2, Math.floor(messages.length * keepRatio));
  let index = messages.length - keep;

  // Never split a tool call from its result: walk back to a clean boundary.
  while (index > 0 && messages[index]?.role === "toolResult") index--;
  return { keepFromIndex: index };
}

export const SUMMARY_PROMPT = `Summarize the conversation so far so that work can continue without the original transcript.

Preserve, in this order:
1. What the user asked for — the goal, in their terms, including any constraints they stated.
2. Decisions taken and why, including approaches tried and rejected.
3. Current task state: what is done, what is in progress, what remains.
4. Concrete facts discovered that would be expensive to rediscover (file locations, API shapes, error messages, command invocations that work).
5. Anything the user corrected you on.

Be specific and factual. Do not include pleasantries or narration. This summary replaces the transcript, so anything you omit is lost.`;

export interface CompactorOptions {
  provider: Provider;
  model: ModelInfo;
  // Domain knowledge the kernel does not have — coding carries file lists.
  carryoverExtractor?: (messages: AgentMessage[]) => unknown;
  keepRatio?: number;
  signal?: AbortSignal;
  streamOpts?: StreamOpts;
}

// Layer 2 — full compaction. Core owns the machinery; the profile injects what
// its domain must not lose.
export async function compact(
  messages: AgentMessage[],
  options: CompactorOptions,
): Promise<CompactionResult> {
  const { keepFromIndex } = planCompaction(messages, options.keepRatio);
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

  const context: LlmContext = {
    systemPrompt: [{ text: SUMMARY_PROMPT }],
    messages: [
      ...toAiMessages(toSummarize),
      {
        role: "user",
        content: [{ type: "text", text: "Produce the summary now." }],
        timestamp: Date.now(),
      },
    ],
  };

  const stream = options.provider.stream(options.model, context, {
    ...options.streamOpts,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const result = await stream.result();

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
