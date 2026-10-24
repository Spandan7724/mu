import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, ExtensionHost } from "mu";
import { loadUserConfig, readSubagentPins, saveSubagentPin } from "./config.ts";
import {
  pinnableModels,
  subagentRouteOverride,
  unavailableSubagentPins,
} from "./subagent-routes.ts";

async function scratch(auth: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "mu-subagent-pins-"));
  const configFile = join(root, "config.json");
  const authFile = join(root, "auth.json");
  await Bun.write(authFile, JSON.stringify({ version: 1, providers: auth }));
  return { profile: "coding", configFile, authFile, extensions: new ExtensionHost(), env: {} };
}
const parent = {} as Agent;
const codexLogin = {
  "openai-codex": {
    type: "oauth",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 60_000,
    accountId: "account",
  },
};

describe("subagent pins in user config", () => {
  test("pins are saved per role beside other settings and removed when cleared", async () => {
    const { configFile } = await scratch();
    await Bun.write(configFile, JSON.stringify({ model: "openai-codex/gpt-5.6-sol" }));

    await saveSubagentPin(
      "coding",
      "counsel",
      { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
      configFile,
    );
    await saveSubagentPin("coding", "search", { thinking: "medium" }, configFile);
    expect(readSubagentPins("coding", configFile)).toEqual({
      counsel: { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
      search: { thinking: "medium" },
    });

    await saveSubagentPin("coding", "counsel", undefined, configFile);
    expect(await loadUserConfig(configFile)).toEqual({
      model: "openai-codex/gpt-5.6-sol",
      subagents: { coding: { search: { thinking: "medium" } } },
    });

    await saveSubagentPin("coding", undefined, undefined, configFile);
    expect(await loadUserConfig(configFile)).toEqual({ model: "openai-codex/gpt-5.6-sol" });
  });

  test("an unknown role or field is reported, and routing then ignores the pins", async () => {
    const { configFile } = await scratch();
    await Bun.write(
      configFile,
      JSON.stringify({ subagents: { coding: { planner: { model: "x/y" } } } }),
    );
    const warnings: string[] = [];

    expect(await loadUserConfig(configFile, (message) => warnings.push(message))).toEqual({});
    expect(warnings[0]).toContain("subagents");
    expect(readSubagentPins("coding", configFile)).toEqual({});
  });
});

test("each profile keeps its own choices", async () => {
  const { configFile } = await scratch();
  await saveSubagentPin("coding", "task", { model: "openai-codex/gpt-5.6-terra" }, configFile);
  await saveSubagentPin("browser", "task", { thinking: "low" }, configFile);
  await saveSubagentPin("coding", undefined, undefined, configFile);

  expect(readSubagentPins("coding", configFile)).toEqual({});
  expect(readSubagentPins("browser", configFile)).toEqual({ task: { thinking: "low" } });
});

describe("subagent route override", () => {
  test("a pinned model you are logged into is used with its level", async () => {
    const sources = await scratch(codexLogin);
    await saveSubagentPin(
      "coding",
      "counsel",
      { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
      sources.configFile,
    );
    const override = await subagentRouteOverride(sources)("counsel", parent);

    expect(override?.model?.id).toBe("gpt-5.6-terra");
    expect(override?.thinkingLevel).toBe("high");
    expect(await subagentRouteOverride(sources)("search", parent)).toBeUndefined();
  });

  test("task can be pinned like the other roles, and another profile's pin is ignored", async () => {
    const sources = await scratch(codexLogin);
    await saveSubagentPin(
      "coding",
      "task",
      { model: "openai-codex/gpt-5.6-terra" },
      sources.configFile,
    );
    const browser = { ...sources, profile: "browser" };

    expect((await subagentRouteOverride(sources)("task", parent))?.model?.id).toBe("gpt-5.6-terra");
    expect(await subagentRouteOverride(browser)("task", parent)).toBeUndefined();
  });

  test("a level alone needs no model check", async () => {
    const sources = await scratch();
    await saveSubagentPin("coding", "recall", { thinking: "medium" }, sources.configFile);

    expect(await subagentRouteOverride(sources)("recall", parent)).toEqual({
      thinkingLevel: "medium",
    });
  });

  test("a model without credentials or out of the catalog drops the pin and warns", async () => {
    const sources = await scratch(codexLogin);
    await saveSubagentPin(
      "coding",
      "counsel",
      { model: "anthropic/claude-opus-5", thinking: "max" },
      sources.configFile,
    );
    await saveSubagentPin(
      "coding",
      "search",
      { model: "openai-codex/gpt-0-gone" },
      sources.configFile,
    );

    expect(await subagentRouteOverride(sources)("counsel", parent)).toEqual({
      unavailable: "anthropic/claude-opus-5",
    });
    expect(await unavailableSubagentPins(sources)).toEqual([
      "counsel is set to anthropic/claude-opus-5, which is not available; using its default",
      "search is set to openai-codex/gpt-0-gone, which is not available; using its default",
    ]);
  });

  test("an environment key makes a provider's models pinnable", async () => {
    const { extensions } = await scratch();
    const refs = (env: NodeJS.ProcessEnv) =>
      pinnableModels(extensions, { providers: {} }, env).map(
        (model) => `${model.provider}/${model.id}`,
      );

    expect(refs({})).not.toContain("anthropic/claude-opus-5");
    expect(refs({ ANTHROPIC_API_KEY: "key" })).toContain("anthropic/claude-opus-5");
  });
});
