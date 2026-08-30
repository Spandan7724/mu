import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@mu/ai";
import { ExtensionHost, type PermissionRequest } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { type SubagentDetails, subagentsExtension } from "./subagents.ts";
import { tool } from "./tool.ts";

const codexTerra: ModelInfo = {
  ...fakeModel,
  provider: "openai-codex",
  id: "gpt-5.6-terra",
  thinkingLevels: ["low", "medium", "high", "xhigh"],
  defaultThinkingLevel: "medium",
};

function details(agent: Agent, name: string): SubagentDetails {
  const result = agent.session
    .messagesAt()
    .find((message) => message.role === "toolResult" && message.toolName === name);
  if (result?.role !== "toolResult") throw new Error(`Missing ${name} result`);
  return result.details as SubagentDetails;
}

describe("managed subagents", () => {
  test("search selects Terra at low reasoning and receives only inspection tools", async () => {
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "search-1",
            name: "search",
            arguments: { query: "Trace the parser end to end" },
          },
        ],
      },
      { content: [{ type: "text", text: "packages/parser.ts:10-40" }] },
      { content: [{ type: "text", text: "Found it." }] },
    ]);
    const inspect = tool({
      name: "inspect",
      description: "inspect",
      inputSchema: z.object({}),
      execute: () => "seen",
    });
    const mutate = tool({
      name: "mutate",
      description: "mutate",
      inputSchema: z.object({}),
      execute: () => "changed",
    });
    const host = new ExtensionHost();
    const parent = new Agent({
      provider,
      model: codexTerra,
      thinkingLevel: "medium",
      tools: [inspect, mutate],
      extensions: host,
    });
    await host.register(
      subagentsExtension({
        parent: () => parent,
        coding: { inspectionTools: ["inspect"] },
        inspectionPermissions: [{ permission: "*", pattern: "*", action: "allow" }],
      }),
    );

    await parent.run("investigate");

    expect(provider.requests[1]?.tools?.map((candidate) => candidate.name)).toEqual(["inspect"]);
    expect(details(parent, "search")).toMatchObject({
      kind: "search",
      model: "openai-codex/gpt-5.6-terra",
      thinkingLevel: "low",
      reason: "done",
    });
  });

  test("counsel selects the stronger same-provider model and raises reasoning one level", async () => {
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "counsel-1",
            name: "counsel",
            arguments: { question: "Is there a better design?" },
          },
        ],
      },
      { content: [{ type: "text", text: "Use the smaller boundary." }] },
      { content: [{ type: "text", text: "Agreed." }] },
    ]);
    const host = new ExtensionHost();
    const parent = new Agent({
      provider,
      model: codexTerra,
      thinkingLevel: "medium",
      extensions: host,
    });
    await host.register(
      subagentsExtension({
        parent: () => parent,
        coding: { inspectionTools: [] },
        inspectionPermissions: [{ permission: "*", pattern: "*", action: "allow" }],
      }),
    );

    await parent.run("ask counsel");

    expect(details(parent, "counsel")).toMatchObject({
      kind: "counsel",
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "high",
    });
  });

  test("search uses each provider's fast same-provider model", async () => {
    const cases: { parentModel: ModelInfo; expected: string }[] = [
      {
        parentModel: { ...fakeModel, provider: "openai", id: "gpt-5.6-sol" },
        expected: "openai/gpt-5.6-terra",
      },
      {
        parentModel: { ...fakeModel, provider: "anthropic", id: "claude-opus-5" },
        expected: "anthropic/claude-sonnet-5",
      },
      {
        parentModel: { ...fakeModel, provider: "google", id: "gemini-2.5-pro" },
        expected: "google/gemini-2.5-flash",
      },
    ];

    for (const { parentModel, expected } of cases) {
      const provider = new FakeProvider([
        {
          content: [
            {
              type: "toolCall",
              id: "search-1",
              name: "search",
              arguments: { query: "Trace it" },
            },
          ],
        },
        { content: [{ type: "text", text: "Found." }] },
        { content: [{ type: "text", text: "Done." }] },
      ]);
      const host = new ExtensionHost();
      const parent = new Agent({ provider, model: parentModel, extensions: host });
      await host.register(
        subagentsExtension({ parent: () => parent, coding: { inspectionTools: [] } }),
      );

      await parent.run("search");

      expect(details(parent, "search").model).toBe(expected);
      expect(details(parent, "search").thinkingLevel).toBe("low");
    }
  });

  test("counsel retains an unknown provider model and never downshifts maximum reasoning", async () => {
    const model: ModelInfo = {
      ...fakeModel,
      provider: "custom",
      id: "gpt-reasoner",
      thinkingLevels: ["low", "medium", "high"],
      defaultThinkingLevel: "medium",
    };
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "counsel-1",
            name: "counsel",
            arguments: { question: "Double-check this" },
          },
        ],
      },
      { content: [{ type: "text", text: "Looks sound." }] },
      { content: [{ type: "text", text: "Done." }] },
    ]);
    const host = new ExtensionHost();
    const parent = new Agent({
      provider,
      model,
      thinkingLevel: "high",
      extensions: host,
    });
    await host.register(
      subagentsExtension({ parent: () => parent, coding: { inspectionTools: [] } }),
    );

    await parent.run("consult");

    expect(details(parent, "counsel")).toMatchObject({
      model: "custom/gpt-reasoner",
      thinkingLevel: "high",
    });
  });

  test("task uses the parent model, excludes delegation tools, and persists its usage", async () => {
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "task-1",
            name: "task",
            arguments: { description: "edit one file", prompt: "Make the requested edit" },
          },
        ],
      },
      {
        content: [{ type: "text", text: "Edited and verified." }],
        usage: { inputTokens: 40, outputTokens: 20 },
      },
      { content: [{ type: "text", text: "Integrated." }] },
    ]);
    const work = tool({
      name: "work",
      description: "work",
      inputSchema: z.object({}),
      execute: () => "done",
    });
    const host = new ExtensionHost();
    const parent = new Agent({ provider, model: fakeModel, tools: [work], extensions: host });
    await host.register(subagentsExtension({ parent: () => parent }));

    const result = await parent.run("delegate");

    expect(provider.requests[1]?.tools?.map((candidate) => candidate.name)).toEqual(["work"]);
    const toolResult = result.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "task",
    );
    expect(toolResult?.role === "toolResult" && toolResult.usage?.inputTokens).toBe(40);
    expect(result.usage.inputTokens).toBe(60);
    const restored = new Agent({ provider: new FakeProvider([]), model: fakeModel });
    restored.resume(parent.session);
    expect(restored.usage.inputTokens).toBe(60);
  });

  test("a child permission ask is resolved by and visible through the parent", async () => {
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "task-1",
            name: "task",
            arguments: { description: "restricted work", prompt: "Use the guarded tool" },
          },
        ],
      },
      {
        content: [{ type: "toolCall", id: "guarded-1", name: "guarded", arguments: {} }],
      },
      { content: [{ type: "text", text: "Child finished." }] },
      { content: [{ type: "text", text: "Parent finished." }] },
    ]);
    let ran = false;
    const guarded = tool({
      name: "guarded",
      description: "guarded",
      inputSchema: z.object({}),
      execute: () => {
        ran = true;
        return "allowed";
      },
    });
    const asked: PermissionRequest[] = [];
    const host = new ExtensionHost();
    const parent = new Agent({
      provider,
      model: fakeModel,
      tools: [guarded],
      extensions: host,
      permissions: [
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "task", pattern: "*", action: "allow" },
      ],
      onPermission: async (request) => {
        asked.push(request);
        return "allow";
      },
    });
    await host.register(subagentsExtension({ parent: () => parent }));
    const events: string[] = [];
    const stream = parent.stream("delegate");
    for await (const event of stream) events.push(event.type);
    await stream.result();

    expect(ran).toBe(true);
    expect(asked.map((request) => request.toolName)).toEqual(["guarded"]);
    expect(events).toContain("permission_asked");
    expect(events).toContain("permission_resolved");
  });

  test("independent task calls start concurrently", async () => {
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "task-1",
            name: "task",
            arguments: { description: "first file", prompt: "Edit the first file" },
          },
          {
            type: "toolCall",
            id: "task-2",
            name: "task",
            arguments: { description: "second file", prompt: "Edit the second file" },
          },
        ],
      },
      { content: [{ type: "text", text: "First done." }], delayMs: 50 },
      { content: [{ type: "text", text: "Second done." }], delayMs: 50 },
      { content: [{ type: "text", text: "Integrated." }] },
    ]);
    const host = new ExtensionHost();
    const parent = new Agent({ provider, model: fakeModel, extensions: host });
    await host.register(subagentsExtension({ parent: () => parent }));

    const running = parent.run("delegate both");
    await Bun.sleep(10);

    expect(provider.callCount).toBe(3);
    expect((await running).reason).toBe("done");
  });

  test("stopping the parent stops an active managed child", async () => {
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "task-1",
            name: "task",
            arguments: { description: "slow work", prompt: "Take your time" },
          },
        ],
      },
      { content: [{ type: "text", text: "Too late." }], delayMs: 50 },
    ]);
    const host = new ExtensionHost();
    const parent = new Agent({ provider, model: fakeModel, extensions: host });
    await host.register(subagentsExtension({ parent: () => parent }));

    const running = parent.run("delegate");
    await Bun.sleep(10);
    parent.stop();
    const result = await running;

    expect(result.reason).toBe("aborted");
    expect(details(parent, "task").reason).toBe("aborted");
  });
});
