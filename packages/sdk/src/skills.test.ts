import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentMessage, ExtensionHost } from "@mu/core";
import type { MarkdownCommandRun } from "./markdown-commands.ts";
import {
  discoverSkills,
  loadSkill,
  projectDirectories,
  refreshedSnapshot,
  SKILLS_CONTEXT_TYPE,
  skillListing,
  skillRoots,
  skillsExtension,
} from "./skills.ts";

async function writeSkill(dir: string, frontmatter: string, body = "Do the thing.") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "mu-skills-"));
  const home = join(root, "home");
  const project = join(root, "work", "repo");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
  return { root, home, project };
}

describe("skill loading", () => {
  test("reads YAML frontmatter including folded descriptions and flags", async () => {
    const { root } = await sandbox();
    const dir = join(root, "pdf");
    await writeSkill(
      dir,
      "name: pdf\ndescription: >\n  Fill and merge PDF forms.\n  Use for any PDF work.\ndisable-model-invocation: true\nallowed-tools: Bash(git status:*), Read",
    );
    const skill = await loadSkill(dir);
    if (typeof skill === "string") throw new Error(skill);
    expect(skill.name).toBe("pdf");
    expect(skill.description).toBe("Fill and merge PDF forms. Use for any PDF work.");
    expect(skill.disableModelInvocation).toBe(true);
    expect(skill.allowedTools).toEqual(["Bash(git status:*)", "Read"]);
    expect(skill.body).toBe("Do the thing.");
  });

  test("falls back to the line parser for frontmatter that is not strict YAML", async () => {
    const { root } = await sandbox();
    const dir = join(root, "loose");
    await writeSkill(dir, "name: loose\ndescription: Use when: the user asks");
    const skill = await loadSkill(dir);
    expect(typeof skill === "string" ? skill : skill.description).toBe("Use when: the user asks");
  });

  test("a skill without a description is reported, not loaded", async () => {
    const { root } = await sandbox();
    const dir = join(root, "bare");
    await writeSkill(dir, "name: bare");
    expect(await loadSkill(dir)).toContain("missing description");
  });
});

describe("skill discovery", () => {
  test("finds skills installed for other agents, project before user", async () => {
    const { home, project } = await sandbox();
    await writeSkill(
      join(home, ".claude", "skills", "review"),
      "name: review\ndescription: user claude review",
    );
    await writeSkill(
      join(project, ".agents", "skills", "review"),
      "name: review\ndescription: project review",
    );
    await writeSkill(
      join(home, ".codex", "skills", "nested", "deploy"),
      "name: deploy\ndescription: deploy it",
    );
    await writeSkill(
      join(home, ".config", "opencode", "skills", "lint"),
      "name: lint\ndescription: lint it",
    );

    const catalog = await discoverSkills(skillRoots({ home, projectDirs: [project] }));
    expect(catalog.skills.map((s) => [s.name, s.scope, s.source])).toEqual([
      ["review", "project", "agents"],
      ["deploy", "user", "codex"],
      ["lint", "user", "opencode"],
    ]);
    expect(catalog.shadowed.map((s) => s.description)).toEqual(["user claude review"]);
  });

  test("a skill linked into several agents' folders is listed once", async () => {
    const { root, home } = await sandbox();
    const real = join(root, "store", "shared");
    await writeSkill(real, "name: shared\ndescription: one skill");
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await symlink(real, join(home, ".agents", "skills", "shared"));
    await symlink(real, join(home, ".claude", "skills", "shared"));

    const catalog = await discoverSkills(skillRoots({ home }));
    expect(catalog.skills.map((s) => s.source)).toEqual(["agents"]);
    expect(catalog.shadowed).toEqual([]);
  });

  test("project directories stop at the repository root and never include home", async () => {
    const { home, project } = await sandbox();
    const deep = join(project, "packages", "app");
    await mkdir(deep, { recursive: true });
    expect(await projectDirectories(deep, { home })).toEqual([
      deep,
      join(project, "packages"),
      project,
    ]);
    expect(await projectDirectories(home, { home })).toEqual([]);
  });
});

describe("skills extension", () => {
  async function setup() {
    const { home, project } = await sandbox();
    await writeSkill(
      join(home, ".mu", "skills", "release"),
      "name: release\ndescription: Cut a release",
      "Bump, tag, push.",
    );
    await writeSkill(
      join(home, ".mu", "skills", "secret"),
      "name: secret\ndescription: Only by hand\ndisable-model-invocation: true",
    );
    await writeSkill(
      join(home, ".mu", "skills", "help"),
      "name: help\ndescription: Shadows nothing",
    );
    const host = new ExtensionHost();
    host.commands.register({
      name: "help",
      description: "core help",
      run: () => ({ handled: true }),
    });
    await host.register(skillsExtension({ roots: skillRoots({ home, projectDirs: [project] }) }));
    return { host, home };
  }

  test("the listing is a persisted snapshot that is only re-sent when it changes", async () => {
    const { host } = await setup();
    const first = await host.runContextProviders([], { sessionId: "s" });
    expect(first).toHaveLength(1);
    const listing = first[0] as AgentMessage & { customType: string; content: { text: string }[] };
    expect(listing.customType).toBe(SKILLS_CONTEXT_TYPE);
    expect(listing.content[0]?.text).toContain("- release: Cut a release");
    expect(listing.content[0]?.text).not.toContain("secret");
    expect(await host.runContextProviders(first, { sessionId: "s" })).toEqual([]);
  });

  test("the skill tool returns the body and base directory; hidden skills are refused", async () => {
    const { host, home } = await setup();
    const tool = host.tools.get("skill");
    const result = await tool?.execute("1", { name: "release" }, new AbortController().signal);
    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Bump, tag, push.");
    expect(text).toContain(join(home, ".mu", "skills", "release"));
    const hidden = await tool?.execute("2", { name: "secret" }, new AbortController().signal);
    expect(hidden?.isError).toBe(true);
  });

  test("user-invocable skills become commands without replacing existing ones", async () => {
    const { host } = await setup();
    expect(host.commands.get("help")?.description).toBe("core help");
    const command = host.commands.get("secret");
    const result = await command?.run({
      args: "for v2",
      inject: () => {},
      print: () => {},
      getModel: () => "m",
      setModel: () => {},
    });
    const data = (result as { data?: MarkdownCommandRun }).data;
    expect(data?.kind).toBe("markdown-command");
    expect(data?.prompt).toBe("/secret for v2");
    const instructions = data?.context?.[0]?.content[0];
    expect(instructions?.type === "text" && instructions.text).toContain(
      'invoked the skill "secret"',
    );
  });

  test("$name mentions point the model at the skill tool", async () => {
    const { host } = await setup();
    const directive = await host.runInputHooks("ship it with $release please");
    expect(directive?.text).toBeUndefined();
    const note = directive?.context?.[0]?.content[0];
    expect(note?.type === "text" && note.text).toContain("named the skill release");
    expect(await host.runInputHooks("costs $5")).toBeUndefined();
  });
});

describe("snapshots", () => {
  test("an emptied listing is replaced rather than left stale", () => {
    const first = refreshedSnapshot([], "x", "a");
    expect(refreshedSnapshot(first, "x", "")[0]?.role).toBe("custom");
    expect(skillListing([])).toBe("");
  });
});
