import { afterEach, describe, expect, test } from "bun:test";
import type { LlmContext, ModelInfo } from "../types.ts";
import { discoverLlamaCppModels, llamaCpp } from "./llama-cpp.ts";

const originalBaseUrl = process.env.LLAMA_CPP_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.LLAMA_CPP_BASE_URL;
  else process.env.LLAMA_CPP_BASE_URL = originalBaseUrl;
});

describe("llama.cpp provider", () => {
  test("the implicit local discovery probe has its own short timeout", async () => {
    delete process.env.LLAMA_CPP_BASE_URL;
    const startedAt = performance.now();

    await expect(
      discoverLlamaCppModels({
        currentModels: [],
        fetch: ((_input, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error("missing discovery signal");
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          })) as typeof fetch,
      }),
    ).rejects.toThrow();

    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test("discovers the loaded alias and configured slot context", async () => {
    process.env.LLAMA_CPP_BASE_URL = "http://127.0.0.1:8000";
    const urls: string[] = [];
    const models = await discoverLlamaCppModels({
      currentModels: [],
      fetch: (async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/v1/models")) {
          return Response.json({
            object: "list",
            data: [
              {
                id: "ornith-1.5-9b",
                object: "model",
                owned_by: "llamacpp",
                meta: { n_ctx_train: 262_144 },
              },
            ],
          });
        }
        return Response.json({
          default_generation_settings: { n_ctx: 131_072 },
          modalities: { vision: false },
        });
      }) as typeof fetch,
    });

    expect(urls).toEqual(["http://127.0.0.1:8000/v1/models", "http://127.0.0.1:8000/props"]);
    expect(models).toEqual([
      expect.objectContaining({
        provider: "llama-cpp",
        id: "ornith-1.5-9b",
        baseUrl: "http://127.0.0.1:8000/v1",
        contextWindow: 131_072,
        maxOutput: 32_768,
        modalities: ["text"],
      }),
    ]);
  });

  test("streams without requiring or sending an API key", async () => {
    process.env.LLAMA_CPP_BASE_URL = "http://127.0.0.1:8000";
    const model: ModelInfo = {
      provider: "llama-cpp",
      id: "ornith-1.5-9b",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8000/v1",
      contextWindow: 131_072,
      maxOutput: 32_768,
      modalities: ["text"],
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const context: LlmContext = {
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
    };
    let authorization: string | null = "unexpected";
    let url = "";
    const result = await llamaCpp
      .stream(model, context, {
        fetch: (async (input, init) => {
          url = String(input);
          authorization = new Headers(init?.headers).get("authorization");
          return new Response(
            'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        }) as typeof fetch,
      })
      .result();

    expect(url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(authorization).toBeNull();
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  test("does not duplicate complete tool names repeated by the server", async () => {
    const model: ModelInfo = {
      provider: "llama-cpp",
      id: "ornith-1.5-9b",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8000/v1",
      contextWindow: 131_072,
      maxOutput: 32_768,
      modalities: ["text"],
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const context: LlmContext = {
      messages: [{ role: "user", content: [{ type: "text", text: "read it" }], timestamp: 1 }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };
    const result = await llamaCpp
      .stream(model, context, {
        fetch: (async () =>
          new Response(
            [
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}',
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { headers: { "content-type": "text/event-stream" } },
          )) as unknown as typeof fetch,
      })
      .result();

    expect(result.content).toEqual([
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
    ]);
  });
});
