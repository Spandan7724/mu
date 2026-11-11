import { describe, expect, test } from "bun:test";
import { usesCacheBreakpoints } from "../provider-config.ts";
import { getProvider } from "../registry.ts";
import type { AiMessage, LlmContext, ModelInfo } from "../types.ts";

type Body = Record<string, unknown> & {
  messages?: { role: string; content: { cache_control?: unknown }[] }[];
  system?: { cache_control?: unknown }[];
  tools?: { cache_control?: unknown }[];
};

function model(provider: string, id: string, api?: ModelInfo["api"]): ModelInfo {
  return {
    provider,
    id,
    ...(api ? { api } : {}),
    contextWindow: 200_000,
    maxOutput: 8_000,
    modalities: ["text"],
    pricing: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
  };
}

const assistant = (id: string): AiMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "read", arguments: {} }],
  model: "x/y",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  stopReason: "toolUse",
  timestamp: 1,
});
const result = (toolCallId: string): AiMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 1,
});

const context: LlmContext = {
  systemPrompt: [{ text: "static" }, { text: "dynamic", dynamic: true }],
  messages: [
    { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
    assistant("c1"),
    result("c1"),
    assistant("c2"),
    result("c2"),
  ],
  tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }],
};

async function requestBody(target: ModelInfo, sessionId?: string): Promise<Body> {
  let body: Body = {};
  await getProvider(target.provider)
    .stream(target, context, {
      apiKey: "key",
      maxRetries: 0,
      ...(sessionId ? { sessionId } : {}),
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Body;
        return new Response("{}", { status: 400 });
      }) as typeof fetch,
    })
    .result();
  return body;
}

const marked = (body: Body): number[] =>
  (body.messages ?? []).flatMap((message, index) =>
    message.content.some((block) => block.cache_control) ? [index] : [],
  );

describe("prompt cache placement", () => {
  test("providers declare whether requests carry breakpoints", () => {
    expect(usesCacheBreakpoints(model("anthropic", "claude-opus-5"))).toBe(true);
    expect(usesCacheBreakpoints(model("minimax", "MiniMax-M2"))).toBe(true);
    expect(usesCacheBreakpoints(model("vercel-ai-gateway", "anthropic/claude-opus-5"))).toBe(true);
    expect(usesCacheBreakpoints(model("vercel-ai-gateway", "openai/gpt-5.1"))).toBe(false);
    expect(usesCacheBreakpoints(model("openrouter", "anthropic/claude-opus-5"))).toBe(true);
    expect(usesCacheBreakpoints(model("openrouter", "openai/gpt-5.1"))).toBe(false);
    expect(usesCacheBreakpoints(model("fireworks", "kimi"))).toBe(false);
    expect(usesCacheBreakpoints(model("custom", "claude", "anthropic-messages"))).toBe(false);
  });

  test("an Anthropic request marks the system boundary, the tools and the last two user turns", async () => {
    const body = await requestBody(model("anthropic", "claude-opus-5"));
    expect(body.system?.map((section) => section.cache_control !== undefined)).toEqual([
      true,
      false,
    ]);
    expect(body.tools?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    // user, assistant, results(c1), assistant, results(c2)
    expect(marked(body)).toEqual([2, 4]);
  });

  test("the same transport marks a declared provider and leaves an undeclared one alone", async () => {
    expect(marked(await requestBody(model("minimax", "MiniMax-M2")))).toEqual([2, 4]);
    const fireworks = await requestBody(model("fireworks", "kimi"));
    expect(marked(fireworks)).toEqual([]);
    expect(fireworks.system?.some((section) => section.cache_control)).toBe(false);
    expect(fireworks.tools?.[0]?.cache_control).toBeUndefined();
  });

  test("a routed Claude model asks the router to cache; other routed models do not", async () => {
    const claude = await requestBody(model("openrouter", "anthropic/claude-opus-5"));
    expect(claude.cache_control).toEqual({ type: "ephemeral" });
    const other = await requestBody(model("openrouter", "openai/gpt-5.1"));
    expect(other).not.toHaveProperty("cache_control");
  });

  test("direct OpenAI requests carry the session as their cache key", async () => {
    const body = await requestBody(model("openai", "gpt-5.1"), "s".repeat(80));
    expect(body.prompt_cache_key).toBe("s".repeat(64));
    expect(await requestBody(model("openai", "gpt-5.1"))).not.toHaveProperty("prompt_cache_key");
  });
});
