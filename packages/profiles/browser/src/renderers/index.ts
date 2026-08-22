// The browser product's user-facing surfaces: approval cards, the structured
// approval path a headless or RPC caller uses, takeover and resume, and the tool
// cells. Everything here renders decisions the policy layer already made; nothing
// here makes one.
export * from "./approval.ts";
export * from "./card.ts";
export * from "./cells.ts";
export * from "./takeover.ts";
export * from "./text.ts";

import type { ToolRenderer } from "@mu/core";
import { BROWSER_STATUS_TOOL } from "../profile/tools.ts";
import { browserToolRenderers } from "./cells.ts";

/**
 * What the profile registers today. The cells for `browser_observe`, `browser_act`,
 * `browser_submit` and the rest exist in `browserToolRenderers`, but registering a
 * renderer for a tool the toolset does not yet expose would claim a surface the
 * product does not have. The integration gate widens this as the tools land, with
 * `browserRenderersFor`.
 */
export const browserRenderers: Record<string, ToolRenderer> = {
  [BROWSER_STATUS_TOOL]: browserToolRenderers[BROWSER_STATUS_TOOL] as ToolRenderer,
};

/** The renderers for exactly the tools a toolset actually registers. */
export function browserRenderersFor(toolNames: readonly string[]): Record<string, ToolRenderer> {
  const renderers: Record<string, ToolRenderer> = {};
  for (const name of toolNames) {
    const renderer = browserToolRenderers[name];
    if (renderer !== undefined) renderers[name] = renderer;
  }
  return renderers;
}
