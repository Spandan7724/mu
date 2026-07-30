import type { ModelInfo, ProviderModelDiscoveryOptions } from "../types.ts";

export async function discoverGitHubCopilotModels(
  options: ProviderModelDiscoveryOptions,
): Promise<ModelInfo[] | undefined> {
  const credential = await options.getCredentials?.();
  if (!credential || credential.type !== "oauth" || credential.availableModelIds === undefined) {
    return undefined;
  }
  const available = new Set(credential.availableModelIds);
  return options.currentModels.filter(
    (model) => model.provider === "github-copilot" && available.has(model.id),
  );
}
