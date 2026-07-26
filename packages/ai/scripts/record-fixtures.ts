// Records real provider interactions into cassette JSON files under
// src/fixtures/. Requires live API keys; run manually, never in CI:
//   ANTHROPIC_API_KEY=... bun packages/ai/scripts/record-fixtures.ts anthropic
// Recorded cassettes replace the synthetic ones checked in during M1.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findModel } from "../src/catalog.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { streamGemini } from "../src/providers/gemini.ts";
import { streamOpenAI } from "../src/providers/openai.ts";
import { recordFetch } from "../src/testing/replay.ts";
import type { LlmContext, ModelInfo } from "../src/types.ts";

const FIXTURES_DIR = join(import.meta.dir, "../src/fixtures");

const streams = {
  anthropic: { fn: streamAnthropic, model: "anthropic/claude-haiku-4-5" },
  openai: { fn: streamOpenAI, model: "openai/gpt-5-mini" },
  google: { fn: streamGemini, model: "google/gemini-2.5-flash" },
} as const;

const ctxText: LlmContext = {
  systemPrompt: [{ text: "You are a terse assistant." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Say hello." }], timestamp: Date.now() },
  ],
};

const ctxTool: LlmContext = {
  systemPrompt: [{ text: "You are a terse assistant." }],
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "What is the weather in Paris? Use the tool." }],
      timestamp: Date.now(),
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

const target = process.argv[2];
for (const [providerId, { fn, model: modelName }] of Object.entries(streams)) {
  if (target && target !== providerId) continue;
  const model = findModel(modelName) as ModelInfo;
  for (const [suffix, ctx] of [
    ["text", ctxText],
    ["tool", ctxTool],
  ] as const) {
    const { fetch: recording, cassette } = recordFetch();
    const stream = fn(model, ctx, { fetch: recording, maxTokens: 300 });
    const result = await stream.result();
    if (result.stopReason === "error") {
      console.error(`${providerId}-${suffix} failed: ${result.errorMessage}`);
      continue;
    }
    const file = join(FIXTURES_DIR, `${providerId}-${suffix}.recorded.json`);
    writeFileSync(file, `${JSON.stringify(cassette, null, 2)}\n`);
    console.log(`wrote ${file} (${result.stopReason})`);
  }
}
