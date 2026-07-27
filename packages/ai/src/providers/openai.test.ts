import { describe, expect, test } from "bun:test";
import { findModel } from "../catalog.ts";
import textCassette from "../fixtures/openai-text.json" with { type: "json" };
import toolCassette from "../fixtures/openai-tool.json" with { type: "json" };
import { replayFetch } from "../testing/replay.ts";
import type { LlmContext, ModelInfo, ProviderStreamEvent } from "../types.ts";
import { streamOpenAI } from "./openai.ts";

const model = findModel("openai/gpt-5.1") as ModelInfo;

const ctx: LlmContext = {
  systemPrompt: [{ text: "You are mu." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }], timestamp: 1 }],
  tools: [
    {
      name: "get_weather",
      description: "Get weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ],
};

describe("streamOpenAI", () => {
  test("streams reasoning + text with usage split into cached/uncached", async () => {
    const replay = replayFetch(textCassette);
    const events: ProviderStreamEvent[] = [];
    const stream = streamOpenAI(model, ctx, {
      apiKey: "test",
      fetch: replay.fetch,
      thinkingLevel: "medium",
    });
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(result.stopReason).toBe("end");
    expect(result.content[0]).toEqual({
      type: "thinking",
      thinking: "Considering the question.",
      signature: JSON.stringify({ id: "rs_1", encrypted_content: "ENC_XYZ" }),
    });
    expect(result.content[1]).toEqual({ type: "text", text: "Hello world" });
    expect(result.usage.inputTokens).toBe(80); // 120 total - 40 cached
    expect(result.usage.cacheReadTokens).toBe(40);
    expect(result.usage.outputTokens).toBe(20);

    const body = JSON.parse(replay.calls[0]?.body ?? "{}");
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.instructions).toBe("You are mu.");
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(model.maxOutput);
    expect(replay.calls[0]?.headers.authorization).toBe("Bearer test");
  });

  test("streams a function call and maps stopReason to toolUse", async () => {
    const replay = replayFetch(toolCassette);
    const stream = streamOpenAI(model, ctx, { apiKey: "test", fetch: replay.fetch });
    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "toolCall", id: "call_abc", name: "get_weather", arguments: { city: "Paris" } },
    ]);
  });

  test("replays reasoning items and tool results into the input", async () => {
    const replay = replayFetch(textCassette);
    const history: LlmContext = {
      messages: [
        { role: "user", content: [{ type: "text", text: "check" }], timestamp: 1 },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "prior thoughts",
              signature: JSON.stringify({ id: "rs_0", encrypted_content: "ENC_0" }),
            },
            { type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Nice" } },
          ],
          model: "openai/gpt-5.1",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "get_weather",
          content: [{ type: "text", text: "sunny" }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    const stream = streamOpenAI(model, history, { apiKey: "test", fetch: replay.fetch });
    await stream.result();
    const body = JSON.parse(replay.calls[0]?.body ?? "{}");
    expect(body.input[1]).toEqual({
      type: "reasoning",
      id: "rs_0",
      summary: [],
      encrypted_content: "ENC_0",
    });
    expect(body.input[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"Nice"}',
    });
    expect(body.input[3]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "sunny",
    });
  });

  test("routes OAuth credentials through the ChatGPT Codex backend", async () => {
    const cassette = {
      interactions: textCassette.interactions.map((interaction) => ({
        ...interaction,
        request: {
          ...interaction.request,
          url: "https://chatgpt.com/backend-api/codex/responses",
        },
      })),
    };
    const replay = replayFetch(cassette);
    const stream = streamOpenAI({ ...model, provider: "openai-codex" }, ctx, {
      getCredentials: async () => ({ type: "oauth", accessToken: "tok", accountId: "acc" }),
      fetch: replay.fetch,
      maxTokens: 1234,
      sessionId: "session-123",
    });
    const result = await stream.result();
    expect(result.stopReason).toBe("end");
    expect(replay.calls[0]?.headers.authorization).toBe("Bearer tok");
    expect(replay.calls[0]?.headers["chatgpt-account-id"]).toBe("acc");
    expect(replay.calls[0]?.headers.originator).toBe("mu");
    expect(replay.calls[0]?.headers["openai-beta"]).toBe("responses=experimental");
    expect(replay.calls[0]?.headers["session-id"]).toBe("session-123");
    expect(replay.calls[0]?.headers["x-client-request-id"]).toBe("session-123");

    const body = JSON.parse(replay.calls[0]?.body ?? "{}");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).toMatchObject({
      model: "gpt-5.1",
      store: false,
      stream: true,
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-123",
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    expect(body.tools[0].strict).toBeNull();
  });

  test("clamps Codex request correlation ids to the backend limit", async () => {
    const cassette = {
      interactions: textCassette.interactions.map((interaction) => ({
        ...interaction,
        request: {
          ...interaction.request,
          url: "https://chatgpt.com/backend-api/codex/responses",
        },
      })),
    };
    const replay = replayFetch(cassette);
    const stream = streamOpenAI({ ...model, provider: "openai-codex" }, ctx, {
      getCredentials: async () => ({ type: "oauth", accessToken: "tok", accountId: "acc" }),
      fetch: replay.fetch,
      sessionId: "x".repeat(100),
    });

    expect((await stream.result()).stopReason).toBe("end");
    expect(replay.calls[0]?.headers["session-id"]).toBe("x".repeat(64));
    expect(JSON.parse(replay.calls[0]?.body ?? "{}").prompt_cache_key).toBe("x".repeat(64));
  });

  test("re-resolves credentials for each retried HTTP request", async () => {
    let resolutions = 0;
    const authorizations: string[] = [];
    const recorded = textCassette.interactions[0];
    const retryFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (authorizations.length === 1) {
        return new Response("slow down", {
          status: 429,
          headers: { "retry-after-ms": "1" },
        });
      }
      return new Response(recorded?.response.body ?? "", {
        status: recorded?.response.status ?? 200,
        ...(recorded?.response.headers ? { headers: recorded.response.headers } : {}),
      });
    }) as typeof fetch;
    const stream = streamOpenAI(model, ctx, {
      getCredentials: async () => ({
        type: "apiKey",
        apiKey: `key-${++resolutions}`,
      }),
      fetch: retryFetch,
      maxRetries: 1,
    });

    expect((await stream.result()).stopReason).toBe("end");
    expect(resolutions).toBe(2);
    expect(authorizations).toEqual(["Bearer key-1", "Bearer key-2"]);
  });
});
