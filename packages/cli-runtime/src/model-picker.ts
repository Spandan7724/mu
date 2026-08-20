import { type ExtensionHost, listModels, type ModelInfo } from "mu";
import { accountLoginProviders } from "./login.ts";

export type ModelCredentialSource = "apiKey" | "oauth" | "extension";

export interface ModelPickerItem {
  label: string;
  description?: string;
}

export function availableModels(
  extensions: ExtensionHost,
  authenticatedProviders?: ReadonlySet<string>,
): ModelInfo[] {
  const models = new Map<string, ModelInfo>(
    listModels()
      .filter((model) => !authenticatedProviders || authenticatedProviders.has(model.provider))
      .map((model) => [`${model.provider}/${model.id}`, model] as const),
  );
  for (const [ref, model] of extensions.models) models.set(ref, model);
  return [...models.values()];
}

export function modelPickerDescription(model: ModelInfo, source: ModelCredentialSource): string {
  const authentication =
    source === "oauth"
      ? (accountLoginProviders.find((provider) => provider.id === model.provider)?.description ??
        "account")
      : source === "apiKey"
        ? "API key"
        : "extension";
  return model.name ? `${model.name} · ${authentication}` : authentication;
}

export function modelPickerItems(
  extensions: ExtensionHost,
  credentials: Readonly<Record<string, { type: "apiKey" | "oauth" }>>,
): ModelPickerItem[] {
  return availableModels(extensions, new Set(Object.keys(credentials))).map((model) => {
    const label = `${model.provider}/${model.id}`;
    const credential = credentials[model.provider];
    const source: ModelCredentialSource = extensions.models.has(label)
      ? "extension"
      : (credential?.type ?? "apiKey");
    return {
      label,
      description: modelPickerDescription(model, source),
    };
  });
}
