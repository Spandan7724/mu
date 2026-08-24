import type { PermissionRule } from "@mu/core";
import type { BrowserAction, NavigateRequest, SubmitRequest } from "../contracts/actions.ts";
import type { ApplicantFact, Sensitivity } from "../contracts/applicant.ts";
import {
  type BrowserElement,
  type BrowserElementRef,
  type BrowserObservation,
  type RefValidity,
  refValidity,
  refValidityMessage,
} from "../contracts/observation.ts";
import type { TakeoverReason } from "../contracts/takeover.ts";
import type { AuthorityContext } from "./authority.ts";
import {
  type AutonomousSubmitGrant,
  type BrowserPermissionMode,
  evaluateBrowserPermission,
} from "./modes.ts";
import {
  classifyNavigationUrl,
  decideDisclosure,
  decideFrameInteraction,
  decideNavigation,
  isOriginAllowed,
  type OriginPolicy,
} from "./origin.ts";
import {
  classifyElement,
  gateGenericAction,
  isCommitmentClass,
  validateSubmitIntent,
} from "./risk.ts";
import {
  actPattern,
  type BrowserScope,
  navigatePattern,
  scopeForIntent,
  scopesForAction,
  submitPattern,
  uploadPattern,
} from "./scopes.ts";
import { detectTakeover } from "./takeover.ts";

// The single pre-action funnel. It follows ARCHITECTURE §9 in order — tab/revision,
// origin, target resolution, risk classification, permission — so a caller cannot
// reach a later stage by skipping an earlier one.
export interface BrowserPolicyState {
  origins: OriginPolicy;
  mode: BrowserPermissionMode;
  grant?: AutonomousSubmitGrant | undefined;
  rules?: readonly PermissionRule[] | undefined;
  context?: AuthorityContext | undefined;
}

export type PolicyOutcome =
  | { kind: "allow"; scopes: readonly BrowserScope[]; pattern: string }
  | {
      kind: "ask";
      scopes: readonly BrowserScope[];
      pattern: string;
      description: string;
      reasons: string[];
    }
  | { kind: "deny"; message: string }
  | { kind: "takeover"; reason: TakeoverReason; message: string }
  | { kind: "use-submit"; intent: SubmitRequest["intent"]; message: string }
  | { kind: "stale"; validity: RefValidity; message: string };

function deny(message: string): PolicyOutcome {
  return { kind: "deny", message };
}

function permission(
  state: BrowserPolicyState,
  scopes: readonly BrowserScope[],
  pattern: string,
  description: string,
  reasons: string[] = [],
  flags: { unknownRisk?: boolean; originApproved?: boolean } = {},
): PolicyOutcome {
  const decision = evaluateBrowserPermission({
    mode: state.mode,
    scopes,
    pattern,
    ...(state.rules === undefined ? {} : { rules: state.rules }),
    ...(state.grant === undefined ? {} : { grant: state.grant }),
    ...(state.context === undefined ? {} : { context: state.context }),
    ...(flags.unknownRisk === undefined ? {} : { unknownRisk: flags.unknownRisk }),
    ...(flags.originApproved === undefined ? {} : { originApproved: flags.originApproved }),
  });
  if (decision.action === "deny") return deny(`${description} is denied by a permission rule`);
  if (decision.action === "allow") return { kind: "allow", scopes, pattern };
  return { kind: "ask", scopes, pattern, description, reasons };
}

function resolve(
  ref: BrowserElementRef,
  observation: BrowserObservation,
): BrowserElement | PolicyOutcome {
  const validity = refValidity(ref, observation);
  if (validity !== "current") {
    return { kind: "stale", validity, message: refValidityMessage(validity) };
  }
  const element = observation.elements.find((candidate) => candidate.ref === ref.ref);
  if (element === undefined) {
    return { kind: "stale", validity: "unknown", message: refValidityMessage("unknown") };
  }
  return element;
}

function isOutcome(value: BrowserElement | PolicyOutcome): value is PolicyOutcome {
  return "kind" in value;
}

// SECURITY §5: a cross-origin frame is decided on its own origin, so an element
// reached inside one never inherits the top-level page's approval.
function frameOutcome(
  state: BrowserPolicyState,
  element: BrowserElement,
  observation: BrowserObservation,
): PolicyOutcome | undefined {
  if (element.frameId === undefined) return undefined;
  const frame = observation.frames.find((candidate) => candidate.id === element.frameId);
  if (frame === undefined) {
    return {
      kind: "stale",
      validity: "unknown-frame",
      message: refValidityMessage("unknown-frame"),
    };
  }
  if (!frame.crossOrigin) return undefined;
  const decision = decideFrameInteraction(state.origins, frame);
  if (decision.kind === "allowed") return undefined;
  if (decision.kind === "denied") return deny(decision.message);
  return {
    kind: "ask",
    scopes: ["browser:new-origin"],
    pattern: navigatePattern(decision.origin),
    description: `interact with a cross-origin frame from ${decision.origin}`,
    reasons: [decision.message, ...decision.display.warnings],
  };
}

function pageOriginOutcome(
  state: BrowserPolicyState,
  observation: BrowserObservation,
): PolicyOutcome | undefined {
  const origin = observation.origin;
  if (origin === undefined) {
    return deny("the current page has no usable web origin; observe a http(s) page before acting");
  }
  if (isOriginAllowed(state.origins, origin)) return undefined;
  const decision = decideNavigation(state.origins, { to: observation.url });
  const reasons =
    decision.kind === "allowed"
      ? []
      : decision.kind === "denied"
        ? [decision.message]
        : [decision.message, ...decision.display.warnings];
  return {
    kind: "ask",
    scopes: ["browser:new-origin"],
    pattern: navigatePattern(origin),
    description: `act on ${origin}, which this task has not approved`,
    reasons,
  };
}

export function decideNavigateRequest(
  state: BrowserPolicyState,
  request: NavigateRequest,
  from?: string,
): PolicyOutcome {
  if (request.kind !== "url") {
    return permission(
      state,
      ["browser:navigate"],
      navigatePattern(from),
      `browser history ${request.kind}`,
    );
  }
  const check = classifyNavigationUrl(request.url);
  if (!check.ok) return deny(check.message);

  const decision = decideNavigation(state.origins, {
    to: request.url,
    ...(from === undefined ? {} : { from }),
  });
  if (decision.kind === "denied") return deny(decision.message);
  if (decision.kind === "ask") {
    return permission(
      state,
      ["browser:new-origin"],
      navigatePattern(decision.origin),
      `open ${decision.display.display}`,
      [decision.message, ...decision.display.warnings],
      { originApproved: false },
    );
  }
  return permission(
    state,
    ["browser:navigate"],
    navigatePattern(decision.origin),
    `open ${decision.display.display}`,
  );
}

export interface ActDecisionInput {
  action: BrowserAction;
  observation: BrowserObservation;
  /** Sensitivity of the value being entered, when the runtime knows it. */
  disclosure?: { sensitivity: Sensitivity; fact?: ApplicantFact | undefined } | undefined;
}

export function decideActRequest(
  state: BrowserPolicyState,
  input: ActDecisionInput,
): PolicyOutcome {
  const { action, observation } = input;

  const originOutcome = pageOriginOutcome(state, observation);
  if (originOutcome !== undefined) return originOutcome;

  let element: BrowserElement | undefined;
  let source: BrowserElement | undefined;

  const targetRef = action.target;
  if (targetRef !== undefined) {
    const resolved = resolve(targetRef, observation);
    if (isOutcome(resolved)) return resolved;
    element = resolved;
    const frame = frameOutcome(state, element, observation);
    if (frame !== undefined) return frame;
  }
  if (action.kind === "drag") {
    const resolved = resolve(action.source, observation);
    if (isOutcome(resolved)) return resolved;
    source = resolved;
  }

  if (element !== undefined) {
    const requirement = detectTakeover(element);
    if (requirement.required && requirement.reason !== undefined) {
      return {
        kind: "takeover",
        reason: requirement.reason,
        message: `this control is an authentication boundary (${requirement.reason}); request browser_takeover`,
      };
    }
  }

  const gate = gateGenericAction({
    action,
    ...(element === undefined ? {} : { element }),
    ...(source === undefined ? {} : { source }),
    observed: observation.elements,
  });
  if (gate.kind === "use-submit")
    return { kind: "use-submit", intent: gate.intent, message: gate.message };
  if (gate.kind === "takeover")
    return { kind: "takeover", reason: gate.reason, message: gate.message };
  if (gate.kind === "deny") return deny(gate.message);

  const reasons: string[] = [];
  if (input.disclosure !== undefined) {
    const decision = decideDisclosure(state.origins, {
      url: observation.url,
      sensitivity: input.disclosure.sensitivity,
      ...(input.disclosure.fact === undefined ? {} : { fact: input.disclosure.fact }),
    });
    if (decision.kind === "denied") return deny(decision.message);
    if (decision.kind === "ask") reasons.push(...decision.reasons);
  }

  const scopes = scopesForAction(action, element);
  const pattern = actPattern(observation.origin, element);
  return permission(state, scopes, pattern, `${action.kind} on ${pattern}`, reasons, {
    unknownRisk: gate.classification.riskClass === "unknown",
  });
}

export interface SubmitDecisionInput {
  request: SubmitRequest;
  observation: BrowserObservation;
}

export function decideSubmitRequest(
  state: BrowserPolicyState,
  input: SubmitDecisionInput,
): PolicyOutcome {
  const { request, observation } = input;

  const originOutcome = pageOriginOutcome(state, observation);
  if (originOutcome !== undefined) return originOutcome;

  const resolved = resolve(request.target, observation);
  if (isOutcome(resolved)) return resolved;
  const element = resolved;

  const frame = frameOutcome(state, element, observation);
  if (frame !== undefined) return frame;

  const requirement = detectTakeover(element);
  if (requirement.required && requirement.reason !== undefined) {
    return {
      kind: "takeover",
      reason: requirement.reason,
      message: `this control is an authentication boundary (${requirement.reason}); request browser_takeover`,
    };
  }

  const check = validateSubmitIntent(request.intent, element);
  if (check.kind !== "ok") return deny(check.message);

  const scope = scopeForIntent(request.intent);
  const pattern = submitPattern(observation.origin, request.intent, element);
  const outcome = permission(state, [scope], pattern, `${request.intent} on ${pattern}`);
  if (request.dialog === undefined || outcome.kind !== "allow") return outcome;
  // A pre-authorized commitment still does not carry an answer to a question the page
  // asks in the middle of it. The dialog is written by the page, so no earlier grant
  // can have covered its words: accepting one is always the user's own decision.
  return {
    kind: "ask",
    scopes: outcome.scopes,
    pattern: outcome.pattern,
    description: `${request.intent} on ${pattern}, accepting the page's confirmation dialog`,
    reasons: ["the page asks its own question before it will commit"],
  };
}

export interface UploadDecisionInput {
  target: BrowserElementRef;
  basenames: readonly string[];
  observation: BrowserObservation;
}

export function decideUploadRequest(
  state: BrowserPolicyState,
  input: UploadDecisionInput,
): PolicyOutcome {
  const originOutcome = pageOriginOutcome(state, input.observation);
  if (originOutcome !== undefined) return originOutcome;

  const resolved = resolve(input.target, input.observation);
  if (isOutcome(resolved)) return resolved;
  const element = resolved;

  const frame = frameOutcome(state, element, input.observation);
  if (frame !== undefined) return frame;

  // A real browser exposes `<input type=file>` as an ordinary button, so the
  // `file-upload` marker is only ever present in a synthetic observation. Denying
  // without it made `browser_upload` impossible against an actual browser — the whole
  // point of the tool. What can be checked here is that this is not a commitment
  // control; whether it accepts files is settled by the driver, which opens it and
  // requires a real file chooser rather than guessing from a label.
  const classification = classifyElement(element);
  if (isCommitmentClass(classification.riskClass)) {
    return deny("a document is never attached through a control that commits");
  }
  const marked = classification.risks.includes("file-upload");

  const pattern = uploadPattern(input.observation.origin, input.basenames.join(" "));
  return permission(state, ["browser:upload"], pattern, `upload ${pattern}`, [], {
    // An unmarked control might not be a file input at all, so it asks rather than
    // going through on a guess.
    ...(marked ? {} : { unknownRisk: true }),
  });
}
