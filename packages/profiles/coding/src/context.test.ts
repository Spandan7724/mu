import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstructionLoader } from "./context.ts";
import { codingProfile } from "./index.ts";

async function scratch(name = "mu-instructions-"): Promise<string> {
  return mkdtemp(join(tmpdir(), name));
}

async function textOf(messages: Awaited<ReturnType<InstructionLoader["refreshedMessages"]>>) {
  return messages
    .flatMap((message) => (message.role === "custom" ? message.content : []))
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("InstructionLoader discovery", () => {
  test("stops at the nearest project root and orders outer instructions before inner ones", async () => {
    const parent = await scratch();
    const root = join(parent, "repo");
    const cwd = join(root, "packages", "app");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(parent, "AGENTS.md"), "outside");
    await writeFile(join(root, "AGENTS.md"), "root");
    await writeFile(join(cwd, "AGENTS.md"), "inner");

    const loader = new InstructionLoader({ root: cwd, home: await scratch() });
    const snapshot = await loader.reload();
    expect(snapshot.projectRoot).toBe(root);
    expect(snapshot.sources.map((source) => source.content)).toEqual(["root", "inner"]);
  });

  test("selects one primary file per directory using override and fallback precedence", async () => {
    const root = await scratch();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "AGENTS.md"), "agents");
    await writeFile(join(root, "AGENTS.override.md"), "override");
    await writeFile(join(root, "CLAUDE.md"), "claude");

    const loader = new InstructionLoader({ root, home: await scratch() });
    expect((await loader.reload()).sources.map((source) => source.content)).toEqual(["override"]);

    await rm(join(root, "AGENTS.override.md"));
    expect((await loader.reload()).sources.map((source) => source.content)).toEqual(["agents"]);
    await rm(join(root, "AGENTS.md"));
    expect((await loader.reload()).sources.map((source) => source.content)).toEqual(["claude"]);
  });

  test("keeps a directory override later than its rule files", async () => {
    const root = await scratch();
    await mkdir(join(root, ".mu", "rules"), { recursive: true });
    await writeFile(join(root, ".mu", "rules", "base.md"), "rule");
    await writeFile(join(root, "AGENTS.override.md"), "override");
    const loader = new InstructionLoader({ root, home: await scratch() });
    expect((await loader.reload()).sources.map((source) => source.content)).toEqual([
      "rule",
      "override",
    ]);
  });

  test("loads managed, global, and project instructions in increasing precedence", async () => {
    const root = await scratch();
    const home = await scratch();
    const managed = join(await scratch(), "managed.md");
    await mkdir(join(root, ".git"));
    await mkdir(join(home, ".mu"), { recursive: true });
    await writeFile(managed, "managed");
    await writeFile(join(home, ".mu", "AGENTS.md"), "global");
    await writeFile(join(root, "AGENTS.md"), "project");

    const loader = new InstructionLoader({
      root,
      home,
      managedPaths: [managed],
    });
    const snapshot = await loader.reload();
    expect(snapshot.sources.map((source) => source.scope)).toEqual([
      "managed",
      "global",
      "project",
    ]);
    expect(snapshot.sources.map((source) => source.content)).toEqual([
      "managed",
      "global",
      "project",
    ]);
  });

  test("supports configurable fallback names and project-root markers", async () => {
    const root = await scratch();
    const cwd = join(root, "nested");
    await mkdir(join(root, ".workspace"));
    await mkdir(cwd);
    await writeFile(join(root, "GUIDANCE.md"), "custom fallback");

    const loader = new InstructionLoader({
      root: cwd,
      home: await scratch(),
      fallbackFilenames: ["GUIDANCE.md"],
      projectRootMarkers: [".workspace"],
    });
    const snapshot = await loader.reload();
    expect(snapshot.projectRoot).toBe(root);
    expect(snapshot.sources[0]?.content).toBe("custom fallback");
  });

  test("canonicalizes a symlinked working directory before containment checks", async () => {
    if (process.platform === "win32") return;
    const parent = await scratch();
    const root = join(parent, "repo");
    const alias = join(parent, "alias");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "through symlink");
    await symlink(root, alias);

    const loader = new InstructionLoader({ root: alias, home: await scratch() });
    expect((await loader.reload()).sources[0]?.content).toBe("through symlink");
  });
});

describe("InstructionLoader imports and rules", () => {
  test("loads safe imports before the including file and breaks cycles", async () => {
    const root = await scratch();
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, "AGENTS.md"),
      ["@./shared.md", "```text", "@./ignored.md", "```", "project"].join("\n"),
    );
    await writeFile(join(root, "shared.md"), "@./AGENTS.md\nshared");
    await writeFile(join(root, "ignored.md"), "ignored");

    const loader = new InstructionLoader({ root, home: await scratch() });
    const snapshot = await loader.reload();
    expect(snapshot.sources.map((source) => source.content)).toEqual([
      "@./AGENTS.md\nshared",
      "@./shared.md\n```text\n@./ignored.md\n```\nproject",
    ]);
    expect(snapshot.sources.map((source) => source.scope)).toEqual(["import", "project"]);
  });

  test("rejects external project imports with a visible diagnostic", async () => {
    const parent = await scratch();
    const root = join(parent, "repo");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(parent, "outside.md"), "outside");
    await writeFile(join(root, "AGENTS.md"), "@../outside.md\ninside");

    const loader = new InstructionLoader({ root, home: await scratch() });
    const snapshot = await loader.reload();
    expect(snapshot.sources.map((source) => source.content)).toEqual(["@../outside.md\ninside"]);
    expect(snapshot.diagnostics.some((item) => item.message.includes("external import"))).toBe(
      true,
    );
  });

  test("loads unconditional rules eagerly and conditional rules only for matching paths", async () => {
    const root = await scratch();
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await mkdir(join(root, "src"));
    await mkdir(join(root, "test"));
    await writeFile(join(root, "src", "app.ts"), "export {}");
    await writeFile(join(root, "test", "app.ts"), "export {}");
    await writeFile(join(root, ".claude", "rules", "base.md"), "base rule");
    await writeFile(
      join(root, ".claude", "rules", "typescript.md"),
      "---\npaths:\n  - src/**/*.ts\n---\ntypescript rule",
    );

    const loader = new InstructionLoader({ root, home: await scratch() });
    expect((await loader.reload()).sources.map((source) => source.content)).toEqual(["base rule"]);
    expect((await loader.instructionsForPath(join(root, "test", "app.ts"))).text).toBe("");
    const matched = await loader.instructionsForPath(join(root, "src", "app.ts"));
    expect(matched.text).toContain("typescript rule");
  });

  test("discovers nested instructions lazily and attaches each source once", async () => {
    const root = await scratch();
    const target = join(root, "packages", "app", "src", "index.ts");
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "packages", "app", "src"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root");
    await writeFile(join(root, "packages", "app", "AGENTS.md"), "nested");
    await writeFile(target, "export {}");

    const loader = new InstructionLoader({ root, home: await scratch() });
    await loader.reload();
    const first = await loader.instructionsForPath(target);
    const second = await loader.instructionsForPath(target);
    expect(first.text).toContain("nested");
    expect(first.sources).toHaveLength(1);
    expect(second).toEqual({ text: "", sources: [] });
    expect(loader.formatStatus()).toContain("packages/app/AGENTS.md");
  });

  test("loads lazy instructions after eager content exceeds the former aggregate budget", async () => {
    const root = await scratch();
    const nested = join(root, "src");
    const target = join(nested, "app.ts");
    await mkdir(join(root, ".git"));
    await mkdir(nested);
    await writeFile(join(root, "AGENTS.md"), "x".repeat(20 * 1024));
    const nestedContent = "y".repeat(20 * 1024);
    await writeFile(join(nested, "AGENTS.md"), nestedContent);
    await writeFile(target, "");

    const loader = new InstructionLoader({ root, home: await scratch() });
    expect((await loader.reload()).bytes).toBe(20 * 1024);
    const loaded = await loader.instructionsForPath(target);
    expect(loaded.text).toContain(nestedContent);
    expect(loader.formatStatus()).toContain("40.0 KiB");
  });

  test("serializes parallel nested discovery so one source is never attached twice", async () => {
    const root = await scratch();
    const nested = join(root, "src");
    await mkdir(join(root, ".git"));
    await mkdir(nested);
    await writeFile(join(nested, "AGENTS.md"), "nested");
    await writeFile(join(nested, "a.ts"), "");
    await writeFile(join(nested, "b.ts"), "");
    const loader = new InstructionLoader({ root, home: await scratch() });
    await loader.reload();

    const results = await Promise.all([
      loader.instructionsForPath(join(nested, "a.ts")),
      loader.instructionsForPath(join(nested, "b.ts")),
    ]);
    expect(results.filter((result) => result.sources.length > 0)).toHaveLength(1);
  });

  test("a fresh transcript resets lazy attachment claims", async () => {
    const root = await scratch();
    const nested = join(root, "src");
    const target = join(nested, "app.ts");
    await mkdir(nested);
    await writeFile(join(nested, "AGENTS.md"), "nested");
    await writeFile(target, "");
    const loader = new InstructionLoader({ root, home: await scratch() });
    await loader.reload();
    expect((await loader.instructionsForPath(target)).sources).toHaveLength(1);
    expect((await loader.instructionsForPath(target)).sources).toHaveLength(0);

    await loader.refreshedMessages([]);
    expect((await loader.instructionsForPath(target)).sources).toHaveLength(1);
  });
});

describe("InstructionLoader refresh and settings", () => {
  test("does not duplicate unchanged snapshots and supersedes changed or deleted instructions", async () => {
    const root = await scratch();
    const path = join(root, "AGENTS.md");
    await mkdir(join(root, ".git"));
    await writeFile(path, "first");
    const loader = new InstructionLoader({ root, home: await scratch() });

    const first = await loader.refreshedMessages([]);
    expect(await textOf(first)).toContain("first");
    expect(await loader.refreshedMessages(first)).toEqual([]);

    await writeFile(path, "second");
    const changed = await loader.refreshedMessages(first);
    expect(await textOf(changed)).toContain("supersedes");
    expect(await textOf(changed)).toContain("second");

    await rm(path);
    const deleted = await loader.refreshedMessages([...first, ...changed]);
    expect(await textOf(deleted)).toContain("No instruction files are currently active");
  });

  test("loads instruction files larger than the former byte budget in full", async () => {
    const root = await scratch();
    await mkdir(join(root, ".git"));
    const content = "x".repeat(40 * 1024);
    await writeFile(join(root, "AGENTS.md"), content);
    const loader = new InstructionLoader({ root, home: await scratch() });
    const snapshot = await loader.reload();
    expect(snapshot.bytes).toBe(40 * 1024);
    expect(snapshot.sources[0]?.content).toBe(content);
  });

  test("can be disabled completely", async () => {
    const root = await scratch();
    await writeFile(join(root, "AGENTS.md"), "ignored");
    const loader = new InstructionLoader({
      root,
      home: await scratch(),
      enabled: false,
    });
    expect((await loader.reload()).sources).toEqual([]);
    expect(await loader.refreshedMessages([])).toEqual([]);
    expect(loader.formatStatus()).toContain("disabled");
  });

  test("invalid settings fall back safely and appear in diagnostics", async () => {
    const root = await scratch();
    await writeFile(join(root, "AGENTS.md"), "active");
    const loader = new InstructionLoader({
      root,
      home: await scratch(),
      enabled: "yes" as unknown as boolean,
      fallbackFilenames: ["/unsafe"] as string[],
    });
    const snapshot = await loader.reload();
    expect(snapshot.sources[0]?.content).toBe("active");
    expect(snapshot.diagnostics.length).toBeGreaterThanOrEqual(2);
  });

  test("reports unreadable files instead of silently discarding them", async () => {
    if (process.platform === "win32") return;
    const root = await scratch();
    const path = join(root, "AGENTS.md");
    await mkdir(join(root, ".git"));
    await writeFile(path, "secret");
    await chmod(path, 0o000);
    try {
      const loader = new InstructionLoader({ root, home: await scratch() });
      const snapshot = await loader.reload();
      expect(snapshot.diagnostics.some((item) => item.path === path)).toBe(true);
    } finally {
      await chmod(path, 0o600);
    }
  });
});

describe("coding profile instruction integration", () => {
  test("layers user config, project config, then invocation options", async () => {
    const root = await scratch();
    const home = await scratch();
    await mkdir(join(root, ".mu"), { recursive: true });
    await mkdir(join(home, ".mu"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "@./shared.md\nrules");
    await writeFile(join(root, "shared.md"), "shared");
    await writeFile(
      join(home, ".mu", "config.json"),
      JSON.stringify({ instructions: { enabled: false, imports: true } }),
    );
    await writeFile(
      join(root, ".mu", "config.json"),
      JSON.stringify({ instructions: { enabled: true, imports: false } }),
    );

    const configured = await codingProfile({ root, home });
    expect(configured.instructions.snapshot.sources.map((source) => source.content)).toEqual([
      "@./shared.md\nrules",
    ]);
    const overridden = await codingProfile({
      root,
      home,
      instructions: { imports: true },
    });
    expect(overridden.instructions.snapshot.sources.map((source) => source.content)).toEqual([
      "shared",
      "@./shared.md\nrules",
    ]);
  });

  test("read attaches deeper instructions to model-visible output", async () => {
    const root = await scratch();
    const nested = join(root, "src");
    await mkdir(join(root, ".git"));
    await mkdir(nested);
    await writeFile(join(nested, "AGENTS.md"), "use nested conventions");
    await writeFile(join(nested, "app.ts"), "export {}");
    const profile = await codingProfile({ root, home: await scratch() });
    const read = profile.toolset.find((tool) => tool.name === "read");

    const result = await read?.execute(
      "call_read",
      { path: "src/app.ts" },
      new AbortController().signal,
    );
    expect(result?.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "use nested conventions",
    );
    expect(result?.details).toMatchObject({
      loadedInstructions: [join(nested, "AGENTS.md")],
    });
  });

  test("/instructions reload exposes loaded files and refreshes changed content", async () => {
    const root = await scratch();
    const path = join(root, "AGENTS.md");
    await writeFile(path, "one");
    const profile = await codingProfile({ root, home: await scratch() });
    const command = profile.commands?.find((candidate) => candidate.name === "instructions");
    await writeFile(path, "two");

    const result = await command?.run({
      args: "reload",
      inject: () => {},
      print: () => {},
      getModel: () => "test/model",
      setModel: () => {},
    });
    expect(result && "message" in result ? result.message : "").toContain("instructions reloaded");
    expect(profile.instructions.snapshot.sources[0]?.content).toBe("two");
  });

  test("status reports estimated tokens and loaded bytes", async () => {
    const root = await scratch();
    await writeFile(join(root, "AGENTS.md"), "x".repeat(3_500));
    const loader = new InstructionLoader({ root, home: await scratch(), managedPaths: [] });
    await loader.reload();
    const status = loader.formatStatus();
    // The total exceeds the per-file figure: it counts the snapshot framing too.
    expect(status).toContain("~1.1k tokens · 3.4 KiB");
    expect(status).toContain("AGENTS.md · ~1.0k tokens");
    expect(status).not.toContain("budget");
  });
});
