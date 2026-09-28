import { expect, test } from "bun:test";
import { type AgentMessage, SessionTree } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";

const observe = (id: string) => ({
  content: [{ type: "toolCall" as const, id, name: "observe", arguments: { id } }],
});

function observeTool() {
  return {
    name: "observe",
    description: "Observe state",
    inputSchema: { type: "object" },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => ({
      content: [
        { type: "text" as const, text: `full state ${args.id} ${"detail ".repeat(200)}` },
        { type: "image" as const, mimeType: "image/jpeg", data: "x".repeat(400) },
      ],
      retention: { key: "state", summary: `observed ${args.id}` },
    }),
  };
}

function toolTexts(messages: { role: string; content: { type: string; text?: string }[] }[]) {
  return messages
    .filter((message) => message.role === "toolResult")
    .map((message) => message.content.map((block) => block.text ?? `<${block.type}>`).join(""));
}

test("only the newest retained tool result reaches the model, and resume replays it", async () => {
  const provider = new FakeProvider([
    observe("a"),
    observe("b"),
    observe("c"),
    { content: [{ type: "text", text: "done" }] },
  ]);
  const agent = new Agent({ provider, model: fakeModel, tools: [observeTool()] });
  await agent.run("look three times");

  const last = provider.requests.at(-1);
  const sent = toolTexts(last?.messages ?? []);
  expect(sent.slice(0, 2)).toEqual(["observed a", "observed b"]);
  expect(sent[2]).toStartWith("full state c");
  expect(sent[2]).toEndWith("<image>");

  const live = agent.session.messagesAt();
  const restored = SessionTree.fromJsonl(agent.session.toJsonl());
  const replayed: AgentMessage[] = restored.messagesAt();
  expect(toolTexts(replayed)).toEqual(toolTexts(live));
  expect(replayed.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
    retention: { key: "state", summary: "observed c" },
  });

  const resumed = new Agent({
    provider: new FakeProvider([observe("d"), { content: [{ type: "text", text: "ok" }] }]),
    model: fakeModel,
    tools: [observeTool()],
  });
  resumed.resume(restored);
  await resumed.run("once more");
  expect(toolTexts(resumed.session.messagesAt())).toEqual([
    "observed a",
    "observed b",
    "observed c",
    expect.stringMatching(/^full state d/),
  ]);
});
