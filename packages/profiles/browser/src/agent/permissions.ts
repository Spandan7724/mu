import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evaluate, type PermissionMode, type PermissionRule } from "@mu/core";
import { z } from "zod";

export const SCOPES = {
  observe: "browser:observe",
  navigate: "browser:navigate",
  interact: "browser:interact",
  commit: "browser:commit",
  secret: "browser:secret",
  upload: "browser:upload",
  script: "browser:script",
  delegate: "browser:delegate",
  share: "browser:share",
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
  rule(SCOPES.delegate, "ask"),
  rule(SCOPES.share, "ask"),
  rule("notes", "allow"),
  rule("todo", "allow"),
  // Parallel sub-tasks: starting one asks nothing; each of its actions is gated as usual.
  rule("task", "allow"),
  // Files in the agent's own folder: reading is free, changing them asks, except
  // its own progress records under progress/.
  rule("ls", "allow"),
  rule("read", "allow"),
  rule("write", "allow", "progress/*"),
  rule("edit", "allow", "progress/*"),
];

// allowedHosts/blockedHosts hold in every mode, so they close every mode's rule list.
// An allowlist still permits about:blank, which holds nothing from any site.
export function hostRules(allowedHosts: string[], blockedHosts: string[]): PermissionRule[] {
  return [
    ...(allowedHosts.length > 0
      ? [rule(SCOPES.navigate, "deny"), rule(SCOPES.navigate, "allow", "about:blank")]
      : []),
    ...allowedHosts.map((host) => rule(SCOPES.navigate, "allow", host)),
    ...blockedHosts.map((host) => rule(SCOPES.navigate, "deny", host)),
  ];
}

export interface HostLists {
  allowedHosts: string[];
  blockedHosts: string[];
}

export function restrictsHosts(lists: HostLists): boolean {
  return lists.allowedHosts.length > 0 || lists.blockedHosts.length > 0;
}

// Whether allowedHosts/blockedHosts let a tab be on `url`, judged by the same rules as
// navigation permissions. Pages that are not on the web (about:blank, error pages) hold
// nothing from any site and are always allowed.
export function hostAllowed(url: string, lists: HostLists): boolean {
  if (!restrictsHosts(lists) || !/^https?:/i.test(url)) return true;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  const rules = [
    rule(SCOPES.navigate, "allow"),
    ...hostRules(lists.allowedHosts, lists.blockedHosts),
  ];
  return evaluate(rules, SCOPES.navigate, host) !== "deny";
}

export function browserPermissionModes(hosts: PermissionRule[] = []): PermissionMode[] {
  const gated = [
    SCOPES.commit,
    SCOPES.secret,
    SCOPES.upload,
    SCOPES.script,
    SCOPES.delegate,
    SCOPES.share,
  ];
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
        rule("write", "deny"),
        rule("edit", "deny"),
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
