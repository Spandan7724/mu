import { describe, expect, test } from "bun:test";
import { ExtensionHost, MemorySessionStore, userMessage } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { startSideConversation } from "./side.ts";

describe("side conversations", () => {
  test("inherit context behind a boundary and keep their session in memory", async () => {
    const parentStore = new MemorySessionStore();
    const provider = new FakeProvider([{ content: [{ type: "text", text: "side answer" }] }]);
    let runtimeAttached = false;
    const side = startSideConversation(
      {
        provider,
        model: fakeModel,
        tools: [],
        session: parentStore,
        sessionId: "parent",
        refreshContext: () => [userMessage("refreshed parent context")],
        runtime: {
          attach: () => {
            runtimeAttached = true;
          },
        },
      },
      {
        messages: [userMessage("inherited question")],
        boundary: "Coding side requests are advisory.",
      },
    );

    expect(side.agent.sessionStore).toBeInstanceOf(MemorySessionStore);
    expect(side.agent.sessionStore).not.toBe(parentStore);
    expect(runtimeAttached).toBe(false);

    await side.agent.run("new side question");
    const messages = provider.requests[0]?.messages ?? [];
    expect(JSON.stringify(messages)).toContain("inherited question");
    expect(JSON.stringify(messages)).toContain("side-conversation-boundary");
    expect(JSON.stringify(messages)).toContain("Coding side requests are advisory.");
    expect(JSON.stringify(messages)).not.toContain("refreshed parent context");
    expect(await parentStore.load(side.agent.sessionId)).toBeUndefined();

    await side.close();
  });

  test("closing does not deactivate the extension host borrowed from the parent", async () => {
    const host = new ExtensionHost();
    let deactivated = false;
    await host.register({
      name: "borrowed",
      activate: (api) => {
        api.registerCommand({
          name: "borrowed",
          description: "still active",
          run: () => ({ handled: true }),
        });
      },
      deactivate: () => {
        deactivated = true;
      },
    });
    const side = startSideConversation(
      { provider: new FakeProvider([]), model: fakeModel, tools: [], extensions: host },
      { messages: [] },
    );

    await side.close();

    expect(deactivated).toBe(false);
    expect(host.commands.has("borrowed")).toBe(true);
    await host.shutdown();
  });
});
