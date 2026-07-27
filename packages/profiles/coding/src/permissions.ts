import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PermissionMode, PermissionRule } from "@mu/core";

// Reads allow; anything that writes or executes asks. This is the restrictive
// layer the bare SDK deliberately does not have — it lives here because
// only a domain knows which of its tools are dangerous.
export const CODING_PERMISSION_DEFAULTS: PermissionRule[] = [
  { permission: "*", pattern: "*", action: "ask" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "ls", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "todo", pattern: "*", action: "allow" },
  { permission: "task_output", pattern: "*", action: "allow" },
  { permission: "task_list", pattern: "*", action: "allow" },
];

export const CODING_PERMISSION_MODES: PermissionMode[] = [
  {
    id: "default",
    label: "default",
    description: "Read freely; ask before edits and commands.",
    rules: [],
  },
  {
    id: "accept-edits",
    label: "accept edits",
    description: "Read and edit files freely; ask before commands.",
    rules: [
      { permission: "write", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
    ],
  },
  {
    id: "plan-readonly",
    label: "plan (read-only)",
    description: "Allow inspection and planning; deny file, command, and task mutations.",
    rules: [
      { permission: "write", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "task_write_stdin", pattern: "*", action: "deny" },
      { permission: "task_kill", pattern: "*", action: "deny" },
      { permission: "task_detach", pattern: "*", action: "deny" },
    ],
  },
  {
    id: "yolo",
    label: "full access",
    description: "Allow every tool call without asking.",
    rules: [{ permission: "*", pattern: "*", action: "allow" }],
  },
];

export interface ProjectConfig {
  permissions?: PermissionRule[];
  model?: string;
}

export function configPath(root: string): string {
  return join(root, ".mu", "config.json");
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  try {
    const raw = await readFile(configPath(root), "utf8");
    const parsed = JSON.parse(raw) as ProjectConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

// Layered: profile defaults ← project config ← per-run. Later layers win
// because evaluation takes the LAST matching rule.
export function layerPermissions(...layers: (PermissionRule[] | undefined)[]): PermissionRule[] {
  return layers.flatMap((layer) => layer ?? []);
}

// "Always allow" replies persist into the project config so the answer sticks
// across sessions.
export async function rememberAllow(
  root: string,
  permission: string,
  pattern: string,
): Promise<void> {
  const path = configPath(root);
  const config = await loadProjectConfig(root);
  const rules = config.permissions ?? [];
  const exists = rules.some(
    (rule) => rule.permission === permission && rule.pattern === pattern && rule.action === "allow",
  );
  if (!exists) rules.push({ permission, pattern, action: "allow" });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...config, permissions: rules }, null, 2)}\n`, "utf8");
}
