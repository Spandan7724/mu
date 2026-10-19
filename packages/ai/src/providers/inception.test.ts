import { describe, expect, test } from "bun:test";
import { findModel } from "../catalog.ts";
import { getProvider } from "../registry.ts";
import type { LlmContext, ModelInfo } from "../types.ts";

const provider = getProvider("inception");
const model = findModel("inception/mercury-3") as ModelInfo;
const context: LlmContext = {
  systemPrompt: [{ text: "You are mu." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }],
  tools: [
    {
      name: "lookup",
      description: "Look up a value",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
};
type Json = Record<string, unknown>;
interface Capture {
  url?: string;
  headers?: Headers;
  body?: Json;
}

function mockStream(
  capture: Capture,
  chunks: Json[] = [{ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }],
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    capture.url = String(input);
    capture.headers = new Headers(init?.headers);
    capture.body = JSON.parse(String(init?.body)) as Json;
    return new Response(
      [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
}

describe("Inception Labs", () => {
  test("sends authenticated streaming tool requests with supported parameters", async () => {
    const capture: Capture = {};
    const result = await provider
      .stream(model, context, {
        apiKey: "inception-key",
        fetch: mockStream(capture),
        thinkingLevel: "medium",
        maxTokens: 2048,
        sessionId: "session-1",
      })
      .result();

    expect(capture.url).toBe("https://api.inceptionlabs.ai/v1/chat/completions");
    expect(capture.headers?.get("authorization")).toBe("Bearer inception-key");
    expect(capture.body).toEqual({
      model: "mercury-3",
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 2048,
      reasoning_effort: "medium",
      messages: [
        { role: "system", content: "You are mu." },
        { role: "user", content: "Hello" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a value",
            parameters: context.tools?.[0]?.inputSchema,
          },
        },
      ],
      tool_choice: "auto",
    });
    expect(result.stopReason).toBe("end");
    expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  test("resolves the Inception environment key", async () => {
    const previous = process.env.INCEPTION_API_KEY;
    process.env.INCEPTION_API_KEY = "env-inception-key";
    try {
      const capture: Capture = {};
      const result = await provider.stream(model, context, { fetch: mockStream(capture) }).result();
      expect(result.stopReason).toBe("end");
      expect(capture.headers?.get("authorization")).toBe("Bearer env-inception-key");
      expect(capture.body?.max_completion_tokens).toBe(131_072);
      expect(capture.body?.reasoning_effort).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.INCEPTION_API_KEY;
      else process.env.INCEPTION_API_KEY = previous;
    }
  });

  test("accepts every documented effort and maps off to instant", async () => {
    for (const level of ["instant", "low", "medium", "high", "off"]) {
      const capture: Capture = {};
      await provider
        .stream(model, context, {
          getCredentials: async () => ({ type: "apiKey", apiKey: "saved-key" }),
          fetch: mockStream(capture),
          thinkingLevel: level,
        })
        .result();
      expect(capture.headers?.get("authorization")).toBe("Bearer saved-key");
      expect(capture.body?.reasoning_effort).toBe(level === "off" ? "instant" : level);
    }
  });

  test("accounts for current and legacy cached usage without double-counting", async () => {
    for (const details of [
      { prompt_tokens_details: { cached_tokens: 4 } },
      { cached_input_tokens: 4 },
      { prompt_tokens_details: { cached_tokens: 4 }, cached_input_tokens: 9 },
      { prompt_tokens_details: { cached_tokens: 0 }, cached_input_tokens: 9 },
    ]) {
      const capture: Capture = {};
      const cached =
        details.prompt_tokens_details?.cached_tokens ?? details.cached_input_tokens ?? 0;
      const result = await provider
        .stream(model, context, {
          apiKey: "key",
          fetch: mockStream(capture, [
            { choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, ...details } },
          ]),
        })
        .result();
      expect(result.usage).toMatchObject({
        inputTokens: 12 - cached,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
        outputTokens: 3,
      });
      expect(result.usage.costUsd).toBeCloseTo(
        ((12 - cached) * 0.1 + cached * 0.01 + 3 * 0.35) / 1_000_000,
        12,
      );
    }
  });

  test("streams fragmented tool calls and replays their results on the next turn", async () => {
    const capture: Capture = {};
    const stream = provider.stream(model, context, {
      apiKey: "key",
      fetch: mockStream(capture, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"query":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"value"}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    expect(events).toContain("toolcall_delta");
    expect(events).toContain("toolcall_end");
    expect(result.stopReason).toBe("toolUse");
    expect(result.model).toBe("inception/mercury-3");
    expect(result.content).toEqual([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "value" } },
    ]);

    await provider
      .stream(
        model,
        {
          ...context,
          messages: [
            ...context.messages,
            result,
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "lookup",
              content: [{ type: "text", text: "42" }],
              isError: false,
              timestamp: 2,
            },
          ],
        },
        { apiKey: "key", fetch: mockStream(capture) },
      )
      .result();
    expect((capture.body?.messages as Json[]).slice(-2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"value"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "42" },
    ]);
  });
});
