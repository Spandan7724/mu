import { describe, expect, test } from "bun:test";
import { ExtensionHost, type ModelInfo } from "mu";
import { modelPickerItems } from "./model-picker.ts";

describe("modelPickerItems", () => {
  test("shows only authenticated built-in providers with their credential route", () => {
    const items = modelPickerItems(new ExtensionHost(), {
      "openai-codex": { type: "oauth" },
    });

    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((item) => item.label.split("/")[0]))).toEqual(
      new Set(["openai-codex"]),
    );
    expect(items.every((item) => item.description?.endsWith("ChatGPT plan"))).toBe(true);
  });

  test("keeps extension-owned models selectable without saved credentials", async () => {
    const model: ModelInfo = {
      provider: "local-extension",
      id: "custom-model",
      name: "Custom Model",
      contextWindow: 64_000,
      maxOutput: 8_000,
      modalities: ["text"],
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const extensions = new ExtensionHost();
    await extensions.register({
      name: "custom-model",
      activate: (api) => api.registerModels([model]),
    });

    expect(modelPickerItems(extensions, {})).toEqual([
      {
        label: "local-extension/custom-model",
        description: "Custom Model · extension",
      },
    ]);
  });
});
