import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@mu/ai";
import { ExtensionHost, type PermissionRequest } from "@mu/core";
import { FakeProvider, fakeModel, type ScriptedTurn } from "@mu/core/testing/fake-provider.ts";
import { z } from "zod";
import { Agent } from "./agent.ts";
import {
  type SubagentDetails,
  type SubagentExtensionOptions,
  subagentsExtension,
} from "./subagents.ts";
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
    expect(provider.requests[1]?.systemPrompt?.map((section) => section.text).join("\n")).toContain(
      "Resolve one directed engineering question end to end",
    );
    expect(provider.requests[1]?.systemPrompt?.map((section) => section.text).join("\n")).toContain(
      "Instructions to edit or implement, update todo/plan state, run builds, tests",
    );
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

    expect(provider.requests[1]?.systemPrompt?.map((section) => section.text).join("\n")).toContain(
      "Treat the parent's diagnosis or preferred solution as a hypothesis",
    );
    expect(provider.requests[1]?.systemPrompt?.map((section) => section.text).join("\n")).toContain(
      "Be decisive at the confidence the evidence supports",
    );
    expect(details(parent, "counsel")).toMatchObject({
      kind: "counsel",
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "high",
    });
  });

  test("search uses configured fast models and otherwise retains the parent model", async () => {
    const cases: { parentModel: ModelInfo; expectedModel: string; expectedThinking: string }[] = [
      {
        parentModel: { ...fakeModel, provider: "openai", id: "gpt-5.6-sol" },
        expectedModel: "openai/gpt-5.6-terra",
        expectedThinking: "low",
      },
      {
        parentModel: { ...fakeModel, provider: "anthropic", id: "claude-opus-5" },
        expectedModel: "anthropic/claude-sonnet-5",
        expectedThinking: "low",
      },
      {
        parentModel: { ...fakeModel, provider: "google", id: "gemini-2.5-pro" },
        expectedModel: "google/gemini-2.5-pro",
        expectedThinking: "low",
      },
      {
        parentModel: {
          ...fakeModel,
          provider: "custom",
          id: "reasoner",
          thinkingLevels: ["high", "xhigh"],
          defaultThinkingLevel: "high",
        },
        expectedModel: "custom/reasoner",
        expectedThinking: "high",
      },
    ];

    for (const { parentModel, expectedModel, expectedThinking } of cases) {
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
        subagentsExtension({
          parent: () => parent,
          coding: { inspectionTools: [] },
          inspectionPermissions: [],
        }),
      );

      await parent.run("search");

      expect(details(parent, "search").model).toBe(expectedModel);
      expect(details(parent, "search").thinkingLevel).toBe(expectedThinking);
    }
  });

  test("counsel retains a Google parent model and caps reasoning at xhigh", async () => {
    const model: ModelInfo = {
      ...fakeModel,
      provider: "google",
      id: "gemini-2.5-pro",
      thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
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
      thinkingLevel: "max",
      extensions: host,
    });
    await host.register(
      subagentsExtension({
        parent: () => parent,
        coding: { inspectionTools: [] },
        inspectionPermissions: [],
      }),
    );

    await parent.run("consult");

    expect(details(parent, "counsel")).toMatchObject({
      model: "google/gemini-2.5-pro",
      thinkingLevel: "xhigh",
    });
  });

  test("task uses the parent model, cannot delegate, and persists its usage", async () => {
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
    expect(provider.requests[1]?.systemPrompt?.map((section) => section.text).join("\n")).toContain(
      "Own that unit from investigation through completion",
    );
    expect(provider.requests[1]?.systemPrompt?.map((section) => section.text).join("\n")).toContain(
      "Do not modify shared plan/todo state",
    );
    const toolResult = result.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "task",
    );
    expect(toolResult?.role === "toolResult" && toolResult.usage?.inputTokens).toBe(40);
    expect(result.usage.inputTokens).toBe(60);
    const restored = new Agent({ provider: new FakeProvider([]), model: fakeModel });
    restored.resume(parent.session);
    expect(restored.usage.inputTokens).toBe(60);
  });

  test("task children have no managed turn limit", async () => {
    const childTurns: ScriptedTurn[] = Array.from({ length: 13 }, (_, index) => ({
      content: [
        {
          type: "toolCall",
          id: `work-${index}`,
          name: "work",
          arguments: { index },
        },
      ],
    }));
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "task-1",
            name: "task",
            arguments: { description: "extended work", prompt: "Complete every step" },
          },
        ],
      },
      ...childTurns,
      { content: [{ type: "text", text: "All steps completed." }] },
      { content: [{ type: "text", text: "Integrated." }] },
    ]);
    const work = tool({
      name: "work",
      description: "work",
      inputSchema: z.object({ index: z.number() }),
      execute: ({ index }) => `completed ${index}`,
    });
    const host = new ExtensionHost();
    const parent = new Agent({ provider, model: fakeModel, tools: [work], extensions: host });
    await host.register(subagentsExtension({ parent: () => parent }));

    await parent.run("delegate extended work");

    expect(details(parent, "task").reason).toBe("done");
    expect(provider.callCount).toBe(16);
  });

  test("coding specialists require an explicit inspection permission boundary", () => {
    const parent = new Agent({ provider: new FakeProvider([]), model: fakeModel });
    const incomplete = {
      parent: () => parent,
      coding: { inspectionTools: [] },
    } as unknown as SubagentExtensionOptions;

    expect(() => subagentsExtension(incomplete)).toThrow(
      "coding subagents require explicit inspection permissions",
    );
  });

  test("specialists cannot escalate a mutating shell call through the parent", async () => {
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "search-1",
            name: "search",
            arguments: { query: "Inspect the workspace" },
          },
        ],
      },
      {
        content: [
          {
            type: "toolCall",
            id: "bash-1",
            name: "bash",
            arguments: { command: "touch changed" },
          },
        ],
      },
      { content: [{ type: "text", text: "The command was denied." }] },
      { content: [{ type: "text", text: "Search finished." }] },
    ]);
    let ran = false;
    let asked = false;
    const bash = tool({
      name: "bash",
      description: "shell",
      inputSchema: z.object({ command: z.string() }),
      permissionScope: ({ command }) => (command.startsWith("rg ") ? "bash:inspect" : "bash"),
      execute: () => {
        ran = true;
        return "ran";
      },
    });
    const host = new ExtensionHost();
    const parent = new Agent({
      provider,
      model: codexTerra,
      tools: [bash],
      extensions: host,
      onPermission: async () => {
        asked = true;
        return "allow";
      },
    });
    await host.register(
      subagentsExtension({
        parent: () => parent,
        coding: { inspectionTools: ["bash"] },
        inspectionPermissions: [{ permission: "*", pattern: "*", action: "allow" }],
      }),
    );

    await parent.run("search safely");

    expect(ran).toBe(false);
    expect(asked).toBe(false);
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

  test("all independent task calls start without a manager concurrency cap", async () => {
    const calls = Array.from({ length: 5 }, (_, index) => ({
      type: "toolCall" as const,
      id: `task-${index}`,
      name: "task",
      arguments: { description: `file ${index}`, prompt: `Edit file ${index}` },
    }));
    const childTurns: ScriptedTurn[] = Array.from({ length: 5 }, (_, index) => ({
      content: [{ type: "text", text: `File ${index} done.` }],
      delayMs: 50,
    }));
    const provider = new FakeProvider([
      { content: calls },
      ...childTurns,
      { content: [{ type: "text", text: "Integrated." }] },
    ]);
    const host = new ExtensionHost();
    const parent = new Agent({ provider, model: fakeModel, extensions: host });
    await host.register(subagentsExtension({ parent: () => parent }));

    const running = parent.run("delegate both");
    await Bun.sleep(10);

    expect(provider.callCount).toBe(6);
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
