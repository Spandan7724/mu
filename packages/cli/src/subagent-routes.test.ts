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
  return { configFile, authFile, extensions: new ExtensionHost(), env: {} };
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
      "counsel",
      { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
      configFile,
    );
    await saveSubagentPin("search", { thinking: "medium" }, configFile);
    expect(readSubagentPins(configFile)).toEqual({
      counsel: { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
      search: { thinking: "medium" },
    });

    await saveSubagentPin("counsel", undefined, configFile);
    expect(await loadUserConfig(configFile)).toEqual({
      model: "openai-codex/gpt-5.6-sol",
      subagents: { search: { thinking: "medium" } },
    });

    await saveSubagentPin(undefined, undefined, configFile);
    expect(await loadUserConfig(configFile)).toEqual({ model: "openai-codex/gpt-5.6-sol" });
  });

  test("an unknown role or field is reported, and routing then ignores the pins", async () => {
    const { configFile } = await scratch();
    await Bun.write(configFile, JSON.stringify({ subagents: { task: { model: "x/y" } } }));
    const warnings: string[] = [];

    expect(await loadUserConfig(configFile, (message) => warnings.push(message))).toEqual({});
    expect(warnings[0]).toContain("subagents");
    expect(readSubagentPins(configFile)).toEqual({});
  });
});

describe("subagent route override", () => {
  test("a pinned model you are logged into is used with its level", async () => {
    const sources = await scratch(codexLogin);
    await saveSubagentPin(
      "counsel",
      { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
      sources.configFile,
    );
    const override = await subagentRouteOverride(sources)("counsel", parent);

    expect(override?.model?.id).toBe("gpt-5.6-terra");
    expect(override?.thinkingLevel).toBe("high");
    expect(await subagentRouteOverride(sources)("search", parent)).toBeUndefined();
  });

  test("a level alone needs no model check", async () => {
    const sources = await scratch();
    await saveSubagentPin("recall", { thinking: "medium" }, sources.configFile);

    expect(await subagentRouteOverride(sources)("recall", parent)).toEqual({
      thinkingLevel: "medium",
    });
  });

  test("a model without credentials or out of the catalog drops the pin and warns", async () => {
    const sources = await scratch(codexLogin);
    await saveSubagentPin(
      "counsel",
      { model: "anthropic/claude-opus-5", thinking: "max" },
      sources.configFile,
    );
    await saveSubagentPin("search", { model: "openai-codex/gpt-0-gone" }, sources.configFile);

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
