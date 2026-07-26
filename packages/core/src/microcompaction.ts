// Layer 1 — microcompaction. No LLM call: old tool-result content is evicted
// and replaced with a tombstone the model can act on. Images go first because
// they are the most expensive thing in a transcript by a wide margin.

import { estimateTokens } from "./compaction.ts";
import type { AgentMessage } from "./messages.ts";

export const TOMBSTONE = "[output cleared to save context — re-run the tool if you need it]";
export const IMAGE_TOMBSTONE = "[image cleared to save context]";

export interface MicrocompactionOptions {
  // Leave this many of the most recent messages untouched.
  keepRecent?: number;
  // Stop once the transcript is under this many tokens.
  targetTokens?: number;
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

// Two passes: images first (cheapest to lose, most expensive to keep), then
// whole tool results. Never touches user or assistant messages — those carry
// intent and reasoning that cannot be recovered by re-running anything.
export function microcompact(
  messages: AgentMessage[],
  options: MicrocompactionOptions = {},
): MicrocompactionResult {
  const keepRecent = options.keepRecent ?? 6;
  const before = estimateTokens(messages);
  const target = options.targetTokens;

  const result = messages.map((message) => ({ ...message }));
  const cutoff = Math.max(0, result.length - keepRecent);
  let evicted = 0;

  const underTarget = () => target !== undefined && estimateTokens(result) <= target;

  // Pass 1: images inside tool results.
  for (let i = 0; i < cutoff; i++) {
    const message = result[i];
    if (!message || message.role !== "toolResult" || message.evicted) continue;
    if (underTarget()) break;

    const hasImage = message.content.some(isEvictableImage);
    if (!hasImage) continue;

    message.content = message.content.map((block) =>
      isEvictableImage(block) ? { type: "text" as const, text: IMAGE_TOMBSTONE } : block,
    );
    evicted++;
  }

  // Pass 2: whole tool results, oldest first.
  for (let i = 0; i < cutoff; i++) {
    const message = result[i];
    if (!message || message.role !== "toolResult" || message.evicted) continue;
    if (underTarget()) break;

    // An error result is small and tells the model what not to retry — keeping
    // it is cheap and prevents repeating a failed call.
    if (message.isError) continue;

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.length < TOMBSTONE.length) continue; // already smaller than the marker

    message.content = [{ type: "text", text: TOMBSTONE }];
    message.evicted = true;
    evicted++;
  }

  return {
    messages: result,
    evicted,
    tokensFreed: Math.max(0, before - estimateTokens(result)),
  };
}

export const MICROCOMPACT_THRESHOLD = 0.6;
