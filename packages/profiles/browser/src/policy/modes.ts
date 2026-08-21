import { evaluate, type PermissionAction, type PermissionRule } from "@mu/core";
import { AUTONOMOUS_SUBMIT_INTENTS } from "../contracts/intent.ts";
import {
  type AuthorityContext,
  assertPolicyAuthority,
  isAuthorityActive,
  type PolicyAuthority,
} from "./authority.ts";
import {
  type BrowserScope,
  NEVER_AUTO_ALLOWED_SCOPES,
  originPattern,
  scopeForIntent,
} from "./scopes.ts";

// BD13. There is deliberately no fourth member: SECURITY §9 states there is no global
// full-access mode in v1, and adding one requires a new BD* decision.
export type BrowserPermissionMode =
  | "confirm-submission"
  | "confirm-every-write"
  | "autonomous-submit";

export const BROWSER_PERMISSION_MODES: readonly BrowserPermissionMode[] = [
  "confirm-submission",
  "confirm-every-write",
  "autonomous-submit",
];

export const DEFAULT_BROWSER_PERMISSION_MODE: BrowserPermissionMode = "confirm-submission";

function rule(permission: BrowserScope, pattern: string, action: PermissionAction): PermissionRule {
  return { permission, pattern, action };
}

const BASE_RULES: readonly PermissionRule[] = [
  rule("browser:observe", "*", "allow"),
  rule("browser:navigate", "*", "allow"),
  rule("browser:new-origin", "*", "ask"),
  rule("browser:interact", "*", "allow"),
  rule("browser:disclose", "*", "ask"),
  rule("browser:upload", "*", "ask"),
  rule("browser:submit", "*", "ask"),
  rule("browser:send", "*", "ask"),
  rule("browser:purchase", "*", "ask"),
  rule("browser:delete", "*", "ask"),
  rule("browser:consent", "*", "ask"),
  rule("browser:account-change", "*", "ask"),
];

// BD13: autonomous-submit is authority a user grants to a named task for named
// origins. The grant carries its own scope so it expires with the task or session
// rather than persisting as a preference.
export interface AutonomousSubmitGrant {
  readonly origins: readonly string[];
  readonly authority: PolicyAuthority;
}

export function autonomousSubmitGrant(
  origins: readonly string[],
  authority: unknown,
): AutonomousSubmitGrant {
  assertPolicyAuthority(authority, "granting autonomous submission");
  return { origins: [...origins], authority };
}

export function isGrantActive(
  grant: AutonomousSubmitGrant | undefined,
  context: AuthorityContext = {},
): boolean {
  return grant !== undefined && isAuthorityActive(grant.authority, context);
}

export interface ModeRuleOptions {
  grant?: AutonomousSubmitGrant | undefined;
  context?: AuthorityContext | undefined;
}

export function browserPermissionRules(
  mode: BrowserPermissionMode,
  options: ModeRuleOptions = {},
): PermissionRule[] {
  const rules = [...BASE_RULES];

  if (mode === "confirm-every-write") {
    rules.push(rule("browser:interact", "*", "ask"));
    return rules;
  }

  if (mode !== "autonomous-submit") return rules;

  if (!isGrantActive(options.grant, options.context ?? {})) return rules;
  const grant = options.grant as AutonomousSubmitGrant;
  for (const origin of grant.origins) {
    const pattern = originPattern(origin);
    for (const intent of AUTONOMOUS_SUBMIT_INTENTS) {
      rules.push(rule(scopeForIntent(intent), `${pattern} *`, "allow"));
    }
  }
  return rules;
}

export type ClampReason =
  | "never-auto-allowed"
  | "unknown-risk"
  | "authentication-boundary"
  | "unapproved-origin";

export interface BrowserPermissionInput {
  mode: BrowserPermissionMode;
  scopes: readonly BrowserScope[];
  pattern: string;
  rules?: readonly PermissionRule[] | undefined;
  grant?: AutonomousSubmitGrant | undefined;
  context?: AuthorityContext | undefined;
  /** True when the classifier could not name the operation. Fails closed. */
  unknownRisk?: boolean | undefined;
  /** True when the destination origin has not been approved for this task. */
  originApproved?: boolean | undefined;
}

export interface BrowserPermissionDecision {
  action: PermissionAction;
  scopes: readonly BrowserScope[];
  pattern: string;
  clamped: ClampReason[];
}

// The clamp is the reason a smuggled or over-broad rule cannot buy authority the
// product does not offer. Rules may always tighten a decision; they may only loosen
// one where SECURITY §9 permits it.
export function evaluateBrowserPermission(
  input: BrowserPermissionInput,
): BrowserPermissionDecision {
  const rules = [
    ...browserPermissionRules(input.mode, {
      ...(input.grant === undefined ? {} : { grant: input.grant }),
      ...(input.context === undefined ? {} : { context: input.context }),
    }),
    ...(input.rules ?? []),
  ];

  let action = evaluate(rules, input.scopes, input.pattern);
  const clamped: ClampReason[] = [];

  const escalate = (reason: ClampReason) => {
    if (action === "allow") {
      action = "ask";
      clamped.push(reason);
    }
  };

  if (input.scopes.some((scope) => NEVER_AUTO_ALLOWED_SCOPES.includes(scope))) {
    escalate("never-auto-allowed");
  }
  if (input.unknownRisk === true) escalate("unknown-risk");
  if (input.originApproved === false) escalate("unapproved-origin");

  return { action, scopes: input.scopes, pattern: input.pattern, clamped };
}

// SECURITY §9 again, as an assertion a later lane can run over loaded configuration.
export function findFullAccessRules(rules: readonly PermissionRule[]): PermissionRule[] {
  return rules.filter(
    (candidate) =>
      candidate.action === "allow" &&
      NEVER_AUTO_ALLOWED_SCOPES.some(
        (scope) => candidate.permission === scope || candidate.permission === "browser:*",
      ),
  );
}
