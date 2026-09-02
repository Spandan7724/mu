import type { HostedWebSearchToolSpec, Provider, WebSearchConfig } from "@mu/ai";

export type WebSearchBackend =
  | { kind: "disabled" }
  | { kind: "hosted"; tool: HostedWebSearchToolSpec }
  | { kind: "unavailable"; provider: string };

export function resolveWebSearchBackend(
  provider: Provider,
  config: WebSearchConfig | undefined,
): WebSearchBackend {
  if (!config || config.mode === "disabled") return { kind: "disabled" };
  if (!provider.capabilities?.hostedWebSearch) {
    return { kind: "unavailable", provider: provider.id };
  }

  const tool: HostedWebSearchToolSpec = {
    type: "web_search",
    externalWebAccess: config.mode !== "cached",
    ...(config.mode === "indexed" ? { indexedWebAccess: true } : {}),
    ...(config.allowedDomains?.length
      ? { filters: { allowedDomains: config.allowedDomains } }
      : {}),
    ...(config.userLocation
      ? { userLocation: { type: "approximate", ...config.userLocation } }
      : {}),
    ...(config.searchContextSize ? { searchContextSize: config.searchContextSize } : {}),
  };
  return { kind: "hosted", tool };
}
