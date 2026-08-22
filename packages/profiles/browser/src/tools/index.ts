import type { AnyTool } from "@mu/core";
import { BROWSER_ACT_TOOL, browserActTool } from "./act.ts";
import type { BrowserToolContext } from "./context.ts";
import { BROWSER_NAVIGATE_TOOL, browserNavigateTool } from "./navigate.ts";
import { BROWSER_OBSERVE_TOOL, browserObserveTool } from "./observe.ts";
import { BROWSER_SUBMIT_TOOL, browserSubmitTool } from "./submit.ts";
import { BROWSER_TABS_TOOL, browserTabsTool } from "./tabs.ts";
import { BROWSER_TAKEOVER_TOOL, browserTakeoverTool } from "./takeover.ts";
import type { BrowserUploadToolContext } from "./upload.ts";
import { BROWSER_UPLOAD_TOOL, browserUploadTool } from "./upload.ts";
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
export { BROWSER_SUBMIT_TOOL, browserSubmitTool } from "./submit.ts";
export { BROWSER_TABS_TOOL, browserTabsTool } from "./tabs.ts";
export { BROWSER_TAKEOVER_TOOL, browserTakeoverTool } from "./takeover.ts";
export type { BrowserUploadToolContext } from "./upload.ts";
export { BROWSER_UPLOAD_TOOL, browserUploadTool } from "./upload.ts";
export { BROWSER_WAIT_TOOL, browserWaitTool } from "./wait.ts";

/**
 * TOOLS.md's model-facing surface. `browser_pointer` is B8 and stays absent; a generic
 * action cannot substitute for a commitment or an upload, which is what the dedicated
 * tools exist to enforce.
 */
export const BROWSER_TOOL_NAMES = [
  BROWSER_OBSERVE_TOOL,
  BROWSER_NAVIGATE_TOOL,
  BROWSER_TABS_TOOL,
  BROWSER_ACT_TOOL,
  BROWSER_UPLOAD_TOOL,
  BROWSER_SUBMIT_TOOL,
  BROWSER_WAIT_TOOL,
  BROWSER_TAKEOVER_TOOL,
] as const;

export function browserToolset(context: BrowserToolContext | BrowserUploadToolContext): AnyTool[] {
  const uploads =
    "documents" in context && context.documents !== undefined
      ? [browserUploadTool(context) as AnyTool]
      : [];
  return [
    browserObserveTool(context) as AnyTool,
    browserNavigateTool(context) as AnyTool,
    browserTabsTool(context) as AnyTool,
    browserActTool(context) as AnyTool,
    ...uploads,
    browserSubmitTool(context) as AnyTool,
    browserWaitTool(context) as AnyTool,
    browserTakeoverTool(context) as AnyTool,
  ];
}
