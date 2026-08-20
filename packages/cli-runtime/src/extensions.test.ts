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
  test("project MCP config becomes callable tools on the shared extension host", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-cli-mcp-"));
    await mkdir(join(root, ".mu"), { recursive: true });
    await writeFile(
      join(root, ".mu", "config.json"),
      JSON.stringify({
        mcpServers: {
          project: {
            command: process.execPath,
            args: [fixture],
            env: { MCP_FIXTURE_VALUE: "cli" },
          },
        },
      }),
    );

    const loaded = await loadBuiltInExtensions(
      root,
      undefined,
      {
        userFile: join(root, "missing-user-config.json"),
      },
      { userDir: false },
    );
    try {
      expect(loaded.warnings).toEqual([]);
      const tool = loaded.host.tools.get("mcp_project_echo");
      expect(tool).toBeDefined();
      const result = await tool?.execute("c1", { text: "connected" }, new AbortController().signal);
      expect(result?.content[0]).toEqual({ type: "text", text: "cli:connected" });
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
    );
    try {
      expect(loaded.warnings).toHaveLength(1);
      expect(loaded.warnings[0]).toContain("broken on load");
    } finally {
      await loaded.host.shutdown();
    }
  });
});
