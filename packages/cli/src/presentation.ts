import {
  browserRenderers,
  codingRenderers,
  RendererRegistry,
  subagentRenderers,
  type ToolRendererFn,
} from "@mu/tui";
import type { Profile, ToolRenderer } from "mu";

type PresentationProfile = Pick<Profile, "name" | "renderers">;

export function registerDeclaredRenderers(
  registry: RendererRegistry,
  renderers: Iterable<readonly [string, ToolRenderer]>,
): void {
  for (const [name, renderer] of renderers) {
    const adapter: ToolRendererFn = (info) =>
      renderer.render({
        toolName: info.toolName,
        args: info.args,
        ...(info.result
          ? {
              result: {
                content: info.result.content,
                ...(info.result.details !== undefined ? { details: info.result.details } : {}),
                ...(info.result.isError ? { isError: true } : {}),
              },
            }
          : {}),
      });
    registry.register(name, adapter);
  }
}

export function createRendererRegistry(
  profile: PresentationProfile | undefined,
  extensionRenderers: Iterable<readonly [string, ToolRenderer]> = [],
): RendererRegistry {
  const registry = new RendererRegistry();
  registry.registerAll(subagentRenderers);
  if (profile?.name === "coding") registry.registerAll(codingRenderers);
  if (profile?.name === "browser") registry.registerAll(browserRenderers);
  registerDeclaredRenderers(registry, Object.entries(profile?.renderers ?? {}));
  registerDeclaredRenderers(registry, extensionRenderers);
  return registry;
}

// Says which agent the session is before the first prompt; coding keeps the
// generic line.
export function profileTagline(
  profile: Pick<Profile, "name"> | undefined,
  environment: Record<string, string> = {},
): string | undefined {
  if (profile?.name !== "browser") return undefined;
  const parts = ["browser agent"];
  if (environment.browser && !environment.browser.startsWith("unavailable"))
    parts.push(environment.browser.replace(/\s+[\d.]+$/, ""));
  parts.push(
    environment.connection?.startsWith("cdp")
      ? environment.connection.replace(/^cdp endpoint/, "cdp")
      : `profile ${environment.browserProfile ?? "default"}`,
  );
  if (environment.headless === "true") parts.push("headless");
  return parts.join(" · ");
}
