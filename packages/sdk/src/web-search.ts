import type { HostedWebSearchToolSpec, Provider } from "@mu/ai";

export type WebSearchBackend =
  | { kind: "disabled" }
  | { kind: "hosted"; tool: HostedWebSearchToolSpec };

export function resolveWebSearchBackend(provider: Provider): WebSearchBackend {
  return provider.capabilities?.hostedWebSearch
    ? { kind: "hosted", tool: { type: "web_search" } }
    : { kind: "disabled" };
}
