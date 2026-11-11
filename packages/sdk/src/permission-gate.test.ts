import { describe, expect, test } from "bun:test";
import type { AgentEvent, AnyTool, PermissionRule } from "@mu/core";
import { createPermissionGate, type PermissionGateOptions } from "./permission-gate.ts";

const shell: AnyTool = {
  name: "shell",
  description: "shell",
  inputSchema: { type: "object" },
  permissionPattern: (args) => String((args as { command?: string }).command),
  execute: async () => ({ content: [] }),
};

function call(name: string, args: Record<string, unknown>) {
  return {
    assistantMessage: {
      role: "assistant" as const,
      content: [],
      model: "fake/fake-1",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "toolUse" as const,
      timestamp: 1,
    },
    toolCall: { type: "toolCall" as const, id: "c1", name, arguments: args },
    args,
    context: { messages: [] },
  };
}

function gate(rules: PermissionRule[], extra: Partial<PermissionGateOptions> = {}) {
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const run = createPermissionGate({
    tools: [shell],
    rules: () => rules,
    signal: controller.signal,
    emit: (event) => void events.push(event),
    ...extra,
  });
  return { run, events, controller };
}

describe("permission gate", () => {
  test("rules are matched against the tool's own pattern and read on every call", async () => {
    const rules: PermissionRule[] = [
      { permission: "shell", pattern: "*", action: "deny" },
      { permission: "shell", pattern: "ls *", action: "allow" },
    ];
    const { run, events } = gate(rules);
    expect(await run(call("shell", { command: "ls -la" }))).toBeUndefined();
    expect(await run(call("shell", { command: "rm -rf x" }))).toMatchObject({
      block: true,
      denied: true,
    });
    rules.push({ permission: "shell", pattern: "*", action: "allow" });
    expect(await run(call("shell", { command: "rm -rf x" }))).toBeUndefined();
    expect(events).toEqual([]);
  });

  test("an ask without anyone to answer is a denial", async () => {
    const { run, events } = gate([{ permission: "*", pattern: "*", action: "ask" }]);
    expect(await run(call("shell", { command: "make" }))).toMatchObject({ denied: true });
    expect(events.map((event) => event.type)).toEqual(["permission_asked", "permission_resolved"]);
  });

  test("the user's answer decides an ask, and a refusal carries their words", async () => {
    const rules: PermissionRule[] = [{ permission: "*", pattern: "*", action: "ask" }];
    const allowed = gate(rules, { onPermission: async () => "allow" as const });
    expect(await allowed.run(call("shell", { command: "make" }))).toBeUndefined();
    const refused = gate(rules, {
      onPermission: async () => ({ outcome: "deny", message: "use bun" }),
    });
    const directive = await refused.run(call("shell", { command: "make" }));
    expect(directive?.reason).toContain("The user said: use bun");
  });

  test("an abort releases an ask nobody answers", async () => {
    const { run, controller } = gate([{ permission: "*", pattern: "*", action: "ask" }], {
      onPermission: () => new Promise(() => {}),
    });
    const pending = run(call("shell", { command: "make" }));
    controller.abort();
    expect(await pending).toMatchObject({ block: true, denied: true });
  });

  test("exempt tools skip the gate and nothing is judged before it is ready", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { run } = gate([{ permission: "*", pattern: "*", action: "deny" }], {
      exempt: ["internal"],
      ready,
    });
    expect(await run(call("internal", {}))).toBeUndefined();
    let settled = false;
    const pending = run(call("shell", { command: "ls" })).then((directive) => {
      settled = true;
      return directive;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    release();
    expect(await pending).toMatchObject({ denied: true });
  });
});
