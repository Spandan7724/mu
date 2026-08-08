import { describe, expect, test } from "bun:test";
import { findModel } from "../catalog.ts";
import { builtinProviderConfigs } from "../provider-config.ts";
import { getProvider } from "../registry.ts";
import type { LlmContext, ModelInfo } from "../types.ts";

const context: LlmContext = {
  systemPrompt: [{ text: "You are mu." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }], timestamp: 1 }],
  tools: [
    {
      name: "lookup",
      description: "Look something up",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
  ],
};

function completionFetch(capture: {
  url?: string;
  headers?: Headers;
  body?: Record<string, unknown>;
}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    capture.url = String(input);
    capture.headers = new Headers(init?.headers);
    capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      [
        'data: {"choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
}

describe("built-in LLM providers", () => {
  test("registers every provider descriptor", () => {
    expect([...builtinProviderConfigs.keys()]).toEqual([
      "amazon-bedrock",
      "anthropic",
      "azure-openai-responses",
      "cerebras",
      "cloudflare-ai-gateway",
      "cloudflare-workers-ai",
      "deepseek",
      "fireworks",
      "github-copilot",
      "google",
      "google-vertex",
      "groq",
      "huggingface",
      "kimi-coding",
      "minimax",
      "mistral",
      "moonshotai",
      "nvidia",
      "openai",
      "openai-codex",
      "opencode",
      "opencode-go",
      "openrouter",
      "qwen-token-plan",
      "vercel-ai-gateway",
      "xai",
      "zai",
    ]);
    for (const id of builtinProviderConfigs.keys()) {
      expect(getProvider(id).id).toBe(id);
    }
    expect(builtinProviderConfigs.has("anthropic-codex")).toBe(false);
    expect(builtinProviderConfigs.get("anthropic")?.env).toEqual(["ANTHROPIC_API_KEY"]);
    for (const removed of [
      "ant-ling",
      "minimax-cn",
      "moonshotai-cn",
      "qwen-token-plan-cn",
      "radius",
      "together",
      "xiaomi",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-sgp",
      "zai-coding-cn",
    ]) {
      expect(builtinProviderConfigs.has(removed)).toBe(false);
      expect(findModel(`${removed}/model`)).toBeUndefined();
    }
  });

  test("supports explicit models before remote catalog discovery", () => {
    expect(findModel("deepseek/deepseek-chat")).toMatchObject({
      provider: "deepseek",
      id: "deepseek-chat",
      api: "openai-completions",
    });
    expect(findModel("xai/grok-4.5")).toMatchObject({ api: "openai-responses" });
    expect(findModel("cloudflare-ai-gateway/openai/gpt-5.2")).toMatchObject({
      id: "gpt-5.2",
      api: "openai-responses",
    });
    expect(findModel("cloudflare-ai-gateway/anthropic/claude-opus-4.6")).toMatchObject({
      id: "claude-opus-4.6",
      api: "anthropic-messages",
    });
    expect(findModel("fireworks/accounts/fireworks/models/glm-5p2")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.fireworks.ai/inference/v1",
    });
    expect(findModel("not-built-in/model")).toBeUndefined();
  });

  test("streams an OpenAI-compatible coding-plan model", async () => {
    const model = findModel("zai/glm-5.1") as ModelInfo;
    const capture: { url?: string; headers?: Headers; body?: Record<string, unknown> } = {};
    const result = await getProvider("zai")
      .stream(model, context, {
        apiKey: "plan-key",
        fetch: completionFetch(capture),
        thinkingLevel: "high",
      })
      .result();

    expect(capture.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(capture.headers?.get("authorization")).toBe("Bearer plan-key");
    expect(capture.body).toMatchObject({
      model: "glm-5.1",
      stream: true,
      thinking: { type: "enabled" },
    });
    expect(result.content).toEqual([
      { type: "thinking", thinking: "think" },
      { type: "text", text: "hello" },
    ]);
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      cacheReadTokens: 2,
      outputTokens: 3,
    });
  });

  test("OpenAI-compatible requests attach tool-result images as multimodal user content", async () => {
    const model = findModel("zai/glm-5.1") as ModelInfo;
    const capture: { body?: Record<string, unknown> } = {};
    const imageContext: LlmContext = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "render_image", arguments: {} }],
          model: "zai/glm-5.1",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "render_image",
          content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };
    await getProvider("zai")
      .stream(model, imageContext, { apiKey: "plan-key", fetch: completionFetch(capture) })
      .result();

    const messages = capture.body?.messages as Array<Record<string, unknown>>;
    expect(messages.at(-2)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Images returned by the preceding tool calls:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      ],
    });
  });

  test("maps Qwen plan thinking to enable_thinking", async () => {
    const model = findModel("qwen-token-plan/qwen3.7-max") as ModelInfo;
    const capture: { body?: Record<string, unknown> } = {};
    await getProvider("qwen-token-plan")
      .stream(model, context, {
        apiKey: "plan-key",
        fetch: completionFetch(capture),
        thinkingLevel: "medium",
      })
      .result();
    expect(capture.body?.enable_thinking).toBe(true);
  });

  test("rejects Anthropic account credentials while retaining API-key models", async () => {
    const model = findModel("anthropic/claude-opus-5") as ModelInfo;
    const result = await getProvider("anthropic")
      .stream(model, context, {
        getCredentials: async () => ({ type: "oauth", accessToken: "not-allowed" }),
      })
      .result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Anthropic account-plan authentication is not supported");
  });
});
