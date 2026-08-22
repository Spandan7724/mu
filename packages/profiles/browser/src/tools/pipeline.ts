// ARCHITECTURE §9, in order, once. Every browser action runs through `prepareAction`:
//
//   schema validation (the tool's Zod schema, before this file is reached)
//     → connection/tab/revision validation
//     → allowed-origin policy ┐
//     → target resolution     ├ all three delegated to policy/decide.ts, which already
//     → risk classification   │ composes them in this order and owns every decision
//     → Mu permission         ┘
//     → actionability
//
// The stages this file owns are the ones policy cannot see: whether a browser is
// connected, whether the reference belongs to the observation that is current *now*, and
// whether the control can physically accept the action. Nothing here re-decides safety —
// a second copy of a safety decision that drifts is worse than none.
import type { BrowserAction } from "../contracts/actions.ts";
import type { ApplicantFact, Sensitivity } from "../contracts/applicant.ts";
import { acceptsModelActions } from "../contracts/connection.ts";
import type { BrowserElement, BrowserElementRef } from "../contracts/observation.ts";
import { decideActRequest, type PolicyOutcome } from "../policy/decide.ts";
import { classifyElement } from "../policy/risk.ts";
import { phaseSummary } from "../runtime/state.ts";
import type { BrowserToolSession, ObservationRecord } from "./session.ts";

export interface PreparedAction {
  kind: "ready";
  record: ObservationRecord;
  /** Refs translated back to what the driver understands. Never model-facing. */
  request: BrowserAction;
  element?: BrowserElement | undefined;
  decision: PolicyOutcome;
}

export interface RefusedAction {
  kind: "refused";
  /** What the model should do next. Always a move, never a dead end. */
  message: string;
  reason:
    | "not-connected"
    | "no-observation"
    | "stale"
    | "denied"
    | "takeover"
    | "use-submit"
    | "not-actionable";
  record?: ObservationRecord | undefined;
  decision?: PolicyOutcome | undefined;
}

export type ActionPreparation = PreparedAction | RefusedAction;

export interface DisclosureContext {
  sensitivity: Sensitivity;
  fact?: ApplicantFact | undefined;
}

export interface PrepareActionInput {
  action: BrowserAction;
  tabId?: string | undefined;
  disclosure?: DisclosureContext | undefined;
  signal: AbortSignal;
}

function refused(reason: RefusedAction["reason"], message: string): RefusedAction {
  return { kind: "refused", reason, message };
}

const CHECKABLE_ROLES = new Set([
  "checkbox",
  "switch",
  "radio",
  "menuitemcheckbox",
  "menuitemradio",
]);

/**
 * Playwright's actionability checks, expressed against what was observed. These are
 * mechanics, not policy: a disabled control cannot accept a click whatever the
 * permissions say, and saying so is more useful than letting the driver time out.
 */
export function checkActionability(
  action: BrowserAction,
  element: BrowserElement | undefined,
): string | undefined {
  if (element === undefined) return undefined;
  const caption = element.label ?? element.name ?? element.ref;
  if (element.disabled === true) {
    return `"${caption}" is disabled. Something on the page has to enable it first — fill the fields it depends on, then observe again.`;
  }
  if ((action.kind === "fill" || action.kind === "type") && element.readonly === true) {
    return `"${caption}" is read-only and cannot be typed into. If the page fills it from another control, set that one instead.`;
  }
  if (
    (action.kind === "fill" || action.kind === "type") &&
    element.options !== undefined &&
    element.options.length > 0
  ) {
    return `"${caption}" is a list of options, not a text field. Use action "select" with one of its option values.`;
  }
  if (action.kind === "select") {
    const options = element.options ?? [];
    if (options.length === 0) {
      return `"${caption}" has no options to select. Observe again and target the control that does.`;
    }
    const known = new Set(
      options.flatMap((option) => [option.label, option.value ?? option.label]),
    );
    const missing = action.values.filter((value) => !known.has(value));
    if (missing.length > 0) {
      return `"${caption}" has no option ${missing.join(", ")}. Its options are: ${options
        .slice(0, 20)
        .map((option) => option.value ?? option.label)
        .join(", ")}.`;
    }
  }
  if (action.kind === "check" || action.kind === "uncheck") {
    const role = element.role?.toLowerCase();
    const inputType = element.inputType?.toLowerCase();
    const checkable =
      (role !== undefined && CHECKABLE_ROLES.has(role)) ||
      inputType === "checkbox" ||
      inputType === "radio";
    if (!checkable) {
      return `"${caption}" is not a checkbox and cannot be ${action.kind}ed. Use action "click" if it is a button.`;
    }
  }
  return undefined;
}

/** Rewrites the model's session references into driver references. */
function toDriverRequest(
  action: BrowserAction,
  translate: (ref: BrowserElementRef) => BrowserElementRef,
): BrowserAction {
  if (action.kind === "drag") {
    return { ...action, source: translate(action.source), target: translate(action.target) };
  }
  if (action.target === undefined) return action;
  return { ...action, target: translate(action.target) };
}

export async function prepareAction(
  session: BrowserToolSession,
  input: PrepareActionInput,
): Promise<ActionPreparation> {
  // Stage 1 (connection). A tool that cannot reach a browser says so with the move that
  // fixes it, rather than surfacing a transport code.
  const phase = session.runtime.status().phase;
  if (phase === "takeover") {
    return refused(
      "takeover",
      `The user has control of the browser (${phaseSummary(phase)}). Wait for them to finish and resume; every earlier reference is already invalid.`,
    );
  }

  // Stage 2 (tab/revision). The page is re-observed *before* the reference is judged, so
  // a page that changed between the model's observation and this call is caught here
  // rather than after the action has already happened.
  const record = await session.observe(
    input.tabId === undefined ? {} : { tabId: input.tabId },
    input.signal,
  );
  if (!acceptsModelActions(session.runtime.status().phase)) {
    return refused(
      "not-connected",
      `The browser is not ready to act: ${phaseSummary(session.runtime.status().phase)}.`,
    );
  }

  const targets: BrowserElementRef[] =
    input.action.kind === "drag"
      ? [input.action.source, input.action.target]
      : input.action.target === undefined
        ? []
        : [input.action.target];

  const driverRefs = new Map<string, BrowserElementRef>();
  for (const ref of targets) {
    const resolution = session.resolve(ref, record);
    if (resolution.kind === "stale") {
      return {
        kind: "refused",
        reason: "stale",
        record,
        message: `${resolution.message} The page is now at revision ${record.revision}; call browser_observe and use a reference from that observation.`,
      };
    }
    driverRefs.set(ref.ref, resolution.target.driverRef);
  }

  // Stages 3-6, delegated whole. decideActRequest runs origin policy, target resolution,
  // risk classification and permission evaluation in ARCHITECTURE §9's order.
  const decision = decideActRequest(session.policy, {
    action: input.action,
    observation: record.observation,
    ...(input.disclosure === undefined ? {} : { disclosure: input.disclosure }),
  });

  switch (decision.kind) {
    case "stale":
      return {
        kind: "refused",
        reason: "stale",
        record,
        decision,
        message: `${decision.message} Call browser_observe and use a reference from that observation.`,
      };
    case "deny":
      return { kind: "refused", reason: "denied", record, decision, message: decision.message };
    case "takeover":
      return {
        kind: "refused",
        reason: "takeover",
        record,
        decision,
        message: `${decision.message}. Call browser_takeover with reason "${decision.reason}" and tell the user exactly what to do.`,
      };
    case "use-submit":
      return {
        kind: "refused",
        reason: "use-submit",
        record,
        decision,
        // BD12 is a routing instruction, not a failure: the model has a next move.
        message: `${decision.message}. browser_act does not perform commitments.`,
      };
    default:
      break;
  }

  const element =
    input.action.target === undefined
      ? undefined
      : record.targets.get(input.action.target.ref)?.element;

  // Stage 7 (actionability).
  const blocked = checkActionability(input.action, element);
  if (blocked !== undefined) {
    return { kind: "refused", reason: "not-actionable", record, decision, message: blocked };
  }

  return {
    kind: "ready",
    record,
    decision,
    ...(element === undefined ? {} : { element }),
    request: toDriverRequest(input.action, (ref) => driverRefs.get(ref.ref) ?? ref),
  };
}

/** Whether entering this value tells the site something about the user (TOOLS.md). */
export function disclosesPersonalData(element: BrowserElement | undefined): boolean {
  if (element === undefined) return false;
  return classifyElement(element).risks.includes("personal-data");
}
