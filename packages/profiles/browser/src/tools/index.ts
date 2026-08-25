import type { AnyTool } from "@mu/core";
import { BROWSER_ACT_TOOL, browserActTool } from "./act.ts";
import type { BrowserToolContext } from "./context.ts";
import { BROWSER_NAVIGATE_TOOL, browserNavigateTool } from "./navigate.ts";
import { BROWSER_OBSERVE_TOOL, browserObserveTool } from "./observe.ts";
import { BROWSER_POINTER_TOOL, browserPointerTool } from "./pointer.ts";
import { BROWSER_SUBMIT_TOOL, browserSubmitTool } from "./submit.ts";
import { BROWSER_TABS_TOOL, browserTabsTool } from "./tabs.ts";
import { BROWSER_TAKEOVER_TOOL, browserTakeoverTool } from "./takeover.ts";
import { BROWSER_TASK_TOOL, browserTaskTool } from "./task.ts";
import { BROWSER_UPLOAD_TOOL, browserUploadTool } from "./upload.ts";
import { BROWSER_WAIT_TOOL, browserWaitTool } from "./wait.ts";

export { BROWSER_ACT_TOOL, browserActTool } from "./act.ts";
export type { BrowserToolContext, BrowserToolDetails } from "./context.ts";
export type { NormalizedToolError } from "./errors.ts";
export { normalizeToolError, toolErrorText } from "./errors.ts";
export { BROWSER_NAVIGATE_TOOL, browserNavigateTool } from "./navigate.ts";
export { elementSignature, OBSERVATION_BUDGET, observationDigest } from "./observation.ts";
export { BROWSER_OBSERVE_TOOL, browserObserveTool } from "./observe.ts";
export { runBrowserOperation, stage, stop } from "./operation.ts";
export type { ActionPreparation, PreparedAction, RefusedAction } from "./pipeline.ts";
export { checkActionability, prepareAction } from "./pipeline.ts";
export { BROWSER_POINTER_TOOL, browserPointerTool } from "./pointer.ts";
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
  BrowserTaskSessionOptions,
  BrowserToolSessionOptions,
  ObservationRecord,
  ObservationTarget,
  TargetResolution,
} from "./session.ts";
export { BrowserTaskSession, BrowserToolSession } from "./session.ts";
export { BROWSER_SUBMIT_TOOL, browserSubmitTool } from "./submit.ts";
export { BROWSER_TABS_TOOL, browserTabsTool } from "./tabs.ts";
export { BROWSER_TAKEOVER_TOOL, browserTakeoverTool } from "./takeover.ts";
export { BROWSER_TASK_TOOL, browserTaskTool } from "./task.ts";
export type {
  BrowserTaskCriterion,
  BrowserTaskCriterionInput,
  BrowserTaskCriterionKind,
  BrowserTaskEvidence,
  BrowserTaskState,
} from "./task-ledger.ts";
export type { BrowserUploadToolContext } from "./upload.ts";
export { BROWSER_UPLOAD_TOOL, browserUploadTool } from "./upload.ts";
export { BROWSER_WAIT_TOOL, browserWaitTool } from "./wait.ts";

/**
 * TOOLS.md's model-facing surface. Pointer interaction remains a separate screenshot-bound
 * fallback; a generic action cannot substitute for a commitment or an upload, which is
 * what the dedicated tools exist to enforce.
 */
export const BROWSER_TOOL_NAMES = [
  BROWSER_TASK_TOOL,
  BROWSER_OBSERVE_TOOL,
  BROWSER_POINTER_TOOL,
  BROWSER_NAVIGATE_TOOL,
  BROWSER_TABS_TOOL,
  BROWSER_ACT_TOOL,
  BROWSER_UPLOAD_TOOL,
  BROWSER_SUBMIT_TOOL,
  BROWSER_WAIT_TOOL,
  BROWSER_TAKEOVER_TOOL,
] as const;

export function browserToolset(context: BrowserToolContext): AnyTool[] {
  const uploads =
    context.session.documents === undefined && context.documents === undefined
      ? []
      : [browserUploadTool(context) as AnyTool];
  return [
    browserTaskTool(context) as AnyTool,
    browserObserveTool(context) as AnyTool,
    browserPointerTool(context) as AnyTool,
    browserNavigateTool(context) as AnyTool,
    browserTabsTool(context) as AnyTool,
    browserActTool(context) as AnyTool,
    ...uploads,
    browserSubmitTool(context) as AnyTool,
    browserWaitTool(context) as AnyTool,
    browserTakeoverTool(context) as AnyTool,
  ];
}
