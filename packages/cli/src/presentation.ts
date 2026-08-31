import { codingRenderers, RendererRegistry, subagentRenderers, type ToolRendererFn } from "@mu/tui";
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
  registerDeclaredRenderers(registry, Object.entries(profile?.renderers ?? {}));
  registerDeclaredRenderers(registry, extensionRenderers);
  return registry;
}
