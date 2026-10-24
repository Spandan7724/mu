import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Credential, ModelInfo } from "../types.ts";
import { discoverInceptionModels, inceptionProvider } from "./inception.ts";
import { streamOpenAICompletions } from "./openai-completions.ts";

const originalApiKey = process.env.INCEPTION_API_KEY;

beforeEach(() => {
  delete process.env.INCEPTION_API_KEY;
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.INCEPTION_API_KEY;
  else process.env.INCEPTION_API_KEY = originalApiKey;
});

function chatModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "mercury-2.5",
    name: "Inception: Mercury 2.5",
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 260_000,
    max_output_length: 65_536,
    pricing: {
      prompt: "0.0000002",
      completion: "0.00000075",
      input_cache_reads: "0.00000002",
      input_cache_writes: "0",
    },
    supported_features: ["tools", "json_mode", "structured_outputs"],
    supported_endpoints: ["chat.completions"],
    ...overrides,
  };
}

function catalogFetch(data: unknown[]): typeof fetch {
  return (async () => Response.json({ data })) as unknown as typeof fetch;
}

function cachedModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    provider: "inception",
    id: "mercury-2.5",
    name: "Cached Mercury 2.5",
    contextWindow: 200_000,
    maxOutput: 32_768,
    modalities: ["text"],
    pricing: { input: 0.3, output: 0.8, cacheRead: 0.03, cacheWrite: 0.1 },
    ...overrides,
  };
}

const getCredentials = async (): Promise<Credential> => ({ type: "apiKey", apiKey: "stored-key" });

describe("Inception provider", () => {
  test("uses the shared completions stream and exposes discovery", () => {
    expect(inceptionProvider.id).toBe("inception");
    expect(inceptionProvider.stream).toBe(streamOpenAICompletions);
    expect(inceptionProvider.discoverModels).toBe(discoverInceptionModels);
  });

  test("does not fetch without credentials, including an empty environment key", async () => {
    let requests = 0;
    const request = (async () => {
      requests++;
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;
    expect(await discoverInceptionModels({ currentModels: [], fetch: request })).toBeUndefined();
    process.env.INCEPTION_API_KEY = "";
    expect(
      await discoverInceptionModels({
        currentModels: [],
        getCredentials: async () => undefined,
        fetch: request,
      }),
    ).toBeUndefined();
    expect(requests).toBe(0);
  });

  test("uses a fifteen-second discovery timeout when no signal is supplied", async () => {
    const controller = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      await discoverInceptionModels({
        currentModels: [],
        getCredentials,
        fetch: (async (_input, init) => {
          expect(init?.signal).toBe(controller.signal);
          return Response.json({ data: [chatModel()] });
        }) as typeof fetch,
      });
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally {
      timeout.mockRestore();
    }
  });

  test("falls back from the resolver to the environment and passes the signal unchanged", async () => {
    process.env.INCEPTION_API_KEY = "environment-key";
    const controller = new AbortController();
    let requests = 0;
    const models = await discoverInceptionModels({
      currentModels: [],
      signal: controller.signal,
      getCredentials: async () => undefined,
      fetch: (async (input, init) => {
        requests++;
        expect(String(input)).toBe("https://api.inceptionlabs.ai/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer environment-key");
        expect(new Headers(init?.headers).get("accept")).toBe("application/json");
        expect(init?.signal).toBe(controller.signal);
        return Response.json({ data: [chatModel()] });
      }) as typeof fetch,
    });
    expect(requests).toBe(1);
    expect(models).toEqual([
      {
        provider: "inception",
        id: "mercury-2.5",
        name: "Inception: Mercury 2.5",
        api: "openai-completions",
        baseUrl: "https://api.inceptionlabs.ai/v1",
        contextWindow: 260_000,
        maxOutput: 65_536,
        modalities: ["text"],
        pricing: { input: expect.any(Number), output: 0.75, cacheRead: 0.02, cacheWrite: 0 },
        thinking: true,
        thinkingLevels: ["instant", "low", "medium", "high"],
        defaultThinkingLevel: "medium",
      },
    ]);
    expect(models?.[0]?.pricing.input).toBeCloseTo(0.2);
  });

  test.each<Credential>([
    { type: "apiKey", apiKey: "stored-key" },
    { type: "oauth", accessToken: "stored-key" },
  ])("resolver credentials take precedence over the environment: %j", async (credential) => {
    process.env.INCEPTION_API_KEY = "environment-key";
    await discoverInceptionModels({
      currentModels: [],
      getCredentials: async () => credential,
      fetch: (async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer stored-key");
        return Response.json({ data: [chatModel()] });
      }) as typeof fetch,
    });
  });

  test("propagates credential resolution errors", async () => {
    await expect(
      discoverInceptionModels({
        currentModels: [],
        getCredentials: async () => {
          throw new Error("credential unavailable");
        },
        fetch: catalogFetch([chatModel()]),
      }),
    ).rejects.toThrow("credential unavailable");
  });

  test("filters non-chat, non-tool, and non-text models without inferring image support", async () => {
    const models = await discoverInceptionModels({
      currentModels: [],
      getCredentials,
      fetch: catalogFetch([
        null,
        [],
        chatModel({ id: " " }),
        chatModel({ id: 1 }),
        chatModel({
          id: "mercury-edit-2",
          supported_endpoints: ["fim.completions", "edit.completions"],
        }),
        chatModel({ id: "mercury-decide", supported_endpoints: ["decisions"] }),
        chatModel({ id: "no-tools", supported_features: ["json_mode", "structured_outputs"] }),
        chatModel({ id: "missing-features", supported_features: undefined }),
        chatModel({ id: "missing-endpoints", supported_endpoints: undefined }),
        chatModel({ id: "wrong-endpoints", supported_endpoints: "chat.completions" }),
        chatModel({ id: "image-input", input_modalities: ["image"] }),
        chatModel({ id: "image-output", output_modalities: ["image"] }),
        chatModel({ id: "missing-input", input_modalities: undefined }),
        chatModel({ id: "missing-output", output_modalities: undefined }),
        chatModel({ input_modalities: ["text", "image"] }),
      ]),
    });
    expect(models?.map((model) => model.id)).toEqual(["mercury-2.5"]);
    expect(models?.[0]?.modalities).toEqual(["text"]);
  });

  test.each([
    ["mercury-3", "low"],
    ["mercury-2.5", "medium"],
    ["mercury-2", "medium"],
  ])("official reasoning levels override stale metadata for %s", async (id, defaultLevel) => {
    const models = await discoverInceptionModels({
      currentModels: [
        cachedModel({
          id,
          thinking: true,
          thinkingLevels: ["low", "medium", "high"],
          defaultThinkingLevel: "high",
        }),
      ],
      getCredentials,
      fetch: catalogFetch([chatModel({ id })]),
    });
    expect(models?.[0]?.thinkingLevels).toEqual(["instant", "low", "medium", "high"]);
    expect(models?.[0]?.defaultThinkingLevel).toBe(defaultLevel);
  });

  test("Voice supports only low through high and preserves a compatible known default", async () => {
    for (const defaultLevel of ["instant", "medium"]) {
      const models = await discoverInceptionModels({
        currentModels: [
          cachedModel({
            id: "mercury-voice",
            thinking: true,
            thinkingLevels: ["instant", "low", "medium", "high"],
            defaultThinkingLevel: defaultLevel,
          }),
        ],
        getCredentials,
        fetch: catalogFetch([chatModel({ id: "mercury-voice" })]),
      });
      expect(models?.[0]?.thinking).toBe(true);
      expect(models?.[0]?.thinkingLevels).toEqual(["low", "medium", "high"]);
      expect(models?.[0]?.defaultThinkingLevel).toBe(
        defaultLevel === "medium" ? "medium" : undefined,
      );
    }
  });

  test("legacy Mercury and Mercury Coder are non-reasoning even with stale metadata", async () => {
    const ids = ["mercury", "mercury-coder", "mercury-coder-small", "mercury-coder-small-beta"];
    const models = await discoverInceptionModels({
      currentModels: ids.map((id) =>
        cachedModel({ id, thinking: true, thinkingLevels: ["high"], defaultThinkingLevel: "high" }),
      ),
      getCredentials,
      fetch: catalogFetch(ids.map((id) => chatModel({ id }))),
    });
    expect(models).toHaveLength(ids.length);
    for (const model of models ?? []) {
      expect(model.thinking).toBeUndefined();
      expect(model.thinkingLevels).toBeUndefined();
      expect(model.defaultThinkingLevel).toBeUndefined();
    }
  });

  test("unknown future models retain known reasoning metadata without inventing it", async () => {
    const models = await discoverInceptionModels({
      currentModels: [
        cachedModel({
          id: "mercury-future",
          thinking: true,
          thinkingLevels: ["low", "high"],
          defaultThinkingLevel: "high",
        }),
      ],
      getCredentials,
      fetch: catalogFetch([chatModel({ id: "mercury-future" }), chatModel({ id: "unknown" })]),
    });
    expect(models?.[0]?.thinking).toBe(true);
    expect(models?.[0]?.thinkingLevels).toEqual(["low", "high"]);
    expect(models?.[0]?.defaultThinkingLevel).toBe("high");
    expect(models?.[1]?.thinking).toBeUndefined();
    expect(models?.[1]?.thinkingLevels).toBeUndefined();
  });

  test("uses safe current metadata for missing fields, but fresh values take precedence", async () => {
    const models = await discoverInceptionModels({
      currentModels: [cachedModel()],
      getCredentials,
      fetch: catalogFetch([
        chatModel({
          name: undefined,
          context_length: undefined,
          max_output_length: undefined,
          pricing: { prompt: "0.00000025" },
        }),
      ]),
    });
    expect(models?.[0]).toMatchObject({
      name: "Cached Mercury 2.5",
      contextWindow: 200_000,
      maxOutput: 32_768,
      pricing: { output: 0.8, cacheRead: 0.03, cacheWrite: 0.1 },
    });
    expect(models?.[0]?.pricing.input).toBeCloseTo(0.25);
  });

  test("defaults omitted cache prices to zero but never assumes missing base prices are free", async () => {
    const models = await discoverInceptionModels({
      currentModels: [],
      getCredentials,
      fetch: catalogFetch([
        chatModel({ id: "unknown-price", pricing: undefined }),
        chatModel({ id: "missing-cache", pricing: { prompt: "0", completion: "0" } }),
        chatModel({
          pricing: {
            prompt: "0",
            completion: "0",
            input_cache_reads: "0",
            input_cache_writes: "0",
          },
        }),
      ]),
    });
    expect(models?.map((model) => model.id)).toEqual(["missing-cache", "mercury-2.5"]);
    for (const model of models ?? []) {
      expect(model.pricing).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  test.each([
    { context_length: 0 },
    { context_length: -1 },
    { context_length: "260000" },
    { context_length: 1.5 },
    { context_length: Number.MAX_SAFE_INTEGER + 1 },
    { max_output_length: 0 },
    { max_output_length: 260_001 },
    { max_output_length: null },
    { pricing: null },
    { pricing: { prompt: "" } },
    { pricing: { prompt: " " } },
    { pricing: { prompt: "-0.1" } },
    { pricing: { prompt: "NaN" } },
    { pricing: { prompt: "Infinity" } },
    { pricing: { prompt: "1e309" } },
    { pricing: { prompt: "1e308" } },
    { pricing: { prompt: "0x10" } },
    { pricing: { prompt: 0 } },
  ])("rejects invalid supplied metadata instead of hiding it behind cached data: %j", async (overrides) => {
    await expect(
      discoverInceptionModels({
        currentModels: [cachedModel()],
        getCredentials,
        fetch: catalogFetch([chatModel(overrides)]),
      }),
    ).rejects.toThrow("no compatible models with valid metadata");
  });

  test.each([
    { provider: "other" },
    { inferred: true },
    { contextWindow: 0 },
    { maxOutput: 0 },
    { pricing: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    { pricing: { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 } },
  ])("does not use unsafe or unrelated current metadata: %j", async (overrides) => {
    await expect(
      discoverInceptionModels({
        currentModels: [cachedModel(overrides)],
        getCredentials,
        fetch: catalogFetch([
          chatModel({
            context_length: undefined,
            max_output_length: undefined,
            pricing: undefined,
          }),
        ]),
      }),
    ).rejects.toThrow("no compatible models with valid metadata");
  });

  test.each([
    { payload: null },
    { payload: [] },
    { payload: {} },
    { payload: { data: {} } },
  ])("throws for malformed catalogs: %j", async ({ payload }) => {
    await expect(
      discoverInceptionModels({
        currentModels: [],
        getCredentials,
        fetch: (async () => Response.json(payload)) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("invalid /v1/models response");
  });

  test("throws for an empty catalog rather than erasing last-good models", async () => {
    await expect(
      discoverInceptionModels({
        currentModels: [cachedModel()],
        getCredentials,
        fetch: catalogFetch([]),
      }),
    ).rejects.toThrow("no compatible models");
  });

  test.each([401, 429, 503])("reports configured HTTP failures: %s", async (status) => {
    await expect(
      discoverInceptionModels({
        currentModels: [],
        getCredentials,
        fetch: (async () =>
          new Response("discovery failed", { status })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("discovery failed");
  });

  test("propagates invalid JSON, network errors, and cancellation", async () => {
    await expect(
      discoverInceptionModels({
        currentModels: [],
        getCredentials,
        fetch: (async () => new Response("not json")) as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      discoverInceptionModels({
        currentModels: [],
        getCredentials,
        signal: controller.signal,
        fetch: (async (_input, init): Promise<Response> => {
          expect(init?.signal).toBe(controller.signal);
          init?.signal?.throwIfAborted();
          throw new Error("unreachable");
        }) as typeof fetch,
      }),
    ).rejects.toThrow("cancelled");
    await expect(
      discoverInceptionModels({
        currentModels: [],
        getCredentials,
        fetch: (async () => {
          throw new Error("connection refused");
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("connection refused");
  });
});
