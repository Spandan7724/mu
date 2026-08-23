import type { BrowserAction } from "../contracts/actions.ts";
import { permissionScopeForIntent, type SubmitIntent } from "../contracts/intent.ts";
import type { BrowserElement } from "../contracts/observation.ts";
import { type ActionRiskClass, classifyElement } from "./risk.ts";

// TOOLS.md's permission projections. Every browser tool call resolves to one of these.
export const BROWSER_SCOPES = [
  "browser:observe",
  "browser:takeover",
  "browser:navigate",
  "browser:new-origin",
  "browser:interact",
  "browser:disclose",
  "browser:upload",
  "browser:submit",
  "browser:send",
  "browser:purchase",
  "browser:delete",
  "browser:consent",
  "browser:account-change",
] as const;

export type BrowserScope = (typeof BROWSER_SCOPES)[number];

export const COMMITMENT_SCOPES: readonly BrowserScope[] = [
  "browser:submit",
  "browser:send",
  "browser:purchase",
  "browser:delete",
  "browser:consent",
  "browser:account-change",
];

// SECURITY §9: these stay ask in every v1 mode. Expanding the set needs a new BD*
// decision, so the list is enforced here rather than left to configuration.
export const NEVER_AUTO_ALLOWED_SCOPES: readonly BrowserScope[] = [
  "browser:purchase",
  "browser:delete",
  "browser:account-change",
];

export function isBrowserScope(value: string): value is BrowserScope {
  return (BROWSER_SCOPES as readonly string[]).includes(value);
}

export function scopeForIntent(intent: SubmitIntent): BrowserScope {
  const scope = permissionScopeForIntent(intent);
  if (!isBrowserScope(scope)) throw new TypeError(`unmapped submit intent ${intent}`);
  return scope;
}

export const UNKNOWN_ORIGIN_PATTERN = "unknown-origin";

// Patterns are matched against permission rules and are what a remembered rule is
// built from, so page-derived text is stripped of glob metacharacters first: a button
// accessibly named "*" must not become a rule that matches every control on the site.
export function sanitizePatternPart(value: string | undefined, max = 120): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value
    .replace(/[*?[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export function originPattern(origin: string | undefined): string {
  const cleaned = sanitizePatternPart(origin);
  return cleaned ?? UNKNOWN_ORIGIN_PATTERN;
}

function joinPattern(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(" ");
}

export function observePattern(origin: string | undefined): string {
  return originPattern(origin);
}

export function navigatePattern(destinationOrigin: string | undefined): string {
  return originPattern(destinationOrigin);
}

/** TOOLS.md browser_act: `<origin> <field-label-or-role>`. */
export function actPattern(origin: string | undefined, element?: BrowserElement): string {
  const label = sanitizePatternPart(element?.label ?? element?.name ?? element?.role);
  return joinPattern([originPattern(origin), label ?? "control"]);
}

/** TOOLS.md browser_upload: `<origin> <document-basename>`. */
export function uploadPattern(origin: string | undefined, basename: string): string {
  return joinPattern([originPattern(origin), sanitizePatternPart(basename) ?? "document"]);
}

/** TOOLS.md browser_submit: `<origin> <intent> <action-name>`. */
export function submitPattern(
  origin: string | undefined,
  intent: SubmitIntent,
  element?: BrowserElement,
): string {
  const name = sanitizePatternPart(element?.name ?? element?.label);
  return joinPattern([originPattern(origin), intent, name ?? "control"]);
}

const CLASS_SCOPES: Record<ActionRiskClass, BrowserScope> = {
  read: "browser:observe",
  "reversible-mutation": "browser:interact",
  disclosure: "browser:disclose",
  // Authentication never resolves to a permission: it routes to takeover. The scope
  // exists only so an evaluation of it can be denied rather than defaulted.
  authentication: "browser:interact",
  commitment: "browser:submit",
  destructive: "browser:delete",
  unknown: "browser:interact",
};

export function scopeForRiskClass(value: ActionRiskClass): BrowserScope {
  return CLASS_SCOPES[value];
}

// browser_act projects to interact or disclose. It never projects to a commitment
// scope, because BD12 stops such an action before a scope is ever derived.
export function scopesForAction(action: BrowserAction, element?: BrowserElement): BrowserScope[] {
  const scopes = new Set<BrowserScope>();
  const classification = element === undefined ? undefined : classifyElement(element);
  const disclosing = action.kind === "fill" || action.kind === "type" || action.kind === "select";

  // Clicking or hovering a personal-data field tells the site nothing; only entering
  // a value does, so the disclosure scope follows the action, not the field.
  if (disclosing) scopes.add("browser:disclose");
  if (classification?.risks.includes("file-upload") === true) scopes.add("browser:upload");
  if (scopes.size === 0) scopes.add("browser:interact");
  return [...scopes];
}
