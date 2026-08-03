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

export function thinkingLevelForModel(
  model: ModelInfo,
  requested: ThinkingLevel | undefined,
): ThinkingLevel {
  const levels = supportedThinkingLevels(model);
  if (requested && levels.includes(requested)) return requested;
  return defaultThinkingLevel(model);
}
