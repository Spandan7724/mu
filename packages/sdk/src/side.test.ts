import { describe, expect, test } from "bun:test";
import { customMessage, ExtensionHost, MemorySessionStore, userMessage } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { MCP_CONTEXT_TYPE } from "./mcp.ts";
import { startSideConversation } from "./side.ts";
import { SKILLS_CONTEXT_TYPE } from "./skills.ts";

const tool = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  execute: async () => ({ content: [{ type: "text" as const, text: name }] }),
});

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

  test("a fixed toolset hides other tools and extension context", async () => {
    const host = new ExtensionHost();
    let providerRan = false;
    await host.register({
      name: "catalog",
      activate: (api) => {
        api.registerTool(tool("skill"));
        api.onInput(() => ({
          text: "side question, rewritten",
          context: [customMessage("skill", "attached skill body")],
        }));
        api.registerContextProvider(() => {
          providerRan = true;
          return [customMessage(SKILLS_CONTEXT_TYPE, "fresh listing")];
        });
      },
    });
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const side = startSideConversation(
      { provider, model: fakeModel, tools: [tool("read"), tool("write")], extensions: host },
      {
        messages: [
          userMessage("inherited question"),
          customMessage(SKILLS_CONTEXT_TYPE, "inherited skill listing"),
          customMessage(MCP_CONTEXT_TYPE, "inherited mcp listing"),
          customMessage("instructions", "inherited instructions"),
        ],
        tools: ["read"],
      },
    );

    expect(side.agent.tools.map((candidate) => candidate.name)).toEqual(["read"]);
    await side.agent.run("side question");
    const request = provider.requests[0];
    expect(request?.tools?.map((candidate) => candidate.name)).toEqual(["read"]);
    const sent = JSON.stringify(request?.messages);
    expect(sent).toContain("inherited instructions");
    expect(sent).not.toContain("inherited skill listing");
    expect(sent).not.toContain("inherited mcp listing");
    expect(sent).not.toContain("fresh listing");
    expect(sent).not.toContain("attached skill body");
    expect(sent).toContain("side question, rewritten");
    expect(providerRan).toBe(false);

    await side.close();
    await host.shutdown();
  });
});
