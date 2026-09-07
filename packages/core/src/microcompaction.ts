// Layer 1 removes expired images, superseded snapshots and exact duplicates.
// Unique text remains available to the full compactor.

import { estimateTokens } from "./compaction.ts";
import type { AgentMessage } from "./messages.ts";

export const TOMBSTONE = "[output cleared to save context — re-run the tool if you need it]";
export const IMAGE_TOMBSTONE = "[image cleared to save context]";

export interface MicrocompactionOptions {
  // Leave this many of the most recent messages untouched.
  keepRecent?: number;
  // Stop once the transcript is under this many tokens.
  targetTokens?: number;
  imageRetentionTurns?: number;
  imageBudgetTokens?: number;
  imagesOnly?: boolean;
}

export interface MicrocompactionResult {
  messages: AgentMessage[];
  evicted: number;
  tokensFreed: number;
}

function isEvictableImage(block: { type: string; evictable?: boolean }): boolean {
  // Tool-result images default to evictable; a caller can pin one by setting
  // evictable: false explicitly.
  return block.type === "image" && block.evictable !== false;
}

// Untouched messages keep their identity so persistence can record exact replacements.
export function microcompact(
  messages: AgentMessage[],
  options: MicrocompactionOptions = {},
): MicrocompactionResult {
  const keepRecent = options.keepRecent ?? 6;
  const before = estimateTokens(messages);
  const target = options.targetTokens;

  // Preserve identity for untouched messages. Session persistence uses the
  // changed identities to record only the exact replacements.
  const result = [...messages];
  const cutoff = Math.max(0, result.length - keepRecent);
  let evicted = 0;

  const underTarget = () => target !== undefined && estimateTokens(result) <= target;

  const ages = new Array<number>(messages.length);
  let turns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    ages[i] = turns;
    if (messages[i]?.role === "assistant") turns++;
  }
  let imageTokens = messages.reduce(
    (total, message) =>
      total +
      message.content.filter((block) => block.type === "image").length * Math.ceil(1500 / 3.5),
    0,
  );
  for (let i = 0; i < result.length; i++) {
    const message = result[i];
    if (!message || message.role === "assistant") continue;
    const old =
      options.imageRetentionTurns === undefined
        ? i < cutoff
        : (ages[i] ?? 0) >= options.imageRetentionTurns;
    const pressure =
      options.imageBudgetTokens !== undefined &&
      imageTokens > options.imageBudgetTokens &&
      (ages[i] ?? 0) > 0;
    if (!old && !pressure) continue;
    const content = message.content.map((block) => {
      // User/reference images are pinned by default; transient tool images are not.
      if (
        block.type !== "image" ||
        !isEvictableImage(block) ||
        (message.role !== "toolResult" && block.evictable !== true)
      )
        return block;
      imageTokens -= Math.ceil(1500 / 3.5);
      return { type: "text" as const, text: IMAGE_TOMBSTONE };
    });
    if (content.some((block, index) => block !== message.content[index])) {
      result[i] = { ...message, content };
      evicted++;
    }
  }

  const snapshots = new Map<string, number>();
  result.forEach((message, index) => {
    if (message.role === "custom" && message.retention) snapshots.set(message.retention.key, index);
  });
  result.forEach((message, index) => {
    if (
      message.role !== "custom" ||
      !message.retention ||
      snapshots.get(message.retention.key) === index
    )
      return;
    const { retention, ...rest } = message;
    result[index] = {
      ...rest,
      content: [{ type: "text", text: `[Context snapshot superseded: ${retention.key}]` }],
    };
    evicted++;
  });

  // Only exact duplicate observations can be removed without a handoff.
  const latest = new Map<string, number>();
  const fingerprint = (message: AgentMessage) =>
    JSON.stringify([message.role === "toolResult" ? message.toolName : "", message.content]);
  result.forEach((message, index) => {
    if (
      message.role === "toolResult" &&
      !message.evicted &&
      !message.isError &&
      message.content.every((block) => block.type === "text")
    )
      latest.set(fingerprint(message), index);
  });
  for (let i = 0; i < cutoff; i++) {
    const message = result[i];
    if (!message || message.role !== "toolResult" || message.evicted) continue;
    if (options.imagesOnly || underTarget()) break;

    // An error result is small and tells the model what not to retry — keeping
    // it is cheap and prevents repeating a failed call.
    if (message.isError) continue;

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const duplicate = latest.get(fingerprint(message));
    if (duplicate === undefined || duplicate <= i) continue;
    const retained = result[duplicate];
    if (retained?.role !== "toolResult") continue;
    const tombstone = `[duplicate output cleared — identical text retained in tool result ${retained.toolCallId}]`;
    if (text.length <= tombstone.length) continue;

    result[i] = {
      ...message,
      content: [{ type: "text", text: tombstone }],
      evicted: true,
    };
    evicted++;
  }

  return {
    messages: result,
    evicted,
    tokensFreed: Math.max(0, before - estimateTokens(result)),
  };
}

export const MICROCOMPACT_THRESHOLD = 0.6;
