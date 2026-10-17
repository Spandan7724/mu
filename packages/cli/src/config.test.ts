import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelInfo, saveApiKey, type ThinkingLevel } from "mu";
import {
  applySavedThinking,
  loadUserConfig,
  resolveCliModel,
  saveDefaultModel,
  savePermissionMode,
  saveThinkingLevel,
  userConfigPath,
} from "./config.ts";

describe("user model configuration", () => {
  test("the user config lives under ~/.mu", () => {
    expect(userConfigPath("/users/test")).toBe(join("/users/test", ".mu", "config.json"));
  });

  test("saving a model preserves unrelated user settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-user-config-"));
    const file = join(root, "config.json");
    await Bun.write(
      file,
      JSON.stringify({
        mcpServers: { docs: { command: "docs-server" } },
        theme: "quiet",
      }),
    );

    await saveDefaultModel("openai/gpt-5.1", file);

    expect(await loadUserConfig(file)).toEqual({
      mcpServers: { docs: { command: "docs-server" } },
      theme: "quiet",
      model: "openai/gpt-5.1",
    });
  });

  test("the saved model becomes the default but an explicit flag wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-model-default-"));
    const file = join(root, "config.json");
    const authFile = join(root, "auth.json");
    await saveApiKey("openai", "sk-test", { authFile });
    await saveDefaultModel("openai/gpt-5.1", file);

    expect(await resolveCliModel(undefined, file, authFile, {})).toBe("openai/gpt-5.1");
    expect(await resolveCliModel("anthropic/claude-opus-5", file, authFile, {})).toBe(
      "anthropic/claude-opus-5",
    );
  });

  test("a provider login defaults OpenAI API and ChatGPT-plan routes to GPT-5.6 Sol", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-openai-default-"));
    const file = join(root, "config.json");
    const apiAuthFile = join(root, "api-auth.json");
    await saveApiKey("openai", "sk-test", { authFile: apiAuthFile });
    expect(await resolveCliModel(undefined, file, apiAuthFile, {})).toBe("openai/gpt-5.6-sol");

    const planAuthFile = join(root, "plan-auth.json");
    await writeFile(
      planAuthFile,
      JSON.stringify({
        version: 1,
        activeProvider: "openai-codex",
        providers: {
          "openai-codex": {
            type: "oauth",
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: Date.now() + 60_000,
            accountId: "account",
          },
        },
      }),
    );
    await writeFile(file, JSON.stringify({ model: "openai/gpt-5.1" }));
    expect(await resolveCliModel(undefined, file, planAuthFile, {})).toBe(
      "openai-codex/gpt-5.6-sol",
    );
  });

  test("an unavailable saved model falls back to the catalog default", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-stale-model-"));
    const file = join(root, "config.json");
    const authFile = join(root, "auth.json");
    await writeFile(file, JSON.stringify({ model: "gone/no-longer-listed" }));

    expect(await resolveCliModel(undefined, file, authFile, {})).not.toBe("gone/no-longer-listed");
  });

  // A catalog refresh replaces a provider's whole model list, so a saved
  // choice can vanish. Falling back is right; doing it silently left the
  // config claiming one model while mu ran another on every launch.
  test("warns when the saved model is gone from the catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-stale-warn-"));
    const file = join(root, "config.json");
    const authFile = join(root, "auth.json");
    await writeFile(file, JSON.stringify({ model: "gone/no-longer-listed" }));
    const warnings: string[] = [];

    const resolved = await resolveCliModel(undefined, file, authFile, {}, (message) =>
      warnings.push(message),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("gone/no-longer-listed");
    expect(warnings[0]).toContain("no longer in the model catalog");
    expect(warnings[0]).toContain(resolved);
  });

  test("warns when the saved model needs credentials the user lacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-uncredentialed-"));
    const file = join(root, "config.json");
    const authFile = join(root, "auth.json");
    await writeFile(file, JSON.stringify({ model: "anthropic/claude-opus-5" }));
    await saveApiKey("openai", "sk-test", { authFile });
    const warnings: string[] = [];

    const resolved = await resolveCliModel(undefined, file, authFile, {}, (message) =>
      warnings.push(message),
    );

    expect(resolved).not.toBe("anthropic/claude-opus-5");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("needs credentials");
  });

  test("stays quiet when the saved model resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-quiet-"));
    const file = join(root, "config.json");
    const authFile = join(root, "auth.json");
    await writeFile(file, JSON.stringify({ model: "openai/gpt-5.6-sol" }));
    await saveApiKey("openai", "sk-test", { authFile });
    const warnings: string[] = [];

    expect(await resolveCliModel(undefined, file, authFile, {}, (m) => warnings.push(m))).toBe(
      "openai/gpt-5.6-sol",
    );
    expect(warnings).toEqual([]);
  });

  test("a non-string model value is ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-invalid-model-"));
    const file = join(root, "config.json");
    const authFile = join(root, "auth.json");
    await writeFile(file, JSON.stringify({ model: 42 }));

    const warnings: string[] = [];
    expect(
      await resolveCliModel(undefined, file, authFile, {}, (message) => warnings.push(message)),
    ).not.toBe("42");
    expect(warnings[0]).toContain("model");
  });

  test("a malformed config is ignored when reading but not overwritten when saving", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-bad-config-"));
    const file = join(root, "config.json");
    await writeFile(file, "{ broken");

    const warnings: string[] = [];
    expect(await loadUserConfig(file, (message) => warnings.push(message))).toEqual({});
    expect(warnings).toHaveLength(1);
    await expect(saveDefaultModel("openai/gpt-5.1", file)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("{ broken");
  });
});

describe("saved thinking levels", () => {
  const model = (id: string, levels: string[], fallback: string): ModelInfo => ({
    provider: "openai-codex",
    id,
    contextWindow: 272_000,
    maxOutput: 128_000,
    modalities: ["text"],
    thinking: true,
    thinkingLevels: levels,
    defaultThinkingLevel: fallback,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const agentFor = (modelInfo: ModelInfo) => {
    const agent = {
      modelInfo,
      thinking: "" as ThinkingLevel,
      setThinking(level: ThinkingLevel) {
        agent.thinking = level;
      },
    };
    return agent;
  };

  test("each model keeps its own level alongside the saved model", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-thinking-"));
    const file = join(root, "config.json");
    await saveDefaultModel("openai-codex/gpt-6-luna", file);
    await saveThinkingLevel("openai-codex/gpt-6-luna", "high", file);
    await saveThinkingLevel("openai-codex/gpt-6.1-sol", "low", file);
    await saveThinkingLevel("openai-codex/gpt-6-luna", "max", file);

    expect(await loadUserConfig(file)).toEqual({
      model: "openai-codex/gpt-6-luna",
      thinking: { "openai-codex/gpt-6-luna": "max", "openai-codex/gpt-6.1-sol": "low" },
    });
  });

  test("the permission mode is saved per profile beside the model and thinking levels", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-permission-mode-"));
    const file = join(root, "config.json");
    await saveDefaultModel("openai-codex/gpt-6-luna", file);
    await savePermissionMode("coding", "accept-edits", file);
    await savePermissionMode("browser", "supervised", file);
    await savePermissionMode("coding", "plan-readonly", file);

    expect(await loadUserConfig(file)).toEqual({
      model: "openai-codex/gpt-6-luna",
      permissionMode: { coding: "plan-readonly", browser: "supervised" },
    });
  });

  test("switching models restores the saved level, or the model's own default", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-thinking-apply-"));
    const file = join(root, "config.json");
    await saveThinkingLevel("openai-codex/gpt-6-luna", "high", file);
    await saveThinkingLevel("openai-codex/gpt-6-astra", "ultra", file);

    const luna = agentFor(model("gpt-6-luna", ["low", "medium", "high", "max"], "medium"));
    applySavedThinking(luna, file);
    expect(luna.thinking).toBe("high");

    const sol = agentFor(model("gpt-6.1-sol", ["low", "medium", "high", "ultra"], "low"));
    applySavedThinking(sol, file);
    expect(sol.thinking).toBe("low");

    const astra = agentFor(model("gpt-6-astra", ["low", "medium", "high"], "medium"));
    applySavedThinking(astra, file);
    expect(astra.thinking).toBe("medium");
  });
});
