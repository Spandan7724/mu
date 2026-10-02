import type { CheckpointDiffFile } from "./checkpoint.ts";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  permission: string; // tool name or category, wildcard ok: "bash", "mcp_*"
  pattern: string; // arg-derived pattern, wildcard ok: "publish *", "*"
  action: PermissionAction;
}

export interface PermissionRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  permission: string; // evaluated scope; may be narrower than toolName
  pattern: string; // what was matched, e.g. the command being run
  description: string; // human-readable summary for UI
  preview?: PermissionPreview;
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
    return [`${preview.file.path} +${preview.file.added} -${preview.file.removed}`];
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

// Glob with `*` as the only wildcard; anchored at both ends.
function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

// Flatten layered rulesets (profile ← user ← project ← run), LAST match wins,
// default "ask".
export function evaluate(
  rules: PermissionRule[],
  permission: string | readonly string[],
  pattern: string,
): PermissionAction {
  const permissions = typeof permission === "string" ? [permission] : permission;
  let action: PermissionAction = "ask";
  for (const rule of rules) {
    if (
      permissions.some((candidate) => matches(rule.permission, candidate)) &&
      matches(rule.pattern, pattern)
    ) {
      action = rule.action;
    }
  }
  return action;
}
