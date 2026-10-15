import { describe, expect, test } from "bun:test";
import { thinkingLevelForModel } from "./thinking.ts";
import type { ModelInfo } from "./types.ts";

const base: ModelInfo = {
  provider: "openai",
  id: "guessed",
  contextWindow: 128_000,
  maxOutput: 32_000,
  modalities: ["text"],
  thinking: true,
  pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("thinkingLevelForModel", () => {
  test("a request for more effort than the legacy levels offer keeps reasoning on", () => {
    expect(thinkingLevelForModel(base, "xhigh")).toBe("high");
    expect(thinkingLevelForModel(base, "minimal")).toBe("low");
    expect(thinkingLevelForModel(base, "off")).toBe("off");
    expect(thinkingLevelForModel(base, undefined)).toBe("off");
  });

  test("an unsupported request otherwise falls back to the model's default", () => {
    const model = {
      ...base,
      thinkingLevels: ["low", "medium", "high"],
      defaultThinkingLevel: "medium",
    };
    expect(thinkingLevelForModel(model, "ultra")).toBe("medium");
    expect(thinkingLevelForModel(model, "high")).toBe("high");
  });

  test("an unknown effort value falls back to the default", () => {
    expect(thinkingLevelForModel(base, "turbo")).toBe("off");
  });

  test("non-reasoning models only offer off", () => {
    expect(thinkingLevelForModel({ ...base, thinking: false }, "high")).toBe("off");
  });
});
