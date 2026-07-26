import { describe, expect, test } from "bun:test";
import { findModel } from "../catalog.ts";
import textCassette from "../fixtures/gemini-text.json" with { type: "json" };
import toolCassette from "../fixtures/gemini-tool.json" with { type: "json" };
import { replayFetch } from "../testing/replay.ts";
import type { LlmContext, ModelInfo, ProviderStreamEvent } from "../types.ts";
import { streamGemini } from "./gemini.ts";

const model = findModel("google/gemini-2.5-pro") as ModelInfo;

const ctx: LlmContext = {
  systemPrompt: [{ text: "You are mu." }],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Hi" },
        { type: "image", mimeType: "image/png", data: "aWJvcg==" },
      ],
      timestamp: 1,
    },
  ],
  tools: [
    {
      name: "get_weather",
      description: "Get weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ],
};

describe("streamGemini", () => {
  test("streams thought + text and computes usage from metadata", async () => {
    const replay = replayFetch(textCassette);
    const events: ProviderStreamEvent[] = [];
    const stream = streamGemini(model, ctx, {
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
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "thinking_end",
      "done",
    ]);
    expect(result.content).toEqual([
      { type: "thinking", thinking: "Let me think." },
      { type: "text", text: "Hello" },
    ]);
    expect(result.stopReason).toBe("end");
    expect(result.usage.inputTokens).toBe(60); // 80 prompt - 20 cached
    expect(result.usage.cacheReadTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(14); // 10 candidates + 4 thoughts

    const call = replay.calls[0];
    expect(call?.headers["x-goog-api-key"]).toBe("test");
    const body = JSON.parse(call?.body ?? "{}");
    expect(body.systemInstruction.parts[0].text).toBe("You are mu.");
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 8192,
      includeThoughts: true,
    });
    expect(body.contents[0].parts[1].inlineData.mimeType).toBe("image/png");
    expect(body.tools[0].functionDeclarations[0].name).toBe("get_weather");
  });

  test("emits complete tool call with generated id and thought signature", async () => {
    const replay = replayFetch(toolCassette);
    const stream = streamGemini(model, ctx, { apiKey: "test", fetch: replay.fetch });
    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");
    const call = result.content[0];
    expect(call?.type).toBe("toolCall");
    if (call?.type === "toolCall") {
      expect(call.name).toBe("get_weather");
      expect(call.arguments).toEqual({ city: "Paris" });
      expect(call.signature).toBe("TSIG_1");
      expect(call.id).toContain("get_weather");
    }
  });

  test("replays tool calls and results as functionCall/functionResponse parts", async () => {
    const replay = replayFetch(textCassette);
    const history: LlmContext = {
      messages: [
        { role: "user", content: [{ type: "text", text: "check" }], timestamp: 1 },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_0_get_weather",
              name: "get_weather",
              arguments: { city: "Nice" },
              signature: "TSIG_9",
            },
          ],
          model: "google/gemini-2.5-pro",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_0_get_weather",
          toolName: "get_weather",
          content: [{ type: "text", text: "sunny" }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    const stream = streamGemini(model, history, { apiKey: "test", fetch: replay.fetch });
    await stream.result();
    const body = JSON.parse(replay.calls[0]?.body ?? "{}");
    expect(body.contents[1]).toEqual({
      role: "model",
      parts: [
        {
          functionCall: { name: "get_weather", args: { city: "Nice" } },
          thoughtSignature: "TSIG_9",
        },
      ],
    });
    expect(body.contents[2].parts[0].functionResponse).toEqual({
      name: "get_weather",
      response: { output: "sunny" },
    });
  });
});
