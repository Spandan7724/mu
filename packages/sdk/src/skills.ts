// Built-in extension: skills. A skill is a directory with a SKILL.md whose frontmatter
// carries a name and description. Skills installed for other agents (.agents, .claude,
// .codex, .opencode) are discovered too. The listing enters the transcript as a typed
// context snapshot; bodies load on demand through the `skill` tool.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  type AgentMessage,
  type CustomMessage,
  customMessage,
  type Extension,
  errorResult,
} from "@mu/core";
import { parseFrontmatter } from "./markdown-commands.ts";

export type SkillSource = "mu" | "agents" | "claude" | "codex" | "opencode";
export type SkillScope = "project" | "user";

export interface SkillRoot {
  directory: string;
  scope: SkillScope;
  source: SkillSource;
}

export interface Skill {
  name: string;
  description: string;
  body: string;
  directory: string;
  scope: SkillScope;
  source: SkillSource;
  // Hidden from the model's listing; the user can still invoke it.
  disableModelInvocation: boolean;
  userInvocable: boolean;
  // Parsed for display only; never pre-approves tools.
  allowedTools?: string[];
}

export interface SkillCatalog {
  skills: Skill[];
  // Lower-precedence skills hidden by a same-named skill.
  shadowed: Skill[];
  warnings: string[];
}

export interface SkillRootOptions {
  home?: string;
  // Project directories from the working directory up to the project root, deepest first.
  projectDirs?: string[];
}

const PROJECT_FOLDERS: [string, SkillSource][] = [
  [join(".mu", "skills"), "mu"],
  [join(".agents", "skills"), "agents"],
  [join(".claude", "skills"), "claude"],
  [join(".codex", "skills"), "codex"],
  [join(".opencode", "skills"), "opencode"],
  [join(".opencode", "skill"), "opencode"],
];

// Highest precedence first: project before user, mu before the shared folder before other agents.
export function skillRoots(options: SkillRootOptions = {}): SkillRoot[] {
  const home = options.home ?? homedir();
  const roots: SkillRoot[] = [];
  for (const dir of options.projectDirs ?? []) {
    for (const [folder, source] of PROJECT_FOLDERS) {
      roots.push({ directory: join(dir, folder), scope: "project", source });
    }
  }
  roots.push(
    { directory: join(home, ".mu", "skills"), scope: "user", source: "mu" },
    { directory: join(home, ".agents", "skills"), scope: "user", source: "agents" },
    { directory: join(home, ".claude", "skills"), scope: "user", source: "claude" },
    { directory: join(home, ".codex", "skills"), scope: "user", source: "codex" },
    { directory: join(home, ".config", "opencode", "skills"), scope: "user", source: "opencode" },
  );
  return roots;
}

const MAX_DEPTH = 3;
const MAX_DESCRIPTION = 1024;
const NAME = /^[a-z0-9][a-z0-9._-]*$/i;

function frontmatter(source: string): { meta: Record<string, unknown>; body: string } {
  const normalized = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { meta: {}, body: normalized.trim() };
  try {
    const parsed = Bun.YAML.parse(match[1] ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        meta: parsed as Record<string, unknown>,
        body: normalized.slice(match[0].length).trim(),
      };
    }
  } catch {
    // Hand-written frontmatter is often not strict YAML (unquoted colons); fall back.
  }
  return parseFrontmatter(normalized);
}

function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter((item) => item.trim().length > 0);
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/,(?![^(]*\))/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

export async function loadSkill(
  directory: string,
  root: Pick<SkillRoot, "scope" | "source"> = { scope: "user", source: "mu" },
): Promise<Skill | string> {
  let source: string;
  try {
    source = await readFile(join(directory, "SKILL.md"), "utf8");
  } catch (error) {
    return `${join(directory, "SKILL.md")}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const { meta, body } = frontmatter(source);
  const name =
    typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : basename(directory);
  if (!NAME.test(name)) return `${join(directory, "SKILL.md")}: invalid skill name "${name}"`;
  const description =
    typeof meta.description === "string" ? meta.description.replace(/\s+/g, " ").trim() : "";
  if (!description) return `${join(directory, "SKILL.md")}: missing description`;
  const allowedTools = stringList(meta["allowed-tools"]);
  return {
    name,
    description:
      description.length > MAX_DESCRIPTION
        ? `${description.slice(0, MAX_DESCRIPTION - 1)}…`
        : description,
    body,
    directory,
    scope: root.scope,
    source: root.source,
    disableModelInvocation: meta["disable-model-invocation"] === true,
    userInvocable: meta["user-invocable"] !== false,
    ...(allowedTools ? { allowedTools } : {}),
  };
}

async function skillDirectories(root: string, depth = 0): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((entry) => entry.name === "SKILL.md" && !entry.isDirectory())) {
    return depth === 0 ? [] : [root];
  }
  if (depth >= MAX_DEPTH) return [];
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink())
      isDirectory = await stat(path).then(
        (s) => s.isDirectory(),
        () => false,
      );
    if (isDirectory) found.push(...(await skillDirectories(path, depth + 1)));
  }
  return found;
}

// The same skill is often installed for several agents through symlinks; the
// first (highest-precedence) real path wins, and a later same-named skill is shadowed.
export async function discoverSkills(roots: SkillRoot[]): Promise<SkillCatalog> {
  const skills: Skill[] = [];
  const shadowed: Skill[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  const seenRoots = new Set<string>();
  const byName = new Map<string, Skill>();
  for (const root of roots) {
    const realRoot = await realpath(root.directory).catch(() => undefined);
    if (!realRoot || seenRoots.has(realRoot)) continue;
    seenRoots.add(realRoot);
    for (const directory of await skillDirectories(root.directory)) {
      const real = await realpath(directory).catch(() => directory);
      if (seenPaths.has(real)) continue;
      seenPaths.add(real);
      const loaded = await loadSkill(directory, root);
      if (typeof loaded === "string") {
        warnings.push(loaded);
        continue;
      }
      if (byName.has(loaded.name)) {
        shadowed.push(loaded);
        continue;
      }
      byName.set(loaded.name, loaded);
      skills.push(loaded);
    }
  }
  return { skills, shadowed, warnings };
}

export const SKILLS_CONTEXT_TYPE = "skills";

export function skillListing(skills: Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = visible.map((skill) => `- ${skill.name}: ${skill.description}`);
  return [
    "Skills are instructions for specific tasks. When a task matches a skill's description, or the user names one (for example $name), load it with the skill tool and follow it before acting.",
    ...lines,
  ].join("\n");
}

function latestSnapshot(messages: AgentMessage[], type: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "custom" && message.customType === type) {
      const block = message.content[0];
      return block?.type === "text" ? block.text : "";
    }
  }
  return undefined;
}

export function snapshotMessage(type: string, text: string): CustomMessage {
  return { ...customMessage(type, text), retention: { key: type } };
}

// Snapshot context: append a new message only when the text differs from the latest one.
export function refreshedSnapshot(
  messages: AgentMessage[],
  type: string,
  text: string,
): AgentMessage[] {
  const latest = latestSnapshot(messages, type);
  if (latest === undefined) return text ? [snapshotMessage(type, text)] : [];
  if (latest === text) return [];
  return [snapshotMessage(type, text || "No entries are available any more.")];
}

async function sampleFiles(directory: string, limit = 20): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (files.length >= limit || depth > 3) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.name !== "SKILL.md")
        files.push(relative(directory, path).split(sep).join("/"));
    }
  };
  await walk(directory, 0);
  return files;
}

export function skillContent(skill: Skill, files: string[]): string {
  return [
    `<skill name="${skill.name}">`,
    skill.body,
    "</skill>",
    `Base directory for this skill: ${skill.directory}`,
    "Relative paths in the skill (scripts/, references/, …) are relative to that directory.",
    ...(files.length > 0 ? ["Files:", ...files.map((file) => `- ${file}`)] : []),
  ].join("\n");
}

const SOURCE_LABEL: Record<SkillSource, string> = {
  mu: ".mu",
  agents: ".agents",
  claude: ".claude",
  codex: ".codex",
  opencode: "opencode",
};

export function describeSkillCatalog(catalog: SkillCatalog): string {
  if (catalog.skills.length === 0 && catalog.shadowed.length === 0) {
    return "No skills found. Skills live in .mu/skills, .agents/skills, .claude/skills, .codex/skills or .opencode/skills (project or home); install shared ones with `npx skills add <repo>`.";
  }
  const width = Math.max(...catalog.skills.map((skill) => skill.name.length), 4);
  const lines = [`Skills (${catalog.skills.length})`];
  for (const skill of catalog.skills) {
    const flags = [
      `${skill.scope} ${SOURCE_LABEL[skill.source]}`,
      ...(skill.disableModelInvocation ? ["user only"] : []),
      ...(!skill.userInvocable ? ["model only"] : []),
      ...(skill.allowedTools
        ? [`allowed-tools not applied: ${skill.allowedTools.join(", ")}`]
        : []),
    ];
    lines.push(`  ${skill.name.padEnd(width)}  ${flags.join(" · ")}`);
    lines.push(`  ${" ".repeat(width)}  ${skill.directory}`);
  }
  if (catalog.shadowed.length > 0) {
    lines.push("Shadowed by a same-named skill:");
    for (const skill of catalog.shadowed) lines.push(`  ${skill.name}  ${skill.directory}`);
  }
  for (const warning of catalog.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

const MENTION = /(^|\s)\$([A-Za-z0-9][A-Za-z0-9._-]*)/g;

export interface SkillsExtensionOptions {
  roots: SkillRoot[];
  // Preloaded catalog; rescanned before each run either way.
  catalog?: SkillCatalog;
}

export function skillsExtension(options: SkillsExtensionOptions): Extension {
  let catalog: SkillCatalog = options.catalog ?? { skills: [], shadowed: [], warnings: [] };
  const rescan = async () => {
    catalog = await discoverSkills(options.roots);
    return catalog;
  };
  const find = (name: string) => catalog.skills.find((skill) => skill.name === name);

  return {
    name: "skills",
    activate: async (api) => {
      if (!options.catalog) await rescan();
      for (const warning of catalog.warnings) api.log(warning);

      api.registerContextProvider(async (messages) =>
        refreshedSnapshot(messages, SKILLS_CONTEXT_TYPE, skillListing((await rescan()).skills)),
      );

      api.registerTool({
        name: "skill",
        description:
          "Load the full instructions of a skill listed in the skills context, including where its files are.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", description: "Skill name" } },
          required: ["name"],
          additionalProperties: false,
        },
        isConcurrencySafe: () => true,
        permissionPattern: (args: { name?: string }) => args.name ?? "",
        execute: async (_id, args: { name?: unknown }) => {
          const requested = typeof args.name === "string" ? args.name.replace(/^\$/, "") : "";
          const known = find(requested);
          if (!known || known.disableModelInvocation) {
            const available = catalog.skills.filter((skill) => !skill.disableModelInvocation);
            return errorResult(
              `No such skill: ${requested}. Available: ${available.map((skill) => skill.name).join(", ") || "none"}`,
            );
          }
          // Re-read so an edited skill takes effect without restarting the session.
          const fresh = await loadSkill(known.directory, known);
          const skill = typeof fresh === "string" ? known : fresh;
          return {
            content: [
              { type: "text", text: skillContent(skill, await sampleFiles(skill.directory)) },
            ],
            details: { skill: skill.name, directory: skill.directory },
          };
        },
      });

      api.registerCommand({
        name: "skills",
        description: "List discovered skills and where they come from",
        run: async (ctx) => {
          ctx.print(describeSkillCatalog(await rescan()));
          return { handled: true };
        },
      });

      for (const skill of catalog.skills.filter((candidate) => candidate.userInvocable)) {
        api.registerCommand({
          name: skill.name,
          description: `Skill: ${skill.description}`,
          fallback: true,
          run: async (ctx) => {
            const fresh = await loadSkill(skill.directory, skill);
            const current = typeof fresh === "string" ? skill : fresh;
            const args = ctx.args.trim();
            const prompt = [
              `The user invoked the skill "${current.name}". Follow it for this request.`,
              skillContent(current, await sampleFiles(current.directory)),
              ...(args ? [`User request: ${args}`] : []),
            ].join("\n\n");
            return { handled: true, data: { kind: "markdown-command", prompt } };
          },
        });
      }

      // `$name` mentions keep the user's text and point the model at the skill tool.
      api.onInput((text) => {
        const named = [...text.matchAll(MENTION)]
          .map((match) => find(match[2] ?? ""))
          .filter((skill): skill is Skill => skill !== undefined && !skill.disableModelInvocation);
        const unique = [...new Set(named.map((skill) => skill.name))];
        if (unique.length === 0) return undefined;
        return {
          text: `${text}\n\n(The user named the skill${unique.length === 1 ? "" : "s"} ${unique.join(", ")}; load ${unique.length === 1 ? "it" : "them"} with the skill tool before acting.)`,
        };
      });
    },
  };
}

// Directories from `cwd` up to the nearest one holding a marker (default `.git`),
// deepest first; without a marker only `cwd` itself. Never walks into or above home.
export async function projectDirectories(
  cwd: string,
  options: { home?: string; markers?: string[] } = {},
): Promise<string[]> {
  const home = options.home ?? homedir();
  const markers = options.markers ?? [".git"];
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    if (current === home) break;
    dirs.push(current);
    for (const marker of markers) {
      if (
        await stat(join(current, marker)).then(
          () => true,
          () => false,
        )
      )
        return dirs;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.length > 0 ? [dirs[0] as string] : [];
}
