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
import { browserToolRenderers } from "./cells.ts";

export const browserRenderers: Record<string, ToolRenderer> = browserToolRenderers;
