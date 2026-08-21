import {
  type BrowserElement,
  type BrowserObservation,
  isCredentialElement,
} from "../contracts/observation.ts";
import type { TakeoverReason } from "../contracts/takeover.ts";

const START = "(?<![a-z0-9])";
const END = "(?![a-z0-9])";
const SEP = "[ _-]?";

function words(...alternatives: string[]): RegExp {
  return new RegExp(`${START}(?:${alternatives.join("|")})${END}`, "i");
}

const PASSWORD_PATTERN = words(
  `pass${SEP}word`,
  `pass${SEP}phrase`,
  `pass${SEP}code`,
  `current${SEP}password`,
  `new${SEP}password`,
  `confirm${SEP}password`,
);

const PASSKEY_PATTERN = words(
  `pass${SEP}key`,
  "webauthn",
  `security${SEP}key`,
  `hardware${SEP}key`,
  "yubikey",
  `face${SEP}id`,
  `touch${SEP}id`,
  "biometric\\w*",
);

const MFA_PATTERN = words(
  "otp",
  "totp",
  `one${SEP}time${SEP}(?:code|password|pin)`,
  `verification${SEP}code`,
  `auth(?:entication)?${SEP}code`,
  `confirmation${SEP}code`,
  `security${SEP}code`,
  "mfa",
  "2fa",
  `two${SEP}factor`,
  `multi${SEP}factor`,
  `sms${SEP}code`,
  `backup${SEP}code`,
  `recovery${SEP}code`,
  `security${SEP}(?:question|answer)`,
);

const CAPTCHA_PATTERN = words(
  "captcha",
  "recaptcha",
  "hcaptcha",
  "turnstile",
  `i'?m${SEP}not${SEP}a${SEP}robot`,
  `human${SEP}verification`,
  `verify${SEP}you${SEP}are${SEP}human`,
  `prove${SEP}you${SEP}are${SEP}human`,
);

const LOGIN_PATTERN = words(
  `sign${SEP}in`,
  `log${SEP}in`,
  "login",
  "signin",
  `sign${SEP}on`,
  "sso",
  "authenticate",
  `continue${SEP}with${SEP}(?:google|apple|microsoft|github|facebook)`,
);

const OTP_INPUT_TYPES = new Set(["one-time-code", "otp"]);

export interface TakeoverRequirement {
  required: boolean;
  reason?: TakeoverReason | undefined;
  evidence: string[];
}

const NOT_REQUIRED: TakeoverRequirement = { required: false, evidence: [] };

function textOf(element: BrowserElement): string {
  return [
    element.name,
    element.label,
    element.placeholder,
    element.description,
    element.role,
    element.inputType,
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" • ");
}

// SECURITY §8/BD14. Derived from observed attributes only: a page cannot suppress a
// takeover by relabelling a control, because every signal here is additive and the
// contract's own credential test is treated as a floor.
export function detectTakeover(element: BrowserElement): TakeoverRequirement {
  const text = textOf(element);
  const inputType = element.inputType?.toLowerCase();
  const evidence: string[] = [];
  let reason: TakeoverReason | undefined;

  const claim = (candidate: TakeoverReason, note: string) => {
    evidence.push(note);
    reason ??= candidate;
  };

  if (CAPTCHA_PATTERN.test(text) || element.risk?.includes("captcha") === true) {
    claim("captcha", "captcha challenge");
  }
  if (inputType === "password") claim("password", "password input type");
  if (PASSWORD_PATTERN.test(text)) claim("password", "password-shaped label");
  if (PASSKEY_PATTERN.test(text)) claim("passkey", "passkey or biometric prompt");
  if (inputType !== undefined && OTP_INPUT_TYPES.has(inputType)) {
    claim("mfa", "one-time-code input type");
  }
  if (MFA_PATTERN.test(text)) claim("mfa", "one-time code, MFA or security question");
  if (element.risk?.includes("password") === true) claim("password", "driver flagged a credential");
  if (element.risk?.includes("authentication") === true) {
    claim("login", "driver flagged authentication");
  }
  if (isCredentialElement(element)) claim("password", "credential-shaped control");
  if (LOGIN_PATTERN.test(text)) claim("login", "login control");

  if (reason === undefined) return NOT_REQUIRED;
  return { required: true, reason, evidence };
}

const REASON_PRIORITY: TakeoverReason[] = ["captcha", "password", "passkey", "mfa", "login"];

export function detectObservationTakeover(observation: BrowserObservation): TakeoverRequirement {
  const evidence: string[] = [];
  const reasons = new Set<TakeoverReason>();
  for (const element of observation.elements) {
    const requirement = detectTakeover(element);
    if (!requirement.required || requirement.reason === undefined) continue;
    reasons.add(requirement.reason);
    for (const note of requirement.evidence) evidence.push(`${element.ref}: ${note}`);
  }
  const reason = REASON_PRIORITY.find((candidate) => reasons.has(candidate));
  if (reason === undefined) return NOT_REQUIRED;
  return { required: true, reason, evidence };
}

export function takeoverInstructions(reason: TakeoverReason): string {
  switch (reason) {
    case "password":
      return "Type your password in the visible browser. Mu will not accept it and will not screenshot while it is on screen.";
    case "passkey":
      return "Complete the passkey or biometric prompt in the visible browser, then resume.";
    case "mfa":
      return "Enter the one-time code or security answer in the visible browser, then resume.";
    case "captcha":
      return "Complete the challenge in the visible browser yourself; Mu does not solve or bypass them.";
    case "login":
      return "Sign in in the visible browser, then resume so Mu can observe the page again.";
    case "ambiguous-action":
      return "Mu could not tell which control is correct. Choose it in the visible browser, then resume.";
    case "unsupported-ui":
      return "This interface is outside what Mu can drive semantically. Operate it in the visible browser, then resume.";
    case "user-requested":
      return "Automation is paused. Use the visible browser, then resume when you are ready.";
  }
}

// SECURITY §8: a resume performs a fresh observation, so every ref minted before the
// takeover is invalid. Nothing may be carried across.
export interface ResumeRequirements {
  reobserve: true;
  invalidateRefs: true;
  suppressScreenshotsDuring: boolean;
}

export function resumeRequirements(reason: TakeoverReason): ResumeRequirements {
  return {
    reobserve: true,
    invalidateRefs: true,
    suppressScreenshotsDuring: (["password", "passkey", "mfa", "captcha", "login"] as const).some(
      (candidate) => candidate === reason,
    ),
  };
}
