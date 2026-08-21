import type { BrowserAction } from "../contracts/actions.ts";
import type { SubmitIntent } from "../contracts/intent.ts";
import {
  type BrowserElement,
  type BrowserRisk,
  isCredentialElement,
} from "../contracts/observation.ts";
import type { TakeoverReason } from "../contracts/takeover.ts";

// Labels, accessible names and form keys arrive with "_" and "-" as separators, so
// the boundaries here cannot rely on \b.
const START = "(?<![a-z0-9])";
const END = "(?![a-z0-9])";
const SEP = "[ _-]?";

function words(...alternatives: string[]): RegExp {
  return new RegExp(`${START}(?:${alternatives.join("|")})${END}`, "i");
}

const PURCHASE_PATTERN = words(
  "buy",
  `buy${SEP}now`,
  "purchase",
  "checkout",
  `check${SEP}out`,
  `place${SEP}order`,
  `complete${SEP}(?:order|purchase|payment)`,
  `submit${SEP}order`,
  `confirm${SEP}(?:and${SEP})?pay`,
  `pay${SEP}(?:now|with)`,
  "payment",
  "donate",
  "subscribe",
  `start${SEP}(?:trial|subscription)`,
  `place${SEP}bid`,
  `transfer${SEP}funds`,
  `send${SEP}(?:money|payment)`,
);

// Bare "cancel" is deliberately absent: in most dialogs it is the safe choice, and
// classifying it as destructive would push the abort path through browser_submit.
const DELETE_PATTERN = words(
  "delete",
  "remove",
  "erase",
  "destroy",
  "purge",
  "deactivate",
  "terminate",
  "unsubscribe",
  "revoke",
  `permanently${SEP}\\w+`,
  `close${SEP}account`,
  `cancel${SEP}(?:order|subscription|account|membership|plan|booking|reservation|payment)`,
  `withdraw${SEP}application`,
);

const ACCOUNT_CHANGE_PATTERN = words(
  `change${SEP}(?:password|email|phone|username|recovery)`,
  `update${SEP}(?:password|email|phone|security)`,
  `reset${SEP}password`,
  `set${SEP}new${SEP}password`,
  `(?:enable|disable|turn${SEP}off|turn${SEP}on)${SEP}(?:2fa|mfa|two${SEP}factor)`,
  `security${SEP}settings`,
  `add${SEP}(?:recovery|payment|card)`,
  `link${SEP}account`,
  `transfer${SEP}ownership`,
  `sign${SEP}out${SEP}all`,
  `revoke${SEP}(?:access|session|sessions|token|tokens)`,
);

const CONSENT_PATTERN = words(
  "agree",
  `i${SEP}agree`,
  "accept",
  `i${SEP}accept`,
  `accept${SEP}(?:all|terms|cookies)`,
  "consent",
  `opt${SEP}in`,
  "authorize",
  `grant${SEP}(?:access|permission)`,
  `allow${SEP}all`,
);

const SEND_PATTERN = words(
  "send",
  `send${SEP}\\w+`,
  "reply",
  `reply${SEP}all`,
  "post",
  "publish",
  "share",
  "tweet",
  "broadcast",
  "invite",
  `submit${SEP}(?:message|comment|review|post)`,
);

const SUBMIT_PATTERN = words(
  "submit",
  `submit${SEP}(?:form|application)`,
  `apply${SEP}now`,
  `send${SEP}application`,
  `finish${SEP}(?:and${SEP})?submit`,
);

const CAPTCHA_PATTERN = words(
  "captcha",
  "recaptcha",
  "hcaptcha",
  "turnstile",
  `i'?m${SEP}not${SEP}a${SEP}robot`,
  `human${SEP}verification`,
  `verify${SEP}you${SEP}are${SEP}human`,
);

const PERSONAL_FIELD_PATTERN = words(
  `(?:full|first|last|given|family|middle)${SEP}name`,
  "surname",
  "email",
  `e${SEP}mail`,
  "phone",
  "telephone",
  "mobile",
  "address",
  `street${SEP}\\w*`,
  "city",
  `postal${SEP}code`,
  "postcode",
  "zip",
  `date${SEP}of${SEP}birth`,
  `birth${SEP}date`,
  "birthday",
  "employer",
  `job${SEP}title`,
  `linked${SEP}in`,
  "salary",
  "compensation",
  `desired${SEP}pay`,
  "gender",
  "ethnicity",
  "race",
  "veteran",
  "disability",
  "citizenship",
  `work${SEP}authoriz\\w*`,
  "sponsorship",
  "ssn",
  `social${SEP}security\\w*`,
);

const PERSONAL_INPUT_TYPES = new Set(["email", "tel", "date"]);

export type ActionRiskClass =
  | "read"
  | "reversible-mutation"
  | "disclosure"
  | "authentication"
  | "commitment"
  | "destructive"
  | "unknown";

const RISK_CLASS: Record<BrowserRisk, ActionRiskClass> = {
  password: "authentication",
  authentication: "authentication",
  captcha: "authentication",
  "personal-data": "disclosure",
  "file-upload": "disclosure",
  download: "reversible-mutation",
  submit: "commitment",
  send: "commitment",
  purchase: "commitment",
  consent: "commitment",
  "account-change": "commitment",
  delete: "destructive",
};

// "unknown" sits above the benign classes so an unclassifiable control can never be
// treated as a plain read, and below the named hazards so a positive detection wins.
const CLASS_SEVERITY: Record<ActionRiskClass, number> = {
  read: 0,
  "reversible-mutation": 1,
  unknown: 2,
  disclosure: 3,
  authentication: 4,
  commitment: 5,
  destructive: 6,
};

const RISK_INTENT: Partial<Record<BrowserRisk, SubmitIntent>> = {
  submit: "submit-form",
  send: "send",
  purchase: "purchase",
  delete: "delete",
  consent: "consent",
  "account-change": "account-change",
};

// Consequence order. The dominant intent is the one a preview must name, so a
// purchase control can never be presented — or pre-authorized — as a form submit.
const INTENT_SEVERITY: Record<SubmitIntent, number> = {
  "submit-form": 0,
  send: 1,
  consent: 2,
  delete: 3,
  "account-change": 4,
  purchase: 5,
};

export function riskClassOf(risk: BrowserRisk): ActionRiskClass {
  return RISK_CLASS[risk];
}

export function isCommitmentClass(value: ActionRiskClass): boolean {
  return value === "commitment" || value === "destructive";
}

export function dominantRiskClass(classes: readonly ActionRiskClass[]): ActionRiskClass {
  let dominant: ActionRiskClass = "read";
  for (const candidate of classes) {
    if (CLASS_SEVERITY[candidate] > CLASS_SEVERITY[dominant]) dominant = candidate;
  }
  return dominant;
}

export function dominantIntent(intents: readonly SubmitIntent[]): SubmitIntent | undefined {
  let dominant: SubmitIntent | undefined;
  for (const candidate of intents) {
    if (dominant === undefined || INTENT_SEVERITY[candidate] > INTENT_SEVERITY[dominant]) {
      dominant = candidate;
    }
  }
  return dominant;
}

export interface ElementClassification {
  riskClass: ActionRiskClass;
  risks: BrowserRisk[];
  intents: SubmitIntent[];
  intent?: SubmitIntent | undefined;
  reasons: string[];
}

function captions(element: BrowserElement): string[] {
  return [element.name, element.label, element.value, element.description].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
}

function fieldNames(element: BrowserElement): string[] {
  return [element.name, element.label, element.placeholder, element.description].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
}

function isFormSubmitter(element: BrowserElement): boolean {
  const type = element.inputType?.toLowerCase();
  return type === "submit" || type === "image";
}

function isInteractiveControl(element: BrowserElement): boolean {
  const role = element.role?.toLowerCase();
  return (
    role === "button" ||
    role === "link" ||
    role === "menuitem" ||
    role === "tab" ||
    role === "checkbox" ||
    role === "switch" ||
    element.inputType !== undefined
  );
}

// Classification is derived from what was observed, never from a label the model
// supplies. `element.risk` is treated as a floor the driver already found: this
// function may add risks to it and never removes one.
export function classifyElement(element: BrowserElement): ElementClassification {
  const risks = new Set<BrowserRisk>(element.risk ?? []);
  const reasons: string[] = [];

  const add = (risk: BrowserRisk, reason: string) => {
    if (!risks.has(risk)) reasons.push(reason);
    risks.add(risk);
  };

  if (isCredentialElement(element)) add("password", "credential-shaped control");

  const caption = captions(element).join(" • ");
  const field = fieldNames(element).join(" • ");

  if (CAPTCHA_PATTERN.test(field) || CAPTCHA_PATTERN.test(caption)) {
    add("captcha", "captcha challenge");
  }

  if (isFormSubmitter(element)) add("submit", "form submitter");

  if (caption.length > 0 && isInteractiveControl(element)) {
    if (PURCHASE_PATTERN.test(caption)) add("purchase", "purchase-class label");
    if (DELETE_PATTERN.test(caption)) add("delete", "destructive label");
    if (ACCOUNT_CHANGE_PATTERN.test(caption)) add("account-change", "account-change label");
    if (CONSENT_PATTERN.test(caption)) add("consent", "consent label");
    if (SEND_PATTERN.test(caption)) add("send", "send-class label");
    if (SUBMIT_PATTERN.test(caption)) add("submit", "submit-class label");
  }

  if (element.inputType?.toLowerCase() === "file") add("file-upload", "file input");

  const inputType = element.inputType?.toLowerCase();
  if (
    (inputType !== undefined && PERSONAL_INPUT_TYPES.has(inputType)) ||
    (field.length > 0 && PERSONAL_FIELD_PATTERN.test(field))
  ) {
    add("personal-data", "personal-data field");
  }

  const list = [...risks];
  const intents = [...new Set(list.map((risk) => RISK_INTENT[risk]))].filter(
    (intent): intent is SubmitIntent => intent !== undefined,
  );
  const classes = list.map(riskClassOf);
  // A control that is interactive but matched nothing is unknown, not read.
  const riskClass =
    classes.length > 0
      ? dominantRiskClass(classes)
      : isInteractiveControl(element) && caption.length === 0
        ? "unknown"
        : "read";
  const intent = dominantIntent(intents);

  return {
    riskClass,
    risks: list,
    intents,
    ...(intent === undefined ? {} : { intent }),
    reasons,
  };
}

const EMPTY_CLASSIFICATION: ElementClassification = {
  riskClass: "read",
  risks: [],
  intents: [],
  reasons: [],
};

// Keys that activate the focused control, and therefore submit a form containing a
// submitter, without any click ever being requested.
const ACTIVATING_KEYS = new Set(["enter", "numpadenter", "return", "space", " "]);

export type GenericActionGate =
  | { kind: "allow"; classification: ElementClassification }
  | {
      kind: "use-submit";
      intent: SubmitIntent;
      classification: ElementClassification;
      message: string;
    }
  | {
      kind: "takeover";
      reason: TakeoverReason;
      classification: ElementClassification;
      message: string;
    }
  | { kind: "deny"; classification: ElementClassification; message: string };

function takeoverReasonFor(classification: ElementClassification): TakeoverReason {
  if (classification.risks.includes("captcha")) return "captcha";
  if (classification.risks.includes("password")) return "password";
  return "login";
}

function useSubmit(intent: SubmitIntent, classification: ElementClassification): GenericActionGate {
  return {
    kind: "use-submit",
    intent,
    classification,
    message: `this control performs a ${intent} action; call browser_submit with intent "${intent}" so the effect can be previewed and approved`,
  };
}

function takeover(classification: ElementClassification): GenericActionGate {
  const reason = takeoverReasonFor(classification);
  return {
    kind: "takeover",
    reason,
    classification,
    message: `this control is an authentication boundary (${reason}); request browser_takeover and let the user operate the browser`,
  };
}

export interface GenericActionContext {
  action: BrowserAction;
  element?: BrowserElement | undefined;
  source?: BrowserElement | undefined;
  // Elements of the current observation, used to find the form submitter a keyboard
  // activation would reach.
  observed?: readonly BrowserElement[] | undefined;
}

function needsTarget(action: BrowserAction): boolean {
  return action.kind !== "press" && action.kind !== "scroll";
}

// BD12, enforced here: every path from browser_act to a commitment-class control ends
// in `use-submit`. Nothing in BrowserAction can relabel a control, and an unresolved
// target fails closed rather than executing unclassified.
export function gateGenericAction(context: GenericActionContext): GenericActionGate {
  const { action } = context;

  if (context.element === undefined && needsTarget(action)) {
    return {
      kind: "deny",
      classification: EMPTY_CLASSIFICATION,
      message:
        "target could not be resolved in the latest observation, so it cannot be classified; observe again",
    };
  }

  const classifications: ElementClassification[] = [];
  if (context.element !== undefined) classifications.push(classifyElement(context.element));
  if (action.kind === "drag" && context.source !== undefined) {
    classifications.push(classifyElement(context.source));
  }

  for (const classification of classifications) {
    if (classification.riskClass === "authentication") return takeover(classification);
  }

  for (const classification of classifications) {
    if (isCommitmentClass(classification.riskClass) && classification.intent !== undefined) {
      return useSubmit(classification.intent, classification);
    }
  }

  const classification = classifications[0] ?? EMPTY_CLASSIFICATION;

  if (
    classification.risks.includes("file-upload") &&
    (action.kind === "fill" || action.kind === "type" || action.kind === "select")
  ) {
    return {
      kind: "deny",
      classification,
      message:
        "file inputs accept authorized documents only; call browser_upload with document ids",
    };
  }

  if (action.kind === "press" && ACTIVATING_KEYS.has(action.key.toLowerCase())) {
    const frameId = context.element?.frameId;
    const reachable = (context.observed ?? []).filter(
      (candidate) => candidate.frameId === frameId && candidate !== context.element,
    );
    for (const candidate of reachable) {
      const other = classifyElement(candidate);
      if (isCommitmentClass(other.riskClass) && other.intent !== undefined) {
        return useSubmit(other.intent, other);
      }
    }
  }

  return { kind: "allow", classification };
}

export type SubmitIntentCheck =
  | { kind: "ok"; classification: ElementClassification }
  | {
      kind: "not-committal";
      classification: ElementClassification;
      message: string;
    }
  | {
      kind: "mismatch";
      declared: SubmitIntent;
      classified: SubmitIntent;
      classification: ElementClassification;
      message: string;
    };

// TOOLS.md: the runtime validates the target is capable of the declared intent before
// a preview exists. Matching against the dominant intent — not mere membership — is
// what stops a purchase control from being approved under the cheaper "submit-form"
// scope that autonomous-submit may pre-authorize.
export function validateSubmitIntent(
  declared: SubmitIntent,
  element: BrowserElement,
): SubmitIntentCheck {
  const classification = classifyElement(element);
  if (classification.intent === undefined) {
    return {
      kind: "not-committal",
      classification,
      message:
        "this control was not observed to perform a classified external action; use browser_act for reversible interaction",
    };
  }
  if (classification.intent !== declared) {
    return {
      kind: "mismatch",
      declared,
      classified: classification.intent,
      classification,
      message: `the declared intent "${declared}" does not match the observed control, which performs "${classification.intent}"`,
    };
  }
  return { kind: "ok", classification };
}
