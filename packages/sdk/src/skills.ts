// Built-in extension: skills. A skill is a directory with a SKILL.md whose
// frontmatter carries a name and description; the description is always in
// context, and the body is loaded on demand via a tool. This is progressive
// disclosure — and it is built entirely on the public extension API, which is
// the point: if this needed private internals, the API would be incomplete.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Extension, ExtensionAPI } from "@mu/core";
import { parseFrontmatter } from "./markdown-commands.ts";

export interface Skill {
  name: string;
  description: string;
  body: string;
  directory: string;
}

export async function loadSkill(directory: string): Promise<Skill | undefined> {
  try {
    const source = await readFile(join(directory, "SKILL.md"), "utf8");
    const { meta, body } = parseFrontmatter(source);
    const name = typeof meta.name === "string" && meta.name ? meta.name : basename(directory);
    const description =
      typeof meta.description === "string" && meta.description
        ? meta.description
        : `The ${name} skill`;
    return { name, description, body, directory };
  } catch {
    return undefined;
  }
}

export async function discoverSkills(roots: string[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const directory = join(root, entry);
      try {
        if (!(await stat(directory)).isDirectory()) continue;
      } catch {
        continue;
      }
      const skill = await loadSkill(directory);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

export function defaultSkillRoots(projectDir?: string): string[] {
  const roots = [join(homedir(), ".mu", "skills")];
  if (projectDir) roots.push(join(projectDir, ".mu", "skills"));
  return roots;
}

// The listing that stays in context: names and descriptions only, so the cost
// is bounded no matter how many skills exist.
export function skillListing(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return `Available skills (load one with the skill tool when it is relevant):\n${lines.join("\n")}`;
}

export function skillsExtension(skills: Skill[]): Extension {
  return {
    name: "skills",
    activate(api: ExtensionAPI) {
      if (skills.length === 0) return;
      const byName = new Map(skills.map((skill) => [skill.name, skill]));

      api.registerTool({
        name: "skill",
        description: `Load the full instructions for a skill. ${skillListing(skills)}`,
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The skill to load" },
          },
          required: ["name"],
        },
        isConcurrencySafe: () => true,
        execute: async (_id, args) => {
          const requested = (args as { name?: string }).name ?? "";
          const skill = byName.get(requested);
          if (!skill) {
            return {
              content: [
                {
                  type: "text",
                  text: `No such skill: ${requested}. Available: ${[...byName.keys()].join(", ")}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Skill "${skill.name}" (files are in ${skill.directory}):\n\n${skill.body}`,
              },
            ],
            details: { skill: skill.name },
          };
        },
      });

      // The listing enters as injected context, never a system-prompt edit.
      api.onContext((messages) => messages);
      api.log(`loaded ${skills.length} skill(s)`);
    },
  };
}
