import type { AnyTool } from "@mu/core";
import { BROWSER_ACT_TOOL, browserActTool } from "./act.ts";
import type { BrowserToolContext } from "./context.ts";
import { BROWSER_NAVIGATE_TOOL, browserNavigateTool } from "./navigate.ts";
import { BROWSER_OBSERVE_TOOL, browserObserveTool } from "./observe.ts";
import { BROWSER_TABS_TOOL, browserTabsTool } from "./tabs.ts";
import { BROWSER_TAKEOVER_TOOL, browserTakeoverTool } from "./takeover.ts";
import { BROWSER_WAIT_TOOL, browserWaitTool } from "./wait.ts";

export { BROWSER_ACT_TOOL, browserActTool } from "./act.ts";
export type { BrowserToolContext, BrowserToolDetails } from "./context.ts";
export type { NormalizedToolError } from "./errors.ts";
export { normalizeToolError, toolErrorText } from "./errors.ts";
export { BROWSER_NAVIGATE_TOOL, browserNavigateTool } from "./navigate.ts";
export { elementSignature, OBSERVATION_BUDGET, observationDigest } from "./observation.ts";
export { BROWSER_OBSERVE_TOOL, browserObserveTool } from "./observe.ts";
export type { ActionPreparation, PreparedAction, RefusedAction } from "./pipeline.ts";
export { checkActionability, prepareAction } from "./pipeline.ts";
export {
  describeElement,
  observationFacts,
  observationHeadline,
  observationText,
  outcomeText,
  screenshotSuppressed,
} from "./render.ts";
export type {
  BrowserAuditEntry,
  BrowserToolSessionOptions,
  ObservationRecord,
  ObservationTarget,
  TargetResolution,
} from "./session.ts";
export { BrowserToolSession } from "./session.ts";
export { BROWSER_TABS_TOOL, browserTabsTool } from "./tabs.ts";
export { BROWSER_TAKEOVER_TOOL, browserTakeoverTool } from "./takeover.ts";
export { BROWSER_WAIT_TOOL, browserWaitTool } from "./wait.ts";

/**
 * TOOLS.md's model-facing surface for B3. `browser_upload` and `browser_submit` are B5 and
 * `browser_pointer` is B8; a generic action cannot substitute for any of them, which is
 * why their absence here is a boundary rather than a gap.
 */
export const BROWSER_TOOL_NAMES = [
  BROWSER_OBSERVE_TOOL,
  BROWSER_NAVIGATE_TOOL,
  BROWSER_TABS_TOOL,
  BROWSER_ACT_TOOL,
  BROWSER_WAIT_TOOL,
  BROWSER_TAKEOVER_TOOL,
] as const;

export function browserToolset(context: BrowserToolContext): AnyTool[] {
  return [
    browserObserveTool(context) as AnyTool,
    browserNavigateTool(context) as AnyTool,
    browserTabsTool(context) as AnyTool,
    browserActTool(context) as AnyTool,
    browserWaitTool(context) as AnyTool,
    browserTakeoverTool(context) as AnyTool,
  ];
}
