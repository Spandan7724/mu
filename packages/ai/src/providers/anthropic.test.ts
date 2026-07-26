import { describe, expect, test } from "bun:test";
import { findModel } from "../catalog.ts";
import contextTooLong from "../fixtures/anthropic-context-too-long.json" with { type: "json" };
import retryCassette from "../fixtures/anthropic-retry.json" with { type: "json" };
import textCassette from "../fixtures/anthropic-text.json" with { type: "json" };
import toolCassette from "../fixtures/anthropic-tool.json" with { type: "json" };
import { replayFetch } from "../testing/replay.ts";
import type { LlmContext, ModelInfo, ProviderStreamEvent } from "../types.ts";
import { streamAnthropic } from "./anthropic.ts";

const model = findModel("anthropic/claude-opus-5") as ModelInfo;

const baseCtx: LlmContext = {
  systemPrompt: [{ text: "You are mu." }, { text: "Session context here.", dynamic: true }],
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

describe("streamAnthropic", () => {
  test("streams text with unified events and usage incl. cache tokens", async () => {
    const replay = replayFetch(textCassette);
    const events: ProviderStreamEvent[] = [];
    const stream = streamAnthropic(model, baseCtx, { apiKey: "test", fetch: replay.fetch });
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.stopReason).toBe("end");
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(12);
    expect(result.usage.cacheReadTokens).toBe(50);
    expect(result.usage.cacheWriteTokens).toBe(25);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(result.model).toBe("anthropic/claude-opus-5");
    replay.assertExhausted();
  });

  test("places cache_control breakpoints and thinking config in the request", async () => {
    const replay = replayFetch(textCassette);
    const stream = streamAnthropic(model, baseCtx, {
      apiKey: "test",
      fetch: replay.fetch,
      thinkingLevel: "high",
    });
    await stream.result();

    const call = replay.calls[0];
    expect(call).toBeDefined();
    const body = JSON.parse(call?.body ?? "{}");
    // static→dynamic boundary: breakpoint on the last static system section
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[1].cache_control).toBeUndefined();
    // last tool carries a breakpoint
    expect(body.tools[0].cache_control).toEqual({ type: "ephemeral" });
    // recent-message boundary
    const lastMsg = body.messages[body.messages.length - 1];
    expect(lastMsg.content[lastMsg.content.length - 1].cache_control).toEqual({
      type: "ephemeral",
    });
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(call?.headers["x-api-key"]).toBe("test");
    expect(body.messages[0].content[1].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "aWJvcg==",
    });
  });

  test("accumulates tool-call json and thinking signature", async () => {
    const replay = replayFetch(toolCassette);
    const stream = streamAnthropic(model, baseCtx, { apiKey: "test", fetch: replay.fetch });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "thinking", thinking: "I should check the weather.", signature: "SIG_ABC123" },
      {
        type: "toolCall",
        id: "toolu_01",
        name: "get_weather",
        arguments: { city: "Paris", unit: "c" },
      },
    ]);
  });

  test("classifies context-too-long as a typed error event", async () => {
    const replay = replayFetch(contextTooLong);
    const stream = streamAnthropic(model, baseCtx, { apiKey: "test", fetch: replay.fetch });
    const events: ProviderStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.errorKind).toBe("context_too_long");
      expect(last.error.stopReason).toBe("error");
      expect(last.error.usage.inputTokens).toBe(0);
    }
  });

  test("retries a 429 and succeeds", async () => {
    const replay = replayFetch(retryCassette);
    const stream = streamAnthropic(model, baseCtx, {
      apiKey: "test",
      fetch: replay.fetch,
      maxRetries: 1,
    });
    const result = await stream.result();
    expect(result.stopReason).toBe("end");
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(replay.calls.length).toBe(2);
    replay.assertExhausted();
  });

  test("replays assistant thinking with signature and tool results", async () => {
    const replay = replayFetch(textCassette);
    const ctx: LlmContext = {
      messages: [
        { role: "user", content: [{ type: "text", text: "check" }], timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "SIG_1" },
            { type: "toolCall", id: "toolu_9", name: "get_weather", arguments: { city: "Nice" } },
          ],
          model: "anthropic/claude-opus-5",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "toolu_9",
          toolName: "get_weather",
          content: [{ type: "text", text: "sunny" }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    const stream = streamAnthropic(model, ctx, { apiKey: "test", fetch: replay.fetch });
    await stream.result();
    const body = JSON.parse(replay.calls[0]?.body ?? "{}");
    expect(body.messages[1].content[0]).toEqual({
      type: "thinking",
      thinking: "hmm",
      signature: "SIG_1",
    });
    expect(body.messages[2].content[0].type).toBe("tool_result");
    expect(body.messages[2].content[0].tool_use_id).toBe("toolu_9");
  });
});
