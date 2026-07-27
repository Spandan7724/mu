import { afterEach, describe, expect, test } from "bun:test";
import {
  defaultModelRef,
  discoverModels,
  findModel,
  listModels,
  modelRef,
  providerHasCredentials,
  refreshModels,
  registerModels,
} from "./catalog.ts";
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
        cacheWriteTokens: 100_000,
      },
    );
    expect(cost).toBeCloseTo(5 + 2.5 + 0.1 + 0.625, 10);
  });

  test("addUsage sums fields", () => {
    const a = { ...zeroUsage(), inputTokens: 1, costUsd: 0.5 };
    const b = { ...zeroUsage(), inputTokens: 2, costUsd: 0.25 };
    expect(addUsage(a, b).inputTokens).toBe(3);
    expect(addUsage(a, b).costUsd).toBeCloseTo(0.75, 10);
  });
});

describe("credential-aware default model", () => {
  test("prefers a provider the user actually has a key for", () => {
    expect(defaultModelRef({ OPENAI_API_KEY: "x" }).startsWith("openai/")).toBe(true);
    expect(defaultModelRef({ ANTHROPIC_API_KEY: "x" }).startsWith("anthropic/")).toBe(true);
    expect(defaultModelRef({ GEMINI_API_KEY: "x" }).startsWith("google/")).toBe(true);
  });

  test("falls back to the first model when nothing is configured", () => {
    expect(defaultModelRef({})).toContain("/");
  });

  test("reports per-provider credential availability", () => {
    expect(providerHasCredentials("openai", { OPENAI_API_KEY: "x" })).toBe(true);
    expect(providerHasCredentials("openai", {})).toBe(false);
    // An unknown/custom provider is not gated on a key we do not know about.
    expect(providerHasCredentials("custom", {})).toBe(true);
  });
});

describe("catalog refresh merges rather than replaces", () => {
  // The catalog is process-global, so a refresh here would otherwise leak into
  // every other test that resolves a model.
  const snapshot = listModels();
  afterEach(() => registerModels(snapshot));

  test("a partial upstream response keeps bundled models usable", async () => {
    // Only Google responds — Anthropic and OpenAI must survive.
    const payload = {
      google: {
        models: {
          usable: {
            id: "gemini-only",
            tool_call: true,
            limit: { context: 1_000_000, output: 64_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    };
    await refreshModels({ fetch: async () => Response.json(payload) });

    expect(findModel("anthropic/claude-opus-5")).toBeDefined();
    expect(findModel("openai/gpt-5.1")).toBeDefined();
    expect(findModel("google/gemini-only")).toBeDefined();
  });

  test("discovered entries override bundled ones of the same id", async () => {
    const payload = {
      anthropic: {
        models: {
          opus: {
            id: "claude-opus-5",
            name: "Claude Opus 5 (refreshed)",
            tool_call: true,
            limit: { context: 2_000_000, output: 128_000 },
            modalities: { input: ["text"], output: ["text"] },
            cost: { input: 7, output: 30 },
          },
        },
      },
    };
    await refreshModels({ fetch: async () => Response.json(payload) });

    const model = findModel("anthropic/claude-opus-5");
    expect(model?.contextWindow).toBe(2_000_000);
    expect(model?.pricing.input).toBe(7);
  });
});
