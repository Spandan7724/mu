import { describe, expect, test } from "bun:test";
import { findModel, listModels, modelRef } from "./catalog.ts";
import { addUsage, computeCostUsd, zeroUsage } from "./cost.ts";

describe("catalog", () => {
  test("finds model by provider/id ref", () => {
    const model = findModel("anthropic/claude-opus-5");
    expect(model?.id).toBe("claude-opus-5");
    expect(model?.pricing.input).toBe(5);
  });

  test("finds model by bare id", () => {
    expect(findModel("gemini-2.5-pro")?.provider).toBe("google");
  });

  test("unknown ref yields undefined", () => {
    expect(findModel("nope/nothing")).toBeUndefined();
  });

  test("all catalog entries have pricing and a ref", () => {
    for (const model of listModels()) {
      expect(model.pricing.input).toBeGreaterThanOrEqual(0);
      expect(modelRef(model)).toContain("/");
    }
  });
});

describe("cost", () => {
  test("computes usd from per-Mtok pricing", () => {
    const cost = computeCostUsd(
      { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 200_000,
        cacheWriteTokens: 0,
      },
    );
    expect(cost).toBeCloseTo(5 + 2.5 + 0.1, 10);
  });

  test("addUsage sums fields", () => {
    const a = { ...zeroUsage(), inputTokens: 1, costUsd: 0.5 };
    const b = { ...zeroUsage(), inputTokens: 2, costUsd: 0.25 };
    expect(addUsage(a, b).inputTokens).toBe(3);
    expect(addUsage(a, b).costUsd).toBeCloseTo(0.75, 10);
  });
});
