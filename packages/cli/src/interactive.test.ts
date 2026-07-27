import { describe, expect, test } from "bun:test";
import { RendererRegistry, stripAnsi } from "@mu/tui";
import { ExtensionHost, type ModelInfo } from "mu";
import {
  availableModels,
  formatResumeHint,
  registerDeclaredRenderers,
  renderCheckpointCommand,
  renderDiffCommand,
} from "./interactive.ts";

test("session close hint is a directly runnable resume command", () => {
  expect(formatResumeHint("019fa562-3975-71e6-b7a1-ed63c54f1fac", "none")).toBe(
    "  To resume this session: mu --resume 019fa562-3975-71e6-b7a1-ed63c54f1fac",
  );
  const colored = formatResumeHint("session-id", "truecolor");
  expect(colored).toContain("38;2;102;102;102mTo resume this session:");
  expect(colored).toContain("\u001b[0m mu --resume session-id");
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
});
