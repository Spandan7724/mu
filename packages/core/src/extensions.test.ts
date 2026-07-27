import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@mu/ai";
import { CommandRegistry } from "./commands.ts";
import { type Extension, ExtensionHost } from "./extensions.ts";
import { userMessage } from "./messages.ts";
import { textResult } from "./tools.ts";

describe("ExtensionHost registrations", () => {
  test("an extension registers a tool, a command and a renderer", async () => {
    const host = new ExtensionHost();
    const extension: Extension = {
      name: "demo",
      activate(api) {
        api.registerTool({
          name: "demo_tool",
          description: "demo",
          inputSchema: { type: "object" },
          execute: async () => textResult("ran"),
        });
        api.registerCommand({
          name: "demo",
          description: "demo command",
          run: () => ({ handled: true, message: "ok" }),
        });
        api.registerRenderer("demo_tool", { render: () => ["rendered"] });
        api.log("activated");
      },
    };
    await host.register(extension);

    expect(host.tools.has("demo_tool")).toBe(true);
    expect(host.commands.has("demo")).toBe(true);
    expect(host.renderers.has("demo_tool")).toBe(true);
    expect(host.logs[0]).toBe("[demo] activated");
  });

  test("an extension registers models without mutating the global catalog", async () => {
    const model: ModelInfo = {
      provider: "demo",
      id: "demo-1",
      contextWindow: 32_000,
      maxOutput: 4_000,
      modalities: ["text"],
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const host = new ExtensionHost();
    await host.register({
      name: "models",
      activate: (api) => api.registerModels([model]),
    });

    expect(host.findModel("demo/demo-1")).toBe(model);
    expect(host.findModel("demo-1")).toBe(model);
  });

  test("deactivate runs on shutdown", async () => {
    let torn = false;
    const host = new ExtensionHost();
    await host.register({
      name: "x",
      activate: () => {},
      deactivate: () => {
        torn = true;
      },
    });
    await host.shutdown();
    expect(torn).toBe(true);
  });

  test("event subscribers receive matching events only", async () => {
    const host = new ExtensionHost();
    const seen: string[] = [];
    await host.register({
      name: "watcher",
      activate(api) {
        api.on("agent_start", (event) => seen.push(event.type));
        api.on("turn_start", (event) => seen.push(event.type));
      },
    });
    host.emit({ type: "agent_start" });
    host.emit({ type: "turn_start" });
    host.emit({ type: "message_start", message: userMessage("x") });
    expect(seen).toEqual(["agent_start", "turn_start"]);
  });
});

describe("block/modify points", () => {
  test("tool_call hook can block", async () => {
    const host = new ExtensionHost();
    await host.register({
      name: "blocker",
      activate(api) {
        api.onToolCall((info) =>
          info.toolName === "danger" ? { block: true, reason: "nope" } : undefined,
        );
      },
    });
    const directive = await host.runToolCallHooks({
      toolName: "danger",
      toolCallId: "c1",
      args: {},
    });
    expect(directive?.block).toBe(true);
    expect(directive?.reason).toBe("nope");
  });

  test("tool_call hooks chain arg rewrites", async () => {
    const host = new ExtensionHost();
    await host.register({
      name: "a",
      activate(api) {
        api.onToolCall((info) => ({ args: { ...info.args, a: 1 } }));
      },
    });
    await host.register({
      name: "b",
      activate(api) {
        api.onToolCall((info) => ({ args: { ...info.args, b: 2 } }));
      },
    });
    const directive = await host.runToolCallHooks({
      toolName: "t",
      toolCallId: "c1",
      args: { base: true },
    });
    expect(directive?.args).toEqual({ base: true, a: 1, b: 2 });
  });

  test("the first blocking hook wins over later rewrites", async () => {
    const host = new ExtensionHost();
    let laterRan = false;
    await host.register({
      name: "blocker",
      activate(api) {
        api.onToolCall(() => ({ block: true, reason: "stop" }));
      },
    });
    await host.register({
      name: "later",
      activate(api) {
        api.onToolCall(() => {
          laterRan = true;
          return { args: { x: 1 } };
        });
      },
    });
    const directive = await host.runToolCallHooks({ toolName: "t", toolCallId: "c", args: {} });
    expect(directive?.block).toBe(true);
    expect(laterRan).toBe(false);
  });

  test("tool_result hook rewrites content and error flag", async () => {
    const host = new ExtensionHost();
    await host.register({
      name: "redactor",
      activate(api) {
        api.onToolResult(() => ({
          content: [{ type: "text", text: "[redacted]" }],
          isError: false,
        }));
      },
    });
    const directive = await host.runToolResultHooks({
      toolName: "t",
      toolCallId: "c",
      result: textResult("secret"),
      isError: true,
    });
    expect(directive?.content).toEqual([{ type: "text", text: "[redacted]" }]);
    expect(directive?.isError).toBe(false);
  });

  test("no rewrite means no directive at all", async () => {
    const host = new ExtensionHost();
    await host.register({
      name: "noop",
      activate(api) {
        api.onToolCall(() => undefined);
        api.onToolResult(() => undefined);
      },
    });
    expect(
      await host.runToolCallHooks({ toolName: "t", toolCallId: "c", args: {} }),
    ).toBeUndefined();
    expect(
      await host.runToolResultHooks({
        toolName: "t",
        toolCallId: "c",
        result: textResult("x"),
        isError: false,
      }),
    ).toBeUndefined();
  });

  test("context hooks transform the message list in order", async () => {
    const host = new ExtensionHost();
    await host.register({
      name: "trim",
      activate(api) {
        api.onContext((messages) => messages.slice(1));
      },
    });
    await host.register({
      name: "append",
      activate(api) {
        api.onContext((messages) => [...messages, userMessage("appended")]);
      },
    });
    const result = await host.runContextHooks([userMessage("a"), userMessage("b")]);
    const texts = result.map((m) =>
      m.role === "user" && m.content[0]?.type === "text" ? m.content[0].text : "",
    );
    expect(texts).toEqual(["b", "appended"]);
  });

  test("input hooks can rewrite or consume", async () => {
    const rewriting = new ExtensionHost();
    await rewriting.register({
      name: "upper",
      activate(api) {
        api.onInput((text) => ({ text: text.toUpperCase() }));
      },
    });
    expect(await rewriting.runInputHooks("hi")).toEqual({ text: "HI" });

    const consuming = new ExtensionHost();
    await consuming.register({
      name: "eat",
      activate(api) {
        api.onInput(() => ({ consume: true }));
      },
    });
    expect((await consuming.runInputHooks("hi"))?.consume).toBe(true);
  });

  test("a consuming hook stops later hooks running", async () => {
    const host = new ExtensionHost();
    let laterRan = false;
    await host.register({
      name: "eat",
      activate(api) {
        api.onInput(() => ({ consume: true }));
      },
    });
    await host.register({
      name: "later",
      activate(api) {
        api.onInput(() => {
          laterRan = true;
          return undefined;
        });
      },
    });
    await host.runInputHooks("hi");
    expect(laterRan).toBe(false);
  });
});

describe("CommandRegistry", () => {
  function ctx(print: (t: string) => void = () => {}) {
    return {
      inject: () => {},
      print,
      getModel: () => "fake/fake-1",
      setModel: () => {},
    };
  }

  test("parses /name and arguments", () => {
    const registry = new CommandRegistry();
    expect(registry.parse("/model anthropic/claude-opus-5")).toEqual({
      name: "model",
      args: "anthropic/claude-opus-5",
    });
    expect(registry.parse("/help")).toEqual({ name: "help", args: "" });
    expect(registry.parse("not a command")).toBeUndefined();
  });

  test("executes a registered command", async () => {
    const registry = new CommandRegistry();
    let received = "";
    registry.register({
      name: "echo",
      description: "echo",
      run: (c) => {
        received = c.args;
        return { handled: true, message: `said ${c.args}` };
      },
    });
    const result = await registry.execute("/echo hello world", ctx());
    expect(received).toBe("hello world");
    expect(result.message).toBe("said hello world");
  });

  test("unknown commands report rather than throw", async () => {
    const registry = new CommandRegistry();
    const result = await registry.execute("/nope", ctx());
    expect(result.handled).toBe(true);
    expect(result.message).toContain("Unknown command");
  });

  test("non-command input is not handled", async () => {
    const registry = new CommandRegistry();
    expect((await registry.execute("just text", ctx())).handled).toBe(false);
  });

  test("list is sorted by name", () => {
    const registry = new CommandRegistry();
    for (const name of ["zebra", "alpha", "mid"]) {
      registry.register({ name, description: name, run: () => {} });
    }
    expect(registry.list().map((c) => c.name)).toEqual(["alpha", "mid", "zebra"]);
  });
});
