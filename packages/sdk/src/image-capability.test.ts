import { expect, test } from "bun:test";
import type { LlmContext } from "@mu/ai";
import type { ToolCallContext } from "@mu/core";
import { FakeProvider, fakeModel, type ScriptedTurn } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";

const visionModel = {
  ...fakeModel,
  id: "fake-vision",
  modalities: ["text" as const, "image" as const],
};
const IMAGE = { type: "image" as const, mimeType: "image/png", data: "aGk=" };

const look = (id: string): ScriptedTurn => ({
  content: [{ type: "toolCall", id, name: "look", arguments: {} }],
});
const reply = (text: string): ScriptedTurn => ({ content: [{ type: "text", text }] });
const refusal: ScriptedTurn = {
  content: [],
  stopReason: "error",
  errorKind: "bad_request",
  errorMessage: "Image inputs are not supported for this model",
};

function lookTool(seen: (ToolCallContext | undefined)[]) {
  return {
    name: "look",
    description: "Look at the screen",
    inputSchema: { type: "object" },
    execute: async (
      _id: string,
      _args: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate?: unknown,
      _background?: AbortSignal,
      context?: ToolCallContext,
    ) => {
      seen.push(context);
      return {
        content: [
          { type: "text" as const, text: "screen" },
          ...(context?.acceptsImages ? [IMAGE] : []),
        ],
      };
    },
  };
}

function images(request: LlmContext | undefined): number {
  let count = 0;
  for (const message of request?.messages ?? [])
    if (message.role !== "assistant")
      for (const block of message.content) if (block.type === "image") count++;
  return count;
}

test("tools learn whether the running model reads images", async () => {
  const seen: (ToolCallContext | undefined)[] = [];
  const provider = new FakeProvider([look("a"), reply("ok"), look("b"), reply("ok")]);
  const agent = new Agent({ provider, model: fakeModel, tools: [lookTool(seen)] });
  await agent.run("look");
  expect(seen[0]).toEqual({ model: "fake/fake-1", acceptsImages: false });

  agent.setModel(visionModel);
  await agent.run("look again");
  expect(seen[1]).toEqual({ model: "fake/fake-vision", acceptsImages: true });
  expect(images(provider.requests.at(-1))).toBe(1);
});

test("a text-only model gets a note where each image was", async () => {
  const provider = new FakeProvider([reply("ok")]);
  const agent = new Agent({ provider, model: fakeModel });
  await agent.run([{ type: "text", text: "what is this" }, IMAGE]);
  const user = provider.requests[0]?.messages.find((message) => message.role === "user");
  expect(images(provider.requests[0])).toBe(0);
  expect(user?.content).toEqual([
    { type: "text", text: "what is this" },
    { type: "text", text: "(image omitted: this model cannot read images)" },
  ]);
});

test("a model that rejects images keeps working without them for the rest of the session", async () => {
  const seen: (ToolCallContext | undefined)[] = [];
  const provider = new FakeProvider([look("a"), refusal, reply("done"), look("b"), reply("ok")]);
  const agent = new Agent({ provider, model: visionModel, tools: [lookTool(seen)] });
  const events: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "provider_retry") events.push(event.errorMessage);
  });

  const first = await agent.run("look");
  expect(first.reason).toBe("done");
  expect(first.text).toBe("done");
  expect(images(provider.requests[1])).toBe(1);
  expect(images(provider.requests[2])).toBe(0);
  expect(events).toEqual([
    "fake/fake-vision rejected a request with an image; trying again without images",
  ]);

  await agent.run("look again");
  expect(seen[1]).toEqual({ model: "fake/fake-vision", acceptsImages: false });
  expect(images(provider.requests.at(-1))).toBe(0);
});

test("a rejection that was not about images still fails, and images stay on", async () => {
  const seen: (ToolCallContext | undefined)[] = [];
  const provider = new FakeProvider([look("a"), refusal, refusal, look("b"), reply("ok")]);
  const agent = new Agent({ provider, model: visionModel, tools: [lookTool(seen)] });

  const first = await agent.run("look");
  expect(first.reason).toBe("error");
  expect(provider.callCount).toBe(3);

  await agent.run("look again");
  expect(seen[1]?.acceptsImages).toBe(true);
});
