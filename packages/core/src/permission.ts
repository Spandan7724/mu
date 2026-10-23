import type { CheckpointDiffFile } from "./checkpoint.ts";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  permission: string; // tool name or category, wildcard ok: "bash", "mcp_*"
  pattern: string; // arg-derived pattern, wildcard ok: "publish *", "*"
  action: PermissionAction;
}

// A configured rule and where it is kept (a profile-defined location such as a
// file path), for listing and removal.
export interface SavedPermissionRule extends PermissionRule {
  source: string;
}

export interface PermissionRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  permission: string; // evaluated scope; may be narrower than toolName
  pattern: string; // what was matched, e.g. the command being run
  description: string; // human-readable summary for UI
  preview?: PermissionPreview;
  // Rules an "allow for this session" or "always allow" reply adds. Absent, the
  // reply adds { permission, pattern }.
  allowRules?: { permission: string; pattern: string }[];
}

// What a surface answers. A message tells the model why, or what to do instead.
export type PermissionReply =
  | "allow"
  | "deny"
  | { outcome: "allow" | "deny"; message?: string | undefined };

export function permissionOutcome(reply: PermissionReply): {
  outcome: "allow" | "deny";
  message?: string;
} {
  if (typeof reply === "string") return { outcome: reply };
  const message = reply.message?.trim();
  return { outcome: reply.outcome === "allow" ? "allow" : "deny", ...(message ? { message } : {}) };
}

// One value a call is judged by. A tool may name several, such as each command
// of a compound shell line; a call is allowed only when every target is.
export interface PermissionTarget {
  permission?: string; // narrower scope; the tool name still matches
  pattern: string;
  // Only a lone "*" or an identical pattern matches: a prefix proves nothing
  // about this value.
  exact?: boolean;
  // Pattern an allow-session/always reply saves instead of `pattern`.
  remember?: string;
}

export type PermissionPreview =
  | { kind: "text"; lines: string[] }
  | { kind: "diff"; file: CheckpointDiffFile }
  | { kind: "fields"; sections: PermissionSection[] };

// Labelled values for an approval whose subject is what an action will send or
// change rather than a command or a file. An empty label continues the value
// above it.
export interface PermissionField {
  label: string;
  value: string;
}

export interface PermissionSection {
  title?: string;
  fields: PermissionField[];
}

// Any preview as plain lines, for surfaces that only show text.
export function permissionPreviewLines(preview: PermissionPreview | undefined): string[] {
  if (!preview) return [];
  if (preview.kind === "text") return preview.lines;
  if (preview.kind === "diff") {
    return [`${preview.file.path} +${preview.file.added} −${preview.file.removed}`];
  }
  return preview.sections.flatMap((section) => {
    const indent = section.title ? "  " : "";
    return [
      ...(section.title ? [`${section.title}:`] : []),
      ...section.fields.map((field) =>
        field.label ? `${indent}${field.label}: ${field.value}` : `  ${field.value}`,
      ),
    ];
  });
}

export interface ToolPermissionDetails {
  description?: string;
  preview?: PermissionPreview;
}

const escapeGlob = (glob: string) =>
  glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

// Glob with `*` as the only wildcard; anchored at both ends. A trailing " *"
// also matches nothing, so "publish draft *" covers a bare "publish draft".
function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const source = pattern.endsWith(" *")
    ? `${escapeGlob(pattern.slice(0, -2))}(?: .*)?`
    : escapeGlob(pattern);
  return new RegExp(`^${source}$`, "s").test(value);
}

// Flatten layered rulesets (profile ← user ← project ← run), LAST match wins,
// default "ask".
export function evaluate(
  rules: PermissionRule[],
  permission: string | readonly string[],
  pattern: string,
  options: { exact?: boolean | undefined } = {},
): PermissionAction {
  const permissions = typeof permission === "string" ? [permission] : permission;
  let action: PermissionAction = "ask";
  for (const rule of rules) {
    if (
      permissions.some((candidate) => matches(rule.permission, candidate)) &&
      (options.exact
        ? rule.pattern === "*" || rule.pattern === pattern
        : matches(rule.pattern, pattern))
    ) {
      action = rule.action;
    }
  }
  return action;
}

// Any target denied denies the call; every target allowed allows it; otherwise
// it asks about the targets that were not allowed.
export function evaluateTargets(
  rules: PermissionRule[],
  toolName: string,
  targets: readonly PermissionTarget[],
): { action: PermissionAction; asked: PermissionTarget[] } {
  const asked: PermissionTarget[] = [];
  for (const target of targets) {
    const scopes =
      target.permission && target.permission !== toolName
        ? [toolName, target.permission]
        : [toolName];
    const action = evaluate(rules, scopes, target.pattern, { exact: target.exact });
    if (action === "deny") return { action, asked: [] };
    if (action === "ask") asked.push(target);
  }
  return { action: asked.length > 0 ? "ask" : "allow", asked };
}
