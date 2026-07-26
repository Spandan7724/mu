// Replays cassettes recorded against the live OpenAI Responses API
// (scripts/record-fixtures.ts) — locks the client to the real wire format.
import { describe, expect, test } from "bun:test";
import { findModel } from "../catalog.ts";
import textCassette from "../fixtures/openai-text.recorded.json" with { type: "json" };
import toolCassette from "../fixtures/openai-tool.recorded.json" with { type: "json" };
import { replayFetch } from "../testing/replay.ts";
import type { LlmContext, ModelInfo } from "../types.ts";
import { streamOpenAI } from "./openai.ts";

const model = findModel("openai/gpt-5-mini") as ModelInfo;

describe("streamOpenAI against recorded live responses", () => {
  test("text completion", async () => {
    const ctx: LlmContext = {
      systemPrompt: [{ text: "You are a terse assistant." }],
      messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }], timestamp: 1 }],
    };
    const replay = replayFetch(textCassette);
    const stream = streamOpenAI(model, ctx, { apiKey: "test", fetch: replay.fetch });
    const result = await stream.result();
    expect(result.stopReason).toBe("end");
    const text = result.content.find((b) => b.type === "text");
    expect(text?.type).toBe("text");
    if (text?.type === "text") expect(text.text.length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    replay.assertExhausted();
  });

  test("tool call with parsed arguments", async () => {
    const ctx: LlmContext = {
      systemPrompt: [{ text: "You are a terse assistant." }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What is the weather in Paris? Use the tool." }],
          timestamp: 1,
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get current weather for a city",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    };
    const replay = replayFetch(toolCassette);
    const stream = streamOpenAI(model, ctx, { apiKey: "test", fetch: replay.fetch });
    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");
    const call = result.content.find((b) => b.type === "toolCall");
    expect(call?.type).toBe("toolCall");
    if (call?.type === "toolCall") {
      expect(call.name).toBe("get_weather");
      expect(typeof call.arguments.city).toBe("string");
      expect(call.id.length).toBeGreaterThan(0);
    }
    replay.assertExhausted();
  });
});
