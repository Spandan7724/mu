import { describe, expect, test } from "bun:test";
import { findModel } from "../catalog.ts";
import textCassette from "../fixtures/openai-text.json" with { type: "json" };
import toolCassette from "../fixtures/openai-tool.json" with { type: "json" };
import { replayFetch } from "../testing/replay.ts";
import type {
  LlmContext,
  ModelInfo,
  ProviderModelDiscoveryOptions,
  ProviderStreamEvent,
} from "../types.ts";
import { discoverOpenAICodexModels, streamOpenAI } from "./openai.ts";

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

describe("discoverOpenAICodexModels", () => {
  test("discovers the models available to the signed-in ChatGPT plan", async () => {
    let requestUrl = "";
    let requestHeaders = new Headers();
    const discovered = await discoverOpenAICodexModels({
      clientVersion: "1.2.3",
      currentModels: [
        {
          provider: "openai-codex",
          id: "gpt-existing",
          contextWindow: 200_000,
          maxOutput: 64_000,
          modalities: ["text"],
          thinking: true,
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      getCredentials: async () => ({
        type: "oauth",
        accessToken: "access",
        accountId: "account",
      }),
      fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requestUrl = String(input);
        requestHeaders = new Headers(init?.headers);
        return Response.json({
          models: [
            {
              slug: "gpt-new",
              display_name: "GPT New",
              context_window: 400_000,
              input_modalities: ["text", "image"],
              default_reasoning_level: "low",
              supported_reasoning_levels: [
                { effort: "low" },
                { effort: "medium" },
                { effort: "xhigh" },
                { effort: "ultra" },
              ],
              visibility: "list",
              supported_in_api: true,
              priority: 1,
            },
            {
              slug: "gpt-existing",
              display_name: "GPT Existing",
              max_context_window: 272_000,
              visibility: "list",
              supported_in_api: true,
              priority: 2,
            },
            {
              slug: "gpt-hidden",
              context_window: 100_000,
              visibility: "hide",
            },
            {
              slug: "gpt-unsupported",
              context_window: 100_000,
              visibility: "list",
              supported_in_api: false,
            },
          ],
        });
      }) as unknown as typeof fetch,
    });

    expect(requestUrl).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.2.3");
    expect(requestHeaders.get("authorization")).toBe("Bearer access");
    expect(requestHeaders.get("chatgpt-account-id")).toBe("account");
    expect(requestHeaders.get("originator")).toBe("mu");
    expect(discovered?.map((entry) => entry.id)).toEqual(["gpt-new", "gpt-existing"]);
    expect(discovered?.[0]).toMatchObject({
      name: "GPT New",
      contextWindow: 400_000,
      maxOutput: 128_000,
      modalities: ["text", "image"],
      thinking: true,
      thinkingLevels: ["low", "medium", "xhigh", "ultra"],
      defaultThinkingLevel: "low",
    });
    expect(discovered?.[1]).toMatchObject({
      contextWindow: 272_000,
      maxOutput: 64_000,
      modalities: ["text"],
      thinking: true,
    });
  });

  test("skips plan discovery when no OAuth login is available", async () => {
    let fetched = false;
    const options: ProviderModelDiscoveryOptions = {
      currentModels: [],
      getCredentials: async () => undefined,
      fetch: (async () => {
        fetched = true;
        return Response.json({});
      }) as unknown as typeof fetch,
    };

    expect(await discoverOpenAICodexModels(options)).toBeUndefined();
    expect(fetched).toBe(false);
  });

  test("skips an empty account catalog so bundled Codex models remain available", async () => {
    const options: ProviderModelDiscoveryOptions = {
      currentModels: [],
      getCredentials: async () => ({
        type: "oauth",
        accessToken: "access",
        accountId: "account",
      }),
      fetch: (async () => Response.json({ models: [] })) as unknown as typeof fetch,
    };

    expect(await discoverOpenAICodexModels(options)).toBeUndefined();
  });
});

describe("streamOpenAI", () => {
  test("sends hosted web search and preserves native activity, citations, and replay", async () => {
    const responseEvents = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "web_search_call", id: "ws_1", status: "in_progress" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "mu agent", queries: ["mu agent"] },
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_1" },
      },
      { type: "response.output_text.delta", output_index: 1, delta: "Mu is an agent." },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "message",
          id: "msg_1",
          content: [
            {
              type: "output_text",
              text: "Mu is an agent.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com/mu",
                  title: "Mu",
                  start_index: 0,
                  end_index: 2,
                },
              ],
            },
          ],
        },
      },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 10, output_tokens: 4 } },
      },
    ];
    const cassette = {
      interactions: [
        {
          request: { method: "POST", url: "https://api.openai.com/v1/responses" },
          response: {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: responseEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          },
        },
      ],
    };
    const replay = replayFetch(cassette);
    const searchContext: LlmContext = {
      ...ctx,
      hostedTools: [
        {
          type: "web_search",
          externalWebAccess: true,
          indexedWebAccess: true,
          filters: { allowedDomains: ["example.com"] },
          userLocation: { type: "approximate", country: "US", city: "Seattle" },
          searchContextSize: "high",
        },
      ],
    };
    const events: ProviderStreamEvent[] = [];
    const stream = streamOpenAI(model, searchContext, {
      apiKey: "test",
      fetch: replay.fetch,
    });
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(events.map((event) => event.type)).toContain("websearch_start");
    expect(events.map((event) => event.type)).toContain("websearch_end");
    expect(result.content).toEqual([
      {
        type: "webSearch",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "mu agent", queries: ["mu agent"] },
      },
      {
        type: "text",
        text: "Mu is an agent.",
        citations: [
          {
            url: "https://example.com/mu",
            title: "Mu",
            startIndex: 0,
            endIndex: 2,
          },
        ],
      },
    ]);
    const body = JSON.parse(replay.calls[0]?.body ?? "{}");
    expect(body.tools.at(-1)).toEqual({
      type: "web_search",
      external_web_access: true,
      indexed_web_access: true,
      filters: { allowed_domains: ["example.com"] },
      user_location: { type: "approximate", country: "US", city: "Seattle" },
      search_context_size: "high",
    });

    const historyReplay = replayFetch(textCassette);
    await streamOpenAI(
      model,
      { messages: [{ ...result, timestamp: 2 }] },
      { apiKey: "test", fetch: historyReplay.fetch },
    ).result();
    expect(JSON.parse(historyReplay.calls[0]?.body ?? "{}").input[0]).toEqual({
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { type: "search", query: "mu agent", queries: ["mu agent"] },
    });
  });

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

  test("preserves tool-result images as Responses image input", async () => {
    const replay = replayFetch(textCassette);
    const history: LlmContext = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "render_image", arguments: {} }],
          model: "openai/gpt-5.1",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "render_image",
          content: [
            { type: "text", text: "screen" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    await streamOpenAI(model, history, { apiKey: "test", fetch: replay.fetch }).result();
    const body = JSON.parse(replay.calls[0]?.body ?? "{}");
    expect(body.input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: [
        { type: "input_text", text: "screen" },
        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
      ],
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
    const stream = streamOpenAI(
      { ...model, provider: "openai-codex" },
      {
        ...ctx,
        hostedTools: [{ type: "web_search", externalWebAccess: false }],
      },
      {
        getCredentials: async () => ({ type: "oauth", accessToken: "tok", accountId: "acc" }),
        fetch: replay.fetch,
        maxTokens: 1234,
        sessionId: "session-123",
      },
    );
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
    expect(body.tools[1]).toEqual({ type: "web_search", external_web_access: false });
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
