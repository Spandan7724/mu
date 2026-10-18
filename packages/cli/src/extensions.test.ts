import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBuiltInExtensions } from "./extensions.ts";

const fixture = fileURLToPath(
  new URL("../../sdk/src/testing/mcp-fixture-server.ts", import.meta.url),
);

describe("CLI built-in extensions", () => {
  async function sandbox(prefix: string) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const home = join(root, "home");
    const project = join(root, "repo");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(home, { recursive: true });
    return { root, home, project };
  }
  const server = (value: string) => ({
    command: process.execPath,
    args: [fixture, value],
    env: { MCP_FIXTURE_VALUE: value },
  });
  const text = (result: { content: { type: string; text?: string }[] } | undefined) =>
    result?.content[0]?.type === "text" ? result.content[0].text : "";

  test("user MCP servers are callable; project servers wait for approval", async () => {
    const { home, project } = await sandbox("mu-cli-mcp-");
    await mkdir(join(home, ".mu"), { recursive: true });
    await writeFile(
      join(home, ".mu", "config.json"),
      JSON.stringify({ mcpServers: { mine: server("user") } }),
    );
    await mkdir(join(project, ".mu"), { recursive: true });
    await writeFile(
      join(project, ".mu", "config.json"),
      JSON.stringify({ mcpServers: { repo: server("project") } }),
    );

    const loaded = await loadBuiltInExtensions(
      join(project),
      undefined,
      {},
      { userDir: false },
      {
        home,
        warmMcp: false,
      },
    );
    try {
      expect(loaded.warnings).toEqual([]);
      const call = loaded.host.tools.get("mcp_call");
      const signal = new AbortController().signal;
      expect(
        text(
          await call?.execute(
            "c1",
            { server: "mine", tool: "echo", arguments: { text: "hi" } },
            signal,
          ),
        ),
      ).toBe("user:hi");
      expect(
        text(
          await call?.execute(
            "c2",
            { server: "repo", tool: "echo", arguments: { text: "hi" } },
            signal,
          ),
        ),
      ).toContain("/mcp approve repo");
    } finally {
      await loaded.host.shutdown();
    }
  });

  test("skills from other agents' folders are found from a subdirectory of the repository", async () => {
    const { home, project } = await sandbox("mu-cli-skills-");
    const skill = join(project, ".claude", "skills", "review");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: review\ndescription: Review a change\n---\nLook closely.\n",
    );
    const deep = join(project, "src", "app");
    await mkdir(deep, { recursive: true });

    const loaded = await loadBuiltInExtensions(
      deep,
      undefined,
      {},
      { userDir: false },
      { home, warmMcp: false },
    );
    try {
      expect(loaded.host.commands.has("review")).toBe(true);
      const result = await loaded.host.tools
        .get("skill")
        ?.execute("c1", { name: "review" }, new AbortController().signal);
      expect(text(result)).toContain("Look closely.");
    } finally {
      await loaded.host.shutdown();
    }
  });

  test("profiles without a project see user skills only", async () => {
    const { home, project } = await sandbox("mu-cli-skills-user-");
    await mkdir(join(project, ".agents", "skills", "local"), { recursive: true });
    await writeFile(
      join(project, ".agents", "skills", "local", "SKILL.md"),
      "---\nname: local\ndescription: d\n---\n",
    );
    const loaded = await loadBuiltInExtensions(
      project,
      undefined,
      {},
      { userDir: false },
      {
        home,
        project: false,
        warmMcp: false,
      },
    );
    try {
      expect(loaded.host.commands.has("local")).toBe(false);
    } finally {
      await loaded.host.shutdown();
    }
  });
});

describe("CLI user extensions", () => {
  test("project TypeScript extensions load without a build step", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-cli-extension-"));
    const directory = join(root, ".mu", "extensions");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "demo.ts"),
      `export default {
        name: "demo",
        activate(api) {
          api.registerCommand({
            name: "demo",
            description: "from project",
            run: () => ({ handled: true, message: "loaded" }),
          });
        },
      };`,
    );

    const loaded = await loadBuiltInExtensions(
      root,
      undefined,
      { userFile: join(root, "missing-user-config.json") },
      { userDir: false },
      { home: root, warmMcp: false },
    );
    try {
      expect(loaded.warnings).toEqual([]);
      expect(loaded.host.commands.has("demo")).toBe(true);
    } finally {
      await loaded.host.shutdown();
    }
  });

  test("a broken project extension warns without preventing startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-cli-extension-broken-"));
    const directory = join(root, ".mu", "extensions");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "broken.ts"), `throw new Error("broken on load");`);

    const loaded = await loadBuiltInExtensions(
      root,
      undefined,
      { userFile: join(root, "missing-user-config.json") },
      { userDir: false },
      { home: root, warmMcp: false },
    );
    try {
      expect(loaded.warnings).toHaveLength(1);
      expect(loaded.warnings[0]).toContain("broken on load");
    } finally {
      await loaded.host.shutdown();
    }
  });
});
