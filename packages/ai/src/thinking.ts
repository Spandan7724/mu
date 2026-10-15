import type { ModelInfo, ThinkingLevel } from "./types.ts";

const LEGACY_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

export function supportedThinkingLevels(model: ModelInfo): ThinkingLevel[] {
  if (!model.thinking) return ["off"];
  if (model.thinkingLevels && model.thinkingLevels.length > 0) {
    return [...new Set(model.thinkingLevels)];
  }
  return [...LEGACY_THINKING_LEVELS];
}

export function defaultThinkingLevel(model: ModelInfo): ThinkingLevel {
  const levels = supportedThinkingLevels(model);
  if (model.defaultThinkingLevel && levels.includes(model.defaultThinkingLevel)) {
    return model.defaultThinkingLevel;
  }
  return levels[0] ?? "off";
}

const EFFORT_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
};

// An unsupported selection falls back to the model's default, except that a
// request for reasoning never lands on "off": it takes the closest effort.
export function thinkingLevelForModel(
  model: ModelInfo,
  requested: ThinkingLevel | undefined,
): ThinkingLevel {
  const levels = supportedThinkingLevels(model);
  if (requested && levels.includes(requested)) return requested;
  const fallback = defaultThinkingLevel(model);
  const wanted = requested === undefined ? undefined : EFFORT_RANK[requested];
  if (!wanted || EFFORT_RANK[fallback] !== 0) return fallback;
  let best: ThinkingLevel | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of levels) {
    const rank = EFFORT_RANK[level];
    if (!rank) continue;
    const distance = Math.abs(rank - wanted);
    if (distance < bestDistance || (distance === bestDistance && rank > wanted)) {
      best = level;
      bestDistance = distance;
    }
  }
  return best ?? fallback;
}
