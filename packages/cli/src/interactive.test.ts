import { describe, expect, test } from "bun:test";
import { App, RendererRegistry, stripAnsi } from "@mu/tui";
import { Agent, ExtensionHost, MemorySessionStore, type ModelInfo } from "mu";
import {
  availableModels,
  formatResumeHint,
  formatTerminalTitle,
  initializeInteractiveSession,
  modelPickerDescription,
  registerDeclaredRenderers,
  renderCheckpointCommand,
  renderDiffCommand,
  startNewInteractiveSession,
} from "./interactive.ts";

test("terminal title identifies mu and the working directory", () => {
  expect(formatTerminalTitle("/home/test/code/mu_testing")).toBe("mu - mu_testing");
  expect(formatTerminalTitle("/")).toBe("mu - /");
});

test("session close hint is a directly runnable resume command", () => {
  expect(formatResumeHint("019fa562-3975-71e6-b7a1-ed63c54f1fac", "none")).toBe(
    "  To resume this session: mu --resume 019fa562-3975-71e6-b7a1-ed63c54f1fac",
  );
  const colored = formatResumeHint("session-id", "truecolor");
  expect(colored).toContain("38;2;102;102;102mTo resume this session:");
  expect(colored).toContain("\u001b[0m mu --resume session-id");
});

test("a new interactive session is not persisted before any message is sent", async () => {
  const store = new MemorySessionStore();
  const agent = new Agent({ session: store });

  expect(await initializeInteractiveSession(agent, undefined)).toBe(false);
  expect(await store.list()).toEqual([]);
});

test("/new starts a fresh chat and clears the terminal", () => {
  const agent = new Agent();
  const oldSessionId = agent.sessionId;
  const app = new App({
    width: 80,
    height: 24,
    depth: "none",
    model: agent.modelRef,
    contextWindow: agent.contextWindow,
    callbacks: {
      onSubmit: () => {},
      onAbort: () => {},
      onExit: () => {},
    },
  });
  app.appendTranscript(["old chat"]);
  const calls: string[] = [];

  const sessionId = startNewInteractiveSession(agent, app, {
    clear: () => calls.push("clear"),
    renderNow: (lines) => calls.push(lines.map(stripAnsi).join("\n")),
  });

  expect(sessionId).not.toBe(oldSessionId);
  expect(agent.session.messagesAt()).toEqual([]);
  expect(calls[0]).toBe("clear");
  expect(calls[1]).toContain("a general-purpose, extensible agent");
  expect(calls[1]).not.toContain("old chat");
});

describe("interactive command rendering", () => {
  test("/diff uses the diff cell with actual hunks", () => {
    const lines = renderDiffCommand(
      {
        kind: "diff",
        files: [
          {
            path: "src/a.ts",
            added: 1,
            removed: 1,
            hunks: ["@@ -7 +7 @@", "-old", "+new"],
          },
        ],
      },
      60,
      "none",
    ).map(stripAnsi);

    expect(lines[0]).toBe("  │ src/a.ts · +1 −1");
    expect(lines[1]).toBe("  │     7 − old");
    expect(lines[2]).toBe("  │     7 + new");
  });

  test("/diff keeps multiple files as separate cells", () => {
    const lines = renderDiffCommand(
      {
        kind: "diff",
        files: [
          { path: "a.ts", added: 1, removed: 0, hunks: ["@@ -0,0 +1 @@", "+a"] },
          { path: "b.ts", added: 1, removed: 0, hunks: ["@@ -0,0 +1 @@", "+b"] },
        ],
      },
      60,
      "ansi16",
    ).map(stripAnsi);

    expect(lines).toContain("  │ a.ts · +1 −0");
    expect(lines).toContain("  │ b.ts · +1 −0");
    expect(lines).toContain("");
  });

  test("/undo shows one turn with its files and redo affordance", () => {
    const lines = renderCheckpointCommand(
      {
        kind: "checkpoint",
        action: "undo",
        messageCount: 4,
        prompt: "create fibonacci.py",
        files: [
          {
            path: "fibonacci.py",
            added: 17,
            removed: 0,
            hunks: [],
          },
        ],
      },
      80,
      "none",
    ).map(stripAnsi);

    expect(lines).toEqual([
      "  │ undo · 4 messages reverted · 1 file · /redo to restore",
      "  │ fibonacci.py +17",
      "  │ prompt restored to editor",
    ]);
  });
});

describe("declared tool renderers", () => {
  test("a profile or extension renderer overrides the generic cell", () => {
    const registry = new RendererRegistry();
    registerDeclaredRenderers(registry, [
      [
        "demo",
        {
          render: ({ args, result }) => [
            `custom:${String((args as { value?: unknown }).value)}:${result?.isError}`,
          ],
        },
      ],
    ]);

    expect(
      registry.render(
        {
          toolName: "demo",
          args: { value: 42 },
          result: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "demo",
            content: [{ type: "text", text: "nope" }],
            isError: true,
            timestamp: 1,
          },
        },
        { width: 80, depth: "none" },
      ),
    ).toEqual(["custom:42:true"]);
  });
});

describe("interactive model catalog", () => {
  test("extension models join the picker", async () => {
    const model: ModelInfo = {
      provider: "extension",
      id: "model-1",
      name: "Extension Model",
      contextWindow: 64_000,
      maxOutput: 8_000,
      modalities: ["text"],
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const host = new ExtensionHost();
    await host.register({
      name: "model",
      activate: (api) => api.registerModels([model]),
    });

    expect(availableModels(host)).toContain(model);
  });

  test("the picker only includes authenticated built-in providers", () => {
    const host = new ExtensionHost();
    const models = availableModels(host, new Set(["openai-codex"]));

    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((model) => model.provider))).toEqual(new Set(["openai-codex"]));
    expect(models.map((model) => model.id)).toContain("gpt-5.6-sol");
  });

  test("the picker combines every authenticated provider instead of only the active one", () => {
    const models = availableModels(new ExtensionHost(), new Set(["openai", "openai-codex"]));
    const providers = new Set(models.map((model) => model.provider));

    expect(providers).toEqual(new Set(["openai", "openai-codex"]));
    expect(models).toContainEqual(expect.objectContaining({ provider: "openai" }));
    expect(models).toContainEqual(expect.objectContaining({ provider: "openai-codex" }));
  });

  test("model descriptions distinguish plan, API-key, and extension routes", () => {
    const model: ModelInfo = {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      modalities: ["text"],
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    expect(modelPickerDescription(model, "oauth")).toBe("GPT-5.6 Sol · ChatGPT plan");
    expect(modelPickerDescription(model, "apiKey")).toBe("GPT-5.6 Sol · API key");
    expect(modelPickerDescription(model, "extension")).toBe("GPT-5.6 Sol · extension");
  });
});
