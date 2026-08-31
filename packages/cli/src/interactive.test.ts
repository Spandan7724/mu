import { describe, expect, test } from "bun:test";
import { CODING_PERMISSION_MODES } from "@mu/profile-coding";
import { App, RendererRegistry, stripAnsi, wrapText } from "@mu/tui";
import {
  Agent,
  defaultModelId,
  ExtensionHost,
  MemorySessionStore,
  type ModelInfo,
  userMessage,
} from "mu";
import {
  availableModels,
  formatAuthUrl,
  formatInstructionsOutput,
  formatPermissionMode,
  formatResumeHint,
  formatTerminalTitle,
  initializeInteractiveSession,
  modelPickerDescription,
  preferredProviderModel,
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

test("instructions output has one blank row above and below", () => {
  expect(formatInstructionsOutput("instructions · 1 file\n  project AGENTS.md")).toEqual([
    "",
    "  instructions · 1 file\n  project AGENTS.md",
    "",
  ]);
});

describe("permission mode notice", () => {
  const modeFor = (id: string) => {
    const mode = CODING_PERMISSION_MODES.find((candidate) => candidate.id === id);
    if (!mode) throw new Error(`no such mode: ${id}`);
    return mode;
  };

  const line = (mode: ReturnType<typeof modeFor>, depth: "truecolor" | "none") =>
    formatPermissionMode(mode, depth)[0] ?? "";

  test("each mode is coloured by how it moves the gate", () => {
    // Loosening reads green, opening fully reads red, restricting reads blue,
    // and the baseline keeps mu's own accent.
    expect(line(modeFor("accept-edits"), "truecolor")).toContain("74;222;128maccept edits");
    expect(line(modeFor("yolo"), "truecolor")).toContain("[1;31mfull access");
    expect(line(modeFor("plan-readonly"), "truecolor")).toContain("96;165;250mplan (read-only)");
    expect(line(modeFor("default"), "truecolor")).toContain("177;249;223mdefault");
  });

  test("the mode stays legible without colour", () => {
    // Bold carries the distinction when hue cannot, and NO_COLOR keeps the text.
    for (const mode of CODING_PERMISSION_MODES) {
      expect(line(mode, "truecolor")).toContain("[1;");
      expect(line(mode, "none")).toBe(`  permissions set to ${mode.label} · this session`);
    }
  });

  test("one blank line below keeps a run of mode changes apart", () => {
    // shift+tab commits one of these per press, so without the gap consecutive
    // notices stack into a solid block — and the composer sits flush under the
    // last one. Exactly one line, so cycling does not open a growing hole.
    for (const mode of CODING_PERMISSION_MODES) {
      expect(formatPermissionMode(mode, "none")).toHaveLength(2);
      expect(formatPermissionMode(mode, "none")[1]).toBe("");
    }
    const cycled = CODING_PERMISSION_MODES.flatMap((mode) =>
      formatPermissionMode(mode, "none"),
    ).join("\n");
    expect(cycled).not.toMatch(/this session\n {2}permissions/);
    expect(cycled).not.toContain("\n\n\n");
  });
});

describe("account login url", () => {
  const url = `https://auth.openai.com/oauth/authorize?response_type=code&${"s".repeat(200)}`;

  test("the whole url is one hyperlink, so wrapping keeps it clickable", () => {
    const [heading, link, hint] = formatAuthUrl(url, false, "OpenAI", "truecolor", "linux");

    expect(heading).toBe("  Could not open a browser. Open this URL to continue:");
    expect(link).toContain(`\u001b]8;;${url}\u0007`);
    expect(stripAnsi(link as string)).toBe(`  ${url}`);
    expect(wrapText(link as string, 60).every((row) => row.includes(`]8;;${url}`))).toBe(true);
    expect(stripAnsi(hint as string)).toBe("  ctrl+click to open");
    expect(hint).toContain(`\u001b]8;;${url}\u0007`);
  });

  test("the url is offered even when a browser opened, with a platform click hint", () => {
    const lines = formatAuthUrl(url, true, "OpenAI", "none", "darwin");

    expect(lines[0]).toBe("  Complete the OpenAI sign-in in your browser, or open this URL:");
    expect(stripAnsi(lines[2] as string)).toBe("  cmd+click to open");
  });
});

test("a new interactive session is not persisted before any message is sent", async () => {
  const store = new MemorySessionStore();
  const agent = new Agent({ session: store });

  expect(await initializeInteractiveSession(agent, undefined)).toBe(false);
  expect(await store.list()).toEqual([]);
});

test("a resumed session reports its restored context before any message is sent", async () => {
  const store = new MemorySessionStore();
  const source = new Agent({ session: store });
  source.session.appendMessage(userMessage("a".repeat(8000)));
  await store.save(source.sessionId, source.session);

  const agent = new Agent({ session: store });
  expect(await initializeInteractiveSession(agent, source.sessionId)).toBe(true);
  expect(agent.contextTokens).toBeGreaterThan(0);

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
  app.handleEvent({
    type: "usage_updated",
    sessionTotals: agent.usage,
    contextTokens: agent.contextTokens,
    contextPercent: agent.contextPercent,
  });

  const footer = app.renderBottom().map(stripAnsi).join(" ");
  expect(footer).toMatch(/[1-9]\d*\.\d%|0\.[1-9]%/);
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
    renderNow: (frame) =>
      calls.push([...frame.transcript, ...frame.managed].map(stripAnsi).join("\n")),
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
        turnCount: 1,
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
      "  │ undo · 1 prompt · 4 messages reverted · 1 file · /redo to restore",
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

    expect(modelPickerDescription({ ...model, provider: "github-copilot" }, "oauth")).toBe(
      "GPT-5.6 Sol · Copilot plan",
    );
    expect(modelPickerDescription({ ...model, provider: "kimi-coding" }, "oauth")).toBe(
      "GPT-5.6 Sol · Kimi Code plan",
    );
  });

  test("account login selects a provider-specific supported default", () => {
    const models = [
      {
        provider: "github-copilot",
        id: "gpt-5.6-sol",
      },
      {
        provider: "github-copilot",
        id: "gpt-5.3-codex",
      },
      {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
      },
    ].map(
      (model): ModelInfo => ({
        ...model,
        contextWindow: 400_000,
        maxOutput: 128_000,
        modalities: ["text"],
        pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    );

    expect(preferredProviderModel("github-copilot", models)?.id).toBe("gpt-5.3-codex");
    expect(preferredProviderModel("openai-codex", models)?.id).toBe("gpt-5.6-sol");
  });

  // Regression: these three had a default in the catalog's table but none in
  // the login table, so logging in saved whatever the refreshed models.dev
  // catalog happened to list first (openai got gpt-5.2-pro, google a
  // computer-use preview) instead of the configured default.
  test("login honours the configured default for every provider that has one", () => {
    const expected: Record<string, string> = {
      openai: "gpt-5.6-sol",
      anthropic: "claude-opus-5",
      google: "gemini-2.5-pro",
      "openai-codex": "gpt-5.6-sol",
      "github-copilot": "gpt-5.3-codex",
      "kimi-coding": "kimi-for-coding",
      xai: "grok-4.3",
    };
    // Each provider lists a decoy first, so returning catalog order fails.
    const models = Object.entries(expected).flatMap(([provider, id]) =>
      [`decoy-${provider}`, id].map(
        (modelId): ModelInfo => ({
          provider,
          id: modelId,
          contextWindow: 400_000,
          maxOutput: 128_000,
          modalities: ["text"],
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      ),
    );

    for (const [provider, id] of Object.entries(expected)) {
      expect(preferredProviderModel(provider, models)?.id).toBe(id);
      expect(defaultModelId(provider)).toBe(id);
    }
  });

  test("falls back to catalog order only for providers with no configured default", () => {
    const models: ModelInfo[] = [
      {
        provider: "groq",
        id: "first-listed",
        contextWindow: 128_000,
        maxOutput: 32_000,
        modalities: ["text"],
        pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    expect(defaultModelId("groq")).toBeUndefined();
    expect(preferredProviderModel("groq", models)?.id).toBe("first-listed");
  });
});
