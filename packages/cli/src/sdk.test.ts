import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { z } from "zod";
import { Agent, createAgent, type Profile } from "./sdk.ts";

describe("public SDK factory", () => {
  test("creates a domain-neutral Agent when no profile is selected", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hello" }] }]);
    const agent = await createAgent({ provider, model: fakeModel });

    expect(agent).toBeInstanceOf(Agent);
    expect(agent.tools.map((candidate) => candidate.name)).toEqual(["task"]);
    expect((await agent.run("hi")).text).toBe("hello");
  });

  test("loads the built-in coding profile explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-public-sdk-"));
    await writeFile(join(root, "note.txt"), "from the coding profile");
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: { path: "note.txt" },
          },
        ],
      },
      { content: [{ type: "text", text: "read it" }] },
    ]);
    const agent = await createAgent({
      profile: "coding",
      profileOptions: {
        root,
        home: root,
        instructions: { enabled: false },
      },
      provider,
      model: fakeModel,
    });

    expect(agent.tools.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(["read", "bash", "task", "search", "counsel"]),
    );
    const result = await agent.run("Read note.txt");
    const toolResult = result.messages.find((message) => message.role === "toolResult");
    expect(
      toolResult?.role === "toolResult" &&
        toolResult.content[0]?.type === "text" &&
        toolResult.content[0].text,
    ).toContain("from the coding profile");
    await agent.shutdown();
  });

  test("does not replace a caller's tool with a managed subagent tool", async () => {
    const customTask = {
      name: "task",
      description: "custom task",
      inputSchema: z.toJSONSchema(z.object({})),
      execute: async () => ({ content: [{ type: "text" as const, text: "custom" }] }),
    };
    const agent = await createAgent({
      provider: new FakeProvider([]),
      model: fakeModel,
      tools: [customTask],
    });

    expect(agent.tools.find((candidate) => candidate.name === "task")).toBe(customTask);
    expect(agent.tools.map((candidate) => candidate.name)).toEqual(["task"]);
  });

  test("keeps search and counsel exclusive to the coding profile", async () => {
    const profile: Profile = {
      name: "research",
      toolset: [],
      promptFor: () => [{ text: "Research carefully." }],
      permissionDefaults: [],
      subagents: { inspectionTools: [] },
    };
    const agent = await createAgent({
      profile,
      provider: new FakeProvider([]),
      model: fakeModel,
    });

    expect(agent.tools.map((candidate) => candidate.name)).toEqual(["task"]);
  });
});
