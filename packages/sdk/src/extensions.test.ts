import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHost } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";
import { registryWithCoreCommands } from "./commands.ts";
import { loadExtensions } from "./extension-loader.ts";
import { type HookRunner, shellHooksExtension } from "./shell-hooks.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-ext-"));
}

describe("extension loader", () => {
  test("loads a user .ts file with no build step", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "demo.ts"),
      `export default {
        name: "demo",
        activate(api) {
          api.registerCommand({ name: "demo", description: "d", run: () => ({ handled: true }) });
        },
      };`,
    );
    const host = new ExtensionHost();
    const report = await loadExtensions(host, { paths: [dir], userDir: false });

    expect(report.failed).toEqual([]);
    expect(report.loaded.length).toBe(1);
    expect(host.commands.has("demo")).toBe(true);
  });

  test("a broken extension is reported without taking the others down", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a-good.ts"), `export default { name: "good", activate() {} };`);
    await writeFile(join(dir, "b-broken.ts"), `throw new Error("boom at import");`);
    await writeFile(join(dir, "c-shapeless.ts"), `export default { nope: true };`);

    const host = new ExtensionHost();
    const report = await loadExtensions(host, { paths: [dir], userDir: false });

    expect(report.loaded.length).toBe(1);
    expect(report.failed.length).toBe(2);
    expect(report.failed.some((f) => f.error.includes("boom at import"))).toBe(true);
    expect(report.failed.some((f) => f.error.includes("no default export"))).toBe(true);
  });

  test("missing paths are skipped silently", async () => {
    const host = new ExtensionHost();
    const report = await loadExtensions(host, {
      paths: [join(tmpdir(), "definitely-not-here-mu")],
      userDir: false,
    });
    expect(report).toEqual({ loaded: [], failed: [] });
  });
});

describe("extensions driving a real run", () => {
  test("one extension file blocks a call, rewrites a result and adds a tool", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "everything.ts"),
      `export default {
        name: "everything",
        activate(api) {
          api.registerTool({
            name: "provided",
            description: "registered by an extension",
            inputSchema: { type: "object" },
            execute: async () => ({ content: [{ type: "text", text: "from extension" }] }),
          });
          api.registerTool({
            name: "forbidden",
            description: "exists, but the hook always blocks it",
            inputSchema: { type: "object" },
            execute: async () => ({ content: [{ type: "text", text: "must never run" }] }),
          });
          api.onToolCall((info) =>
            info.toolName === "forbidden" ? { block: true, reason: "extension says no" } : undefined,
          );
          api.onToolResult((info) =>
            info.toolName === "provided"
              ? { content: [{ type: "text", text: "rewritten by extension" }] }
              : undefined,
          );
        },
      };`,
    );

    const host = new ExtensionHost();
    const report = await loadExtensions(host, { paths: [dir], userDir: false });
    expect(report.failed).toEqual([]);

    const provider = new FakeProvider([
      {
        content: [
          { type: "toolCall", id: "c1", name: "provided", arguments: {} },
          { type: "toolCall", id: "c2", name: "forbidden", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "finished" }] },
    ]);
    const agent = new Agent({ provider, model: fakeModel, extensions: host });
    const result = await agent.run("go");

    const results = result.messages.filter((m) => m.role === "toolResult");
    const texts = results.map((m) =>
      m.role === "toolResult" && m.content[0]?.type === "text" ? m.content[0].text : "",
    );
    expect(texts[0]).toBe("rewritten by extension");
    expect(texts[1]).toBe("extension says no");
    expect(results[1]?.role === "toolResult" && results[1].isError).toBe(true);
  });

  test("a context hook transforms messages before the LLM call", async () => {
    const host = new ExtensionHost();
    await host.register({
      name: "redact",
      activate(api) {
        api.onContext((messages) =>
          messages.map((m) =>
            m.role === "user"
              ? { ...m, content: [{ type: "text" as const, text: "[redacted]" }] }
              : m,
          ),
        );
      },
    });
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    await new Agent({ provider, model: fakeModel, extensions: host }).run("my secret");

    const sent = provider.requests[0]?.messages[0];
    expect(sent?.role === "user" && sent.content[0]?.type === "text" && sent.content[0].text).toBe(
      "[redacted]",
    );
  });

  test("extension-registered tools are callable by the model", async () => {
    const host = new ExtensionHost();
    await host.register({
      name: "adder",
      activate(api) {
        api.registerTool({
          name: "plus",
          description: "adds",
          inputSchema: { type: "object" },
          execute: async (_id, args) => ({
            content: [{ type: "text", text: String((args as { a: number }).a + 1) }],
          }),
        });
      },
    });
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "plus", arguments: { a: 41 } }] },
      { content: [{ type: "text", text: "42" }] },
    ]);
    const result = await new Agent({ provider, model: fakeModel, extensions: host }).run("add");
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(
      toolResult?.role === "toolResult" &&
        toolResult.content[0]?.type === "text" &&
        toolResult.content[0].text,
    ).toBe("42");
  });

  test("extensions observe the event stream", async () => {
    const host = new ExtensionHost();
    const seen: string[] = [];
    await host.register({
      name: "observer",
      activate(api) {
        api.on("agent_start", () => seen.push("start"));
        api.on("agent_end", () => seen.push("end"));
      },
    });
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]);
    await new Agent({ provider, model: fakeModel, extensions: host }).run("go");
    expect(seen).toEqual(["start", "end"]);
  });
});

describe("shell-hooks extension", () => {
  function fakeRunner(
    responses: Record<string, { exitCode: number; stdout?: string; stderr?: string }>,
  ): { runner: HookRunner; calls: { command: string; input: string }[] } {
    const calls: { command: string; input: string }[] = [];
    const runner: HookRunner = async (command, input) => {
      calls.push({ command, input });
      const response = responses[command] ?? { exitCode: 0 };
      return {
        exitCode: response.exitCode,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      };
    };
    return { runner, calls };
  }

  test("PreToolUse denies a tool call via exit code 2", async () => {
    const { runner, calls } = fakeRunner({
      "guard.sh": { exitCode: 2, stderr: "not on my watch" },
    });
    const host = new ExtensionHost();
    await host.register(
      shellHooksExtension([{ event: "PreToolUse", command: "guard.sh" }], runner),
    );

    const directive = await host.runToolCallHooks({
      toolName: "danger",
      toolCallId: "c1",
      args: { rm: true },
    });
    expect(directive?.block).toBe(true);
    expect(directive?.reason).toBe("not on my watch");

    // The hook receives the documented JSON payload on stdin.
    const payload = JSON.parse(calls[0]?.input ?? "{}");
    expect(payload.event).toBe("PreToolUse");
    expect(payload.tool_name).toBe("danger");
    expect(payload.tool_input).toEqual({ rm: true });
  });

  test("PreToolUse denial reason can come from stdout JSON", async () => {
    const { runner } = fakeRunner({
      "guard.sh": { exitCode: 2, stdout: '{"reason":"policy violation"}' },
    });
    const host = new ExtensionHost();
    await host.register(
      shellHooksExtension([{ event: "PreToolUse", command: "guard.sh" }], runner),
    );
    const directive = await host.runToolCallHooks({ toolName: "t", toolCallId: "c", args: {} });
    expect(directive?.reason).toBe("policy violation");
  });

  test("PreToolUse exit 0 with JSON rewrites the arguments", async () => {
    const { runner } = fakeRunner({
      "rewrite.sh": { exitCode: 0, stdout: '{"tool_input":{"safe":true}}' },
    });
    const host = new ExtensionHost();
    await host.register(
      shellHooksExtension([{ event: "PreToolUse", command: "rewrite.sh" }], runner),
    );
    const directive = await host.runToolCallHooks({
      toolName: "t",
      toolCallId: "c",
      args: { safe: false },
    });
    expect(directive?.args).toEqual({ safe: true });
  });

  test("matcher limits which tools a hook sees", async () => {
    const { runner, calls } = fakeRunner({ "guard.sh": { exitCode: 2 } });
    const host = new ExtensionHost();
    await host.register(
      shellHooksExtension([{ event: "PreToolUse", command: "guard.sh", matcher: "bash" }], runner),
    );
    const directive = await host.runToolCallHooks({ toolName: "read", toolCallId: "c", args: {} });
    expect(directive).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  test("PostToolUse can rewrite tool output", async () => {
    const { runner } = fakeRunner({
      "scrub.sh": { exitCode: 0, stdout: '{"tool_output":"scrubbed"}' },
    });
    const host = new ExtensionHost();
    await host.register(
      shellHooksExtension([{ event: "PostToolUse", command: "scrub.sh" }], runner),
    );
    const directive = await host.runToolResultHooks({
      toolName: "t",
      toolCallId: "c",
      result: { content: [{ type: "text", text: "secret token" }] },
      isError: false,
    });
    expect(directive?.content).toEqual([{ type: "text", text: "scrubbed" }]);
  });

  test("UserPromptSubmit can rewrite or consume the prompt", async () => {
    const rewrite = fakeRunner({ "pre.sh": { exitCode: 0, stdout: '{"prompt":"expanded"}' } });
    const host = new ExtensionHost();
    await host.register(
      shellHooksExtension([{ event: "UserPromptSubmit", command: "pre.sh" }], rewrite.runner),
    );
    expect(await host.runInputHooks("short")).toEqual({ text: "expanded" });

    const block = fakeRunner({ "veto.sh": { exitCode: 2 } });
    const host2 = new ExtensionHost();
    await host2.register(
      shellHooksExtension([{ event: "UserPromptSubmit", command: "veto.sh" }], block.runner),
    );
    expect((await host2.runInputHooks("nope"))?.consume).toBe(true);
  });

  test("a PreToolUse hook blocks a real agent run end to end", async () => {
    const { runner } = fakeRunner({ "deny.sh": { exitCode: 2, stderr: "denied by policy" } });
    const host = new ExtensionHost();
    await host.register(shellHooksExtension([{ event: "PreToolUse", command: "deny.sh" }], runner));
    await host.register({
      name: "tools",
      activate(api) {
        api.registerTool({
          name: "risky",
          description: "risky",
          inputSchema: { type: "object" },
          execute: async () => ({ content: [{ type: "text", text: "should not run" }] }),
        });
      },
    });

    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "risky", arguments: {} }] },
      { content: [{ type: "text", text: "understood" }] },
    ]);
    const result = await new Agent({ provider, model: fakeModel, extensions: host }).run("go");
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(
      toolResult?.role === "toolResult" &&
        toolResult.content[0]?.type === "text" &&
        toolResult.content[0].text,
    ).toBe("denied by policy");
  });
});

describe("core commands", () => {
  function ctx(overrides: Record<string, unknown> = {}) {
    const printed: string[] = [];
    let model = "fake/fake-1";
    const injected: unknown[] = [];
    return {
      printed,
      injected,
      getModelValue: () => model,
      ctx: {
        inject: (m: unknown) => injected.push(m),
        print: (t: string) => printed.push(t),
        getModel: () => model,
        setModel: (ref: string) => {
          model = ref;
        },
        ...overrides,
      },
    };
  }

  test("/model with no argument reports the current model", async () => {
    const registry = registryWithCoreCommands();
    const harness = ctx();
    await registry.execute("/model", harness.ctx);
    expect(harness.printed[0]).toContain("fake/fake-1");
  });

  test("/model switches to a known model", async () => {
    const registry = registryWithCoreCommands();
    const harness = ctx();
    const result = await registry.execute("/model anthropic/claude-opus-5", harness.ctx);
    expect(harness.getModelValue()).toBe("anthropic/claude-opus-5");
    expect(result.message).toContain("claude-opus-5");
  });

  test("/model rejects an unknown model and lists the known ones", async () => {
    const registry = registryWithCoreCommands();
    const harness = ctx();
    const result = await registry.execute("/model nope/nothing", harness.ctx);
    expect(result.message).toContain("Unknown model");
    expect(harness.getModelValue()).toBe("fake/fake-1");
  });

  test("/compact injects a summarization request", async () => {
    const registry = registryWithCoreCommands();
    const harness = ctx();
    await registry.execute("/compact", harness.ctx);
    expect(harness.injected.length).toBe(1);
  });

  test("/help lists registered commands", async () => {
    const registry = registryWithCoreCommands();
    const harness = ctx();
    await registry.execute("/help", harness.ctx);
    expect(harness.printed[0]).toContain("/model");
    expect(harness.printed[0]).toContain("/compact");
  });
});
