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

    const loaded = await loadBuiltInExtensions(root, undefined, {
      userFile: join(root, "missing-user-config.json"),
    });
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
