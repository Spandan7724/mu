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
  pattern: string; // what was matched, e.g. the command being run
  description: string; // human-readable summary for UI
  preview?: unknown;
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
  permission: string,
  pattern: string,
): PermissionAction {
  let action: PermissionAction = "ask";
  for (const rule of rules) {
    if (matches(rule.permission, permission) && matches(rule.pattern, pattern)) {
      action = rule.action;
    }
  }
  return action;
}
