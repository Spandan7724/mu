import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../types.ts";
import { discoverGitHubCopilotModels } from "./github-copilot.ts";

const models: ModelInfo[] = ["gpt-5.3-codex", "gpt-5.6-sol"].map((id) => ({
  provider: "github-copilot",
  id,
  contextWindow: 400_000,
  maxOutput: 128_000,
  modalities: ["text"],
  pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

describe("discoverGitHubCopilotModels", () => {
  test("filters the public catalog to the signed-in account model list", async () => {
    const discovered = await discoverGitHubCopilotModels({
      currentModels: models,
      getCredentials: async () => ({
        type: "oauth",
        accessToken: "copilot-token",
        availableModelIds: ["gpt-5.3-codex"],
      }),
    });

    expect(discovered?.map((model) => model.id)).toEqual(["gpt-5.3-codex"]);
  });

  test("skips account filtering when availability has not been discovered", async () => {
    expect(
      await discoverGitHubCopilotModels({
        currentModels: models,
        getCredentials: async () => ({ type: "oauth", accessToken: "copilot-token" }),
      }),
    ).toBeUndefined();
  });
});
