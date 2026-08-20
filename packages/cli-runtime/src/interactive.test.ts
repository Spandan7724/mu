import { describe, expect, test } from "bun:test";
import { App, RendererRegistry, stripAnsi, wrapText } from "@mu/tui";
import {
  Agent,
  defaultModelId,
  ExtensionHost,
  MemorySessionStore,
  type ModelInfo,
  type PermissionMode,
  userMessage,
} from "mu";
import {
  formatAuthUrl,
  formatPermissionMode,
  formatResumeHint,
  initializeInteractiveSession,
  registerDeclaredRenderers,
  registerProductRenderers,
  renderCheckpointCommand,
  renderDiffCommand,
  startNewInteractiveSession,
} from "./interactive.ts";
import {
  availableModels,
  modelPickerDescription,
  preferredProviderModel,
} from "./model-picker.ts";

test("the session close hint names the product's own command", () => {
  expect(formatResumeHint("019fa562-3975-71e6-b7a1-ed63c54f1fac", "none", "mu")).toBe(
    "  To resume this session: mu --resume 019fa562-3975-71e6-b7a1-ed63c54f1fac",
  );
  expect(formatResumeHint("session-id", "none", "echo-agent")).toBe(
    "  To resume this session: echo-agent --resume session-id",
  );
  const colored = formatResumeHint("session-id", "truecolor", "mu");
  expect(colored).toContain("38;2;102;102;102mTo resume this session:");
  expect(colored).toContain("[0m mu --resume session-id");
});

describe("permission mode notice", () => {
  // Modes are profile data, so the notice is exercised with plain values
  // rather than by importing a profile package.
  const mode = (id: string, label: string, tone?: PermissionMode["tone"]): PermissionMode => ({
    id,
    label,
    description: "",
    ...(tone ? { tone } : {}),
    rules: [],
  });
  const modes = [
    mode("default", "default"),
    mode("accept-edits", "accept edits", "permissive"),
    mode("plan-readonly", "plan (read-only)", "restrictive"),
    mode("yolo", "full access", "unrestricted"),
  ];

  test("each mode is coloured by how it moves the gate", () => {
    // Loosening reads green, opening fully reads red, restricting reads blue,
    // and the baseline keeps mu's own accent.
    expect(formatPermissionMode(modes[1] as PermissionMode, "truecolor")).toContain(
      "74;222;128maccept edits",
    );
    expect(formatPermissionMode(modes[3] as PermissionMode, "truecolor")).toContain(
      "[1;31mfull access",
    );
    expect(formatPermissionMode(modes[2] as PermissionMode, "truecolor")).toContain(
      "96;165;250mplan (read-only)",
    );
    expect(formatPermissionMode(modes[0] as PermissionMode, "truecolor")).toContain(
      "177;249;223mdefault",
    );
  });

  test("the mode stays legible without colour", () => {
    // Bold carries the distinction when hue cannot, and NO_COLOR keeps the text.
    for (const candidate of modes) {
      expect(formatPermissionMode(candidate, "truecolor")).toContain("[1;");
      expect(formatPermissionMode(candidate, "none")).toBe(
        `  permissions set to ${candidate.label} · this session`,
      );
    }
  });
});

describe("account login url", () => {
  const url = `https://auth.openai.com/oauth/authorize?response_type=code&${"s".repeat(200)}`;

  test("the whole url is one hyperlink, so wrapping keeps it clickable", () => {
    const [heading, link, hint] = formatAuthUrl(url, false, "OpenAI", "truecolor", "linux");

    expect(heading).toBe("  Could not open a browser. Open this URL to continue:");
    expect(link).toContain(`]8;;${url}`);
    expect(stripAnsi(link as string)).toBe(`  ${url}`);
    expect(wrapText(link as string, 60).every((row) => row.includes(`]8;;${url}`))).toBe(true);
    expect(stripAnsi(hint as string)).toBe("  ctrl+click to open");
    expect(hint).toContain(`]8;;${url}`);
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
    renderNow: (lines: string[]) => calls.push(lines.map(stripAnsi).join("\n")),
  });

  expect(sessionId).not.toBe(oldSessionId);
  expect(agent.session.messagesAt()).toEqual([]);
  expect(calls[0]).toBe("clear");
  expect(calls[1]).toContain("a general-purpose, extensible agent");
  expect(calls[1]).not.toContain("old chat");
});

test("the banner tagline is supplied by the surface", () => {
  const app = new App({
    width: 80,
    depth: "none",
    model: "fake/fake-1",
    tagline: "a product with no domain at all",
    callbacks: { onSubmit: () => {}, onAbort: () => {}, onExit: () => {} },
  });
  expect(app.banner().join("\n")).toContain("a product with no domain at all");
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

  test("product renderers accept either the line API or the profile shape", () => {
    const registry = new RendererRegistry();
    registerProductRenderers(registry, {
      direct: () => ["direct"],
      declared: { render: () => ["declared"] },
    });

    expect(registry.render({ toolName: "direct", args: {} }, { width: 80, depth: "none" })).toEqual([
      "direct",
    ]);
    expect(
      registry.render({ toolName: "declared", args: {} }, { width: 80, depth: "none" }),
    ).toEqual(["declared"]);
  });

  test("a runtime with no product renderers falls back to the generic cell", () => {
    const registry = new RendererRegistry();
    registerProductRenderers(registry, undefined);
    const info = {
      toolName: "read",
      args: { path: "a.ts" },
      result: {
        role: "toolResult" as const,
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text" as const, text: "x" }],
        details: { lines: 3 },
        isError: false,
        timestamp: 1,
      },
    };
    // The coding product's `read` cell summarises "3 lines"; the generic
    // fallback knows nothing about that detail shape.
    expect(registry.render(info, { width: 80, depth: "none" }).join("\n")).not.toContain("3 lines");
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
