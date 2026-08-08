import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PermissionMode, PermissionRule } from "@mu/core";
import { z } from "zod";
import type { InstructionSettings } from "./context.ts";

export const CODING_PERMISSION_DEFAULTS: PermissionRule[] = [
  { permission: "*", pattern: "*", action: "ask" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "ls", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "todo", pattern: "*", action: "allow" },
  { permission: "task_output", pattern: "*", action: "allow" },
  { permission: "task_list", pattern: "*", action: "allow" },
  { permission: "bash:inspect", pattern: "*", action: "allow" },
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
    description: "Allow every tool call without asking.",
    tone: "unrestricted",
    rules: [{ permission: "*", pattern: "*", action: "allow" }],
  },
];

export interface ProjectConfig {
  permissions?: PermissionRule[];
  model?: string;
  instructions?: InstructionSettings;
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

const projectConfigSchema = z
  .object({
    permissions: z.array(permissionRuleSchema).optional(),
    model: z.string().min(1).optional(),
    instructions: instructionSettingsSchema.optional(),
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
    const { permissions, model, instructions, ...rest } = result.data;
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
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (!onWarning) throw error;
    onWarning(error instanceof Error ? error.message : String(error));
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
