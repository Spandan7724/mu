// Classifies an observed control before the model ever sees it (BD12/BD14).
//
// The classification is deliberately made from the accessibility name and role
// rather than from anything the page tells the model, and it is applied inside the
// driver, so a generic click cannot reach a commitment control however the page
// labels it and however the model reasons about it.
import type { SubmitIntent } from "../../contracts/intent.ts";
import type { BrowserRisk } from "../../contracts/observation.ts";
import { isCredentialLabel } from "../../contracts/redaction.ts";

const ACTIVATING_ROLES = new Set(["button", "link", "menuitem", "tab", "switch", "option"]);

// Word-boundary matching over the accessible name. `_` and `-` count as
// separators because form controls are named `submit_application` as often as
// "Submit application".
function has(name: string, ...alternatives: string[]): boolean {
  return new RegExp(`(?<![a-z0-9])(?:${alternatives.join("|")})(?![a-z0-9])`, "i").test(name);
}

const INTENT_PATTERNS: readonly { intent: SubmitIntent; risk: BrowserRisk; words: string[] }[] = [
  {
    intent: "purchase",
    risk: "purchase",
    words: ["buy", "purchase", "pay", "checkout", "place[ _-]?order", "subscribe", "donate"],
  },
  {
    intent: "delete",
    risk: "delete",
    words: ["delete", "remove", "destroy", "erase", "discard", "withdraw", "cancel[ _-]?account"],
  },
  {
    intent: "account-change",
    risk: "account-change",
    words: [
      "change[ _-]?(?:email|password|plan)",
      "update[ _-]?account",
      "close[ _-]?account",
      "deactivate",
      "transfer",
    ],
  },
  {
    intent: "consent",
    risk: "consent",
    words: ["agree", "accept", "consent", "authorize", "authorise", "i[ _-]?agree", "opt[ _-]?in"],
  },
  {
    intent: "send",
    risk: "send",
    words: ["send", "post", "publish", "share", "invite", "message", "reply"],
  },
  {
    intent: "submit-form",
    risk: "submit",
    words: [
      "submit",
      "apply",
      "confirm",
      "finish",
      "complete",
      "save[ _-]?(?:and[ _-]?)?(?:continue|submit)",
      "sign[ _-]?up",
      "register",
      "book",
      "reserve",
    ],
  },
];

export interface ClassifiedElement {
  role?: string | undefined;
  name?: string | undefined;
  inputType?: string | undefined;
  // Set when the sidecar reports the control opens a file chooser.
  fileChooser?: boolean | undefined;
  // Set for anchors whose target the browser downloads rather than renders.
  download?: boolean | undefined;
}

export function commitmentIntent(element: ClassifiedElement): SubmitIntent | undefined {
  const role = element.role ?? "";
  const name = element.name ?? "";
  if (name.length === 0 || !ACTIVATING_ROLES.has(role)) return undefined;
  for (const pattern of INTENT_PATTERNS) {
    if (has(name, ...pattern.words)) return pattern.intent;
  }
  return undefined;
}

export function intentRisk(intent: SubmitIntent): BrowserRisk {
  const found = INTENT_PATTERNS.find((pattern) => pattern.intent === intent);
  return found?.risk ?? "submit";
}

export function isCredentialControl(element: ClassifiedElement): boolean {
  if (element.inputType === "password") return true;
  return isCredentialLabel(element.name);
}

export function classifyRisks(element: ClassifiedElement): BrowserRisk[] {
  const risks = new Set<BrowserRisk>();
  const name = element.name ?? "";
  if (isCredentialControl(element)) risks.add("password");
  if (has(name, "captcha", "recaptcha", "hcaptcha", "i[ _-]?am[ _-]?not[ _-]?a[ _-]?robot")) {
    risks.add("captcha");
  }
  if (has(name, "sign[ _-]?in", "log[ _-]?in", "continue[ _-]?with", "passkey", "mfa", "2fa")) {
    risks.add("authentication");
  }
  if (element.fileChooser === true || element.inputType === "file") risks.add("file-upload");
  if (element.download === true) risks.add("download");
  const intent = commitmentIntent(element);
  if (intent !== undefined) risks.add(intentRisk(intent));
  return [...risks];
}
