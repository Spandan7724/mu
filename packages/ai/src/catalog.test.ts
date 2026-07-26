import { describe, expect, test } from "bun:test";
import { discoverModels, findModel, listModels, modelRef, refreshModels } from "./catalog.ts";
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

  test("discovers compatible provider models and maps their metadata", async () => {
    const payload = {
      anthropic: {
        models: {
          usable: {
            id: "claude-test",
            name: "Claude Test",
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            limit: { context: 200_000, output: 32_000 },
            modalities: { input: ["text", "image"], output: ["text"] },
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
          },
          embedding: {
            id: "embedding-test",
            tool_call: false,
            limit: { context: 8192, output: 1 },
          },
        },
      },
      openai: {
        models: {
          deprecated: {
            id: "gpt-old",
            status: "deprecated",
            tool_call: true,
            limit: { context: 100_000, output: 10_000 },
          },
        },
      },
      google: {
        models: {
          usable: {
            id: "gemini-test",
            name: "Gemini Test",
            tool_call: true,
            reasoning: false,
            limit: { context: 1_000_000, output: 64_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    };
    const mockFetch = async () => Response.json(payload);

    const discovered = await discoverModels({ fetch: mockFetch });

    expect(discovered.map(modelRef)).toEqual(["anthropic/claude-test", "google/gemini-test"]);
    expect(discovered[0]).toMatchObject({
      contextWindow: 200_000,
      maxOutput: 32_000,
      modalities: ["text", "image"],
      thinking: true,
      thinkingMode: "adaptive",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    expect(discovered[1]?.pricing).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("keeps the existing catalog when a refresh fails", async () => {
    const before = listModels().map(modelRef);
    const mockFetch = async () => new Response("unavailable", { status: 503 });

    await expect(refreshModels({ fetch: mockFetch })).rejects.toThrow("503");
    expect(listModels().map(modelRef)).toEqual(before);
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
