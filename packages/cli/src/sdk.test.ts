import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, createAgent } from "./sdk.ts";

describe("public SDK factory", () => {
  test("creates a domain-neutral Agent when no profile is selected", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hello" }] }]);
    const agent = await createAgent({ provider, model: fakeModel });

    expect(agent).toBeInstanceOf(Agent);
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

    const result = await agent.run("Read note.txt");
    const toolResult = result.messages.find((message) => message.role === "toolResult");
    expect(
      toolResult?.role === "toolResult" &&
        toolResult.content[0]?.type === "text" &&
        toolResult.content[0].text,
    ).toContain("from the coding profile");
    await agent.shutdown();
  });
});
