import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PermissionMode, PermissionRule, SavedPermissionRule } from "@mu/core";
import { z } from "zod";
import type { InstructionSettings } from "./context.ts";

export const CODING_PERMISSION_DEFAULTS: PermissionRule[] = [
  { permission: "*", pattern: "*", action: "ask" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "ls", pattern: "*", action: "allow" },
  { permission: "todo", pattern: "*", action: "allow" },
  { permission: "task_output", pattern: "*", action: "allow" },
  { permission: "task_list", pattern: "*", action: "allow" },
  { permission: "bash:inspect", pattern: "*", action: "allow" },
  { permission: "task", pattern: "*", action: "allow" },
  { permission: "subagent_status", pattern: "*", action: "allow" },
  { permission: "subagent_send", pattern: "*", action: "allow" },
  { permission: "subagent_stop", pattern: "*", action: "allow" },
  { permission: "search", pattern: "*", action: "allow" },
  { permission: "counsel", pattern: "*", action: "allow" },
  { permission: "skill", pattern: "*", action: "allow" },
  { permission: "mcp_open", pattern: "*", action: "allow" },
  { permission: "mcp_describe", pattern: "*", action: "allow" },
];

const MODES: PermissionMode[] = [
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
    tone: "permissive",
    rules: [
      { permission: "write", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
    ],
  },
  {
    id: "plan-readonly",
    label: "plan (read-only)",
    description: "Allow inspection and planning; deny file, command, and task mutations.",
    tone: "restrictive",
    rules: [
      { permission: "write", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash:inspect", pattern: "*", action: "allow" },
      { permission: "task_write_stdin", pattern: "*", action: "deny" },
      { permission: "task_kill", pattern: "*", action: "deny" },
      { permission: "task_detach", pattern: "*", action: "deny" },
    ],
  },
  {
    id: "yolo",
    label: "full access",
    description: "Allow every tool call without asking, except configured denies.",
    tone: "unrestricted",
    rules: [{ permission: "*", pattern: "*", action: "allow" }],
  },
];

// Configured denies hold in every mode, so full access cannot override a
// project's `git push *: deny`.
export function codingPermissionModes(configured: PermissionRule[] = []): PermissionMode[] {
  const denies = configured.filter((rule) => rule.action === "deny");
  return MODES.map((mode) => ({ ...mode, rules: [...mode.rules, ...denies] }));
}

export const CODING_PERMISSION_MODES: PermissionMode[] = codingPermissionModes();

export interface ProjectConfig {
  permissions?: PermissionRule[];
  model?: string;
  instructions?: InstructionSettings;
  checkpoints?: {
    enabled?: boolean | undefined;
    include?: string[] | undefined;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const permissionRuleSchema = z.object({
  permission: z.string().min(1),
  pattern: z.string(),
  action: z.enum(["allow", "ask", "deny"]),
});

export const instructionSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  fallbackFilenames: z.array(z.string().min(1)).optional(),
  projectRootMarkers: z.array(z.string().min(1)).optional(),
  imports: z.boolean().optional(),
  claudeRules: z.boolean().optional(),
});

export const checkpointSettingsSchema = z
  .object({ enabled: z.boolean().optional(), include: z.array(z.string().min(1)).optional() })
  .loose();

const projectConfigSchema = z
  .object({
    permissions: z.array(permissionRuleSchema).optional(),
    model: z.string().min(1).optional(),
    instructions: instructionSettingsSchema.optional(),
    checkpoints: checkpointSettingsSchema.optional(),
  })
  .loose();

export function configPath(root: string): string {
  return join(root, ".mu", "config.json");
}

export async function loadProjectConfig(
  root: string,
  onWarning?: (message: string) => void,
): Promise<ProjectConfig> {
  try {
    const raw = await readFile(configPath(root), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const result = projectConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid project config at ${configPath(root)}: ${issues}`);
    }
    const { permissions, model, instructions, checkpoints, ...rest } = result.data;
    const normalizedInstructions: InstructionSettings | undefined = instructions
      ? {
          ...(instructions.enabled !== undefined ? { enabled: instructions.enabled } : {}),
          ...(instructions.fallbackFilenames !== undefined
            ? { fallbackFilenames: instructions.fallbackFilenames }
            : {}),
          ...(instructions.projectRootMarkers !== undefined
            ? { projectRootMarkers: instructions.projectRootMarkers }
            : {}),
          ...(instructions.imports !== undefined ? { imports: instructions.imports } : {}),
          ...(instructions.claudeRules !== undefined
            ? { claudeRules: instructions.claudeRules }
            : {}),
        }
      : undefined;
    return {
      ...rest,
      ...(permissions !== undefined ? { permissions } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(normalizedInstructions !== undefined ? { instructions: normalizedInstructions } : {}),
      ...(checkpoints !== undefined ? { checkpoints } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (!onWarning) throw error;
    onWarning(error instanceof Error ? error.message : String(error));
    return {};
  }
}

// Later layers win because evaluation takes the LAST matching rule.
export function layerPermissions(...layers: (PermissionRule[] | undefined)[]): PermissionRule[] {
  return layers.flatMap((layer) => layer ?? []);
}

export function localConfigPath(root: string): string {
  return join(root, ".mu", "config.local.json");
}

const permissionsFileSchema = z
  .object({ permissions: z.array(permissionRuleSchema).optional() })
  .loose();

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return undefined;
  }
}

// Rules kept under `permissions` in any mu config file (user, project, local).
export async function loadPermissionsFile(
  path: string,
  onWarning?: (message: string) => void,
): Promise<PermissionRule[]> {
  const raw = await readJsonObject(path);
  const result = raw ? permissionsFileSchema.safeParse(raw) : undefined;
  if (!result?.success) {
    onWarning?.(`Ignoring invalid permissions in ${path}`);
    return [];
  }
  return result.data.permissions ?? [];
}

async function writePermissions(path: string, rules: PermissionRule[]): Promise<void> {
  const raw = await readJsonObject(path);
  if (!raw) throw new Error(`Cannot update ${path}: it is not a valid config file`);
  const { permissions: _old, ...rest } = raw;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(rules.length > 0 ? { ...rest, permissions: rules } : rest, null, 2)}\n`,
    "utf8",
  );
}

// Answers belong to this user on this machine, not to the shared project
// config, so .mu ignores the file.
async function ignoreLocalConfig(root: string): Promise<void> {
  const path = join(root, ".mu", ".gitignore");
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  if (current.split(/\r?\n/).includes("config.local.json")) return;
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  await writeFile(path, `${prefix}config.local.json\n`, "utf8");
}

// "Always allow" replies persist into the project's local config so the answer
// sticks across sessions.
export async function rememberAllow(
  root: string,
  permission: string,
  pattern: string,
): Promise<void> {
  const path = localConfigPath(root);
  const rules = await loadPermissionsFile(path);
  const exists = rules.some(
    (rule) => rule.permission === permission && rule.pattern === pattern && rule.action === "allow",
  );
  if (exists) return;
  await writePermissions(path, [...rules, { permission, pattern, action: "allow" }]);
  await ignoreLocalConfig(root);
}

export async function savedPermissions(paths: string[]): Promise<SavedPermissionRule[]> {
  const lists = await Promise.all(
    paths.map(async (path) =>
      (await loadPermissionsFile(path)).map((rule) => ({ ...rule, source: path })),
    ),
  );
  return lists.flat();
}

export async function forgetPermission(rule: SavedPermissionRule): Promise<void> {
  const rules = await loadPermissionsFile(rule.source);
  const index = rules.findLastIndex(
    (candidate) =>
      candidate.permission === rule.permission &&
      candidate.pattern === rule.pattern &&
      candidate.action === rule.action,
  );
  if (index === -1) return;
  await writePermissions(rule.source, rules.toSpliced(index, 1));
}

// Paths added with /track: recorded by checkpoints even when ignored.
export async function saveCheckpointIncludes(root: string, include: string[]): Promise<void> {
  const path = configPath(root);
  const config = await loadProjectConfig(root);
  const { include: _previous, ...checkpoints } = config.checkpoints ?? {};
  const next = include.length > 0 ? { ...checkpoints, include } : checkpoints;
  const { checkpoints: _old, ...rest } = config;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(Object.keys(next).length > 0 ? { ...rest, checkpoints: next } : rest, null, 2)}\n`,
    "utf8",
  );
}
