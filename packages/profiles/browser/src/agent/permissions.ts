import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PermissionMode, PermissionRule } from "@mu/core";
import { z } from "zod";

export const SCOPES = {
  observe: "browser:observe",
  navigate: "browser:navigate",
  interact: "browser:interact",
  commit: "browser:commit",
  secret: "browser:secret",
  upload: "browser:upload",
  script: "browser:script",
} as const;

const rule = (
  permission: string,
  action: PermissionRule["action"],
  pattern = "*",
): PermissionRule => ({
  permission,
  pattern,
  action,
});

export const BROWSER_PERMISSION_DEFAULTS: PermissionRule[] = [
  rule("*", "ask"),
  rule(SCOPES.observe, "allow"),
  rule(SCOPES.navigate, "allow"),
  rule(SCOPES.interact, "allow"),
  rule(SCOPES.commit, "ask"),
  rule(SCOPES.secret, "ask"),
  rule(SCOPES.upload, "ask"),
  rule(SCOPES.script, "ask"),
  rule("notes", "allow"),
  rule("todo", "allow"),
];

// allowedHosts/blockedHosts hold in every mode, so they close every mode's rule list.
export function hostRules(allowedHosts: string[], blockedHosts: string[]): PermissionRule[] {
  return [
    ...(allowedHosts.length > 0 ? [rule(SCOPES.navigate, "deny")] : []),
    ...allowedHosts.map((host) => rule(SCOPES.navigate, "allow", host)),
    ...blockedHosts.map((host) => rule(SCOPES.navigate, "deny", host)),
  ];
}

export function browserPermissionModes(hosts: PermissionRule[] = []): PermissionMode[] {
  const gated = [SCOPES.commit, SCOPES.secret, SCOPES.upload, SCOPES.script];
  return [
    {
      id: "default",
      label: "default",
      description:
        "Browse and interact freely; ask before sending, buying, deleting, secrets, uploads and scripts.",
      rules: [...hosts],
    },
    {
      id: "supervised",
      label: "supervised",
      description: "Ask before every navigation and interaction.",
      tone: "restrictive",
      rules: [
        rule(SCOPES.navigate, "ask"),
        rule(SCOPES.interact, "ask"),
        ...gated.map((scope) => rule(scope, "ask")),
        ...hosts,
      ],
    },
    {
      id: "read-only",
      label: "read-only",
      description: "Look and navigate only; deny clicks, typing and every consequential action.",
      tone: "restrictive",
      rules: [
        rule(SCOPES.interact, "deny"),
        ...gated.map((scope) => rule(scope, "deny")),
        ...hosts,
      ],
    },
    {
      id: "autonomous",
      label: "autonomous",
      description: "Allow everything, including sending, buying and deleting, without asking.",
      tone: "unrestricted",
      rules: [rule("*", "allow"), ...hosts],
    },
  ];
}

const rememberedSchema = z.object({
  rules: z.array(
    z.object({
      permission: z.string().min(1),
      pattern: z.string(),
      action: z.literal("allow"),
    }),
  ),
});

export function rememberedPermissionsPath(home: string): string {
  return join(home, ".mu", "browser", "permissions.json");
}

export function loadRememberedPermissions(
  home: string,
  onWarning: (message: string) => void = () => {},
): PermissionRule[] {
  const path = rememberedPermissionsPath(home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = rememberedSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.rules;
    onWarning(`Ignoring invalid browser permissions at ${path}`);
  } catch (error) {
    onWarning(
      `Ignoring invalid browser permissions at ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
  return [];
}

// "Always allow" is host-scoped: the pattern is the page (or target) host.
export function rememberAllow(home: string, permission: string, pattern: string): PermissionRule[] {
  const rules = loadRememberedPermissions(home);
  if (
    !rules.some((existing) => existing.permission === permission && existing.pattern === pattern)
  ) {
    rules.push({ permission, pattern, action: "allow" });
  }
  const path = rememberedPermissionsPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ rules }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return rules;
}
