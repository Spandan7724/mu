import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionHost, type PermissionRequest } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";
import { loadMcpConfig, mcpExtension } from "./mcp.ts";

const fixture = fileURLToPath(new URL("./testing/mcp-fixture-server.ts", import.meta.url));
const activeHosts: ExtensionHost[] = [];

afterEach(async () => {
  await Promise.allSettled(activeHosts.splice(0).map((host) => host.shutdown()));
});

function contentText(content: { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

async function fixtureHost(): Promise<ExtensionHost> {
  const host = new ExtensionHost();
  activeHosts.push(host);
  await host.register(
    mcpExtension({
      fixture: {
        command: process.execPath,
        args: [fixture],
        env: { MCP_FIXTURE_VALUE: "connected" },
        startupTimeoutMs: 5_000,
      },
    }),
  );
  return host;
}

describe("MCP config", () => {
  test("user servers load first and project servers override by name", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-mcp-config-"));
    const userFile = join(root, "user.json");
    const projectDir = join(root, "project");
    const projectFile = join(projectDir, ".mu", "config.json");
    await mkdir(dirname(projectFile), { recursive: true });
    await writeFile(
      userFile,
      JSON.stringify({
        mcpServers: {
          shared: { command: "user-command" },
          userOnly: { command: "user-only", args: ["--stdio"] },
        },
      }),
    );
    await writeFile(
      projectFile,
      JSON.stringify({
        mcpServers: {
          shared: { command: "project-command", cwd: ".." },
          broken: { args: ["missing-command"] },
        },
      }),
    );

    const report = await loadMcpConfig({ userFile, projectDir });

    expect(report.servers.shared?.command).toBe("project-command");
    expect(report.servers.shared?.cwd).toBe(projectDir);
    expect(report.servers.userOnly?.args).toEqual(["--stdio"]);
    expect(report.servers.broken).toBeUndefined();
    expect(report.errors).toEqual([
      { file: projectFile, message: "invalid MCP server config: broken" },
    ]);
  });
});

describe("MCP stdio extension", () => {
  test("discovers and calls tools and resources through the official transport", async () => {
    const host = await fixtureHost();
    const echo = host.tools.get("mcp_fixture_echo");
    const list = host.tools.get("mcp_fixture_resources_list");
    const read = host.tools.get("mcp_fixture_resource_read");

    expect(echo).toBeDefined();
    expect(list).toBeDefined();
    expect(read).toBeDefined();
    expect(echo?.isConcurrencySafe?.({ text: "x" })).toBe(true);

    const signal = new AbortController().signal;
    const echoed = await echo?.execute("c1", { text: "hello" }, signal);
    expect(contentText(echoed?.content ?? [])).toBe("connected:hello");

    const resources = await list?.execute("c2", {}, signal);
    expect(contentText(resources?.content ?? [])).toContain("fixture://note");

    const resource = await read?.execute("c3", { uri: "fixture://note" }, signal);
    expect(contentText(resource?.content ?? [])).toContain("fixture resource body");
  });

  test("MCP tools pass through the Agent permission engine", async () => {
    const host = await fixtureHost();
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "mcp-call",
            name: "mcp_fixture_echo",
            arguments: { text: "from-agent" },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const asked: PermissionRequest[] = [];
    const agent = new Agent({
      provider,
      model: fakeModel,
      extensions: host,
      permissions: [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "mcp_*", pattern: "*", action: "ask" },
      ],
      onPermission: async (request) => {
        asked.push(request);
        return "allow";
      },
    });

    const result = await agent.run("use the MCP echo tool");
    const toolResult = result.messages.find((message) => message.role === "toolResult");

    expect(asked.map((request) => request.toolName)).toEqual(["mcp_fixture_echo"]);
    expect(toolResult?.role === "toolResult" && contentText(toolResult.content)).toBe(
      "connected:from-agent",
    );
    await agent.shutdown();
    activeHosts.splice(activeHosts.indexOf(host), 1);
  });

  test("an Agent abort cancels an in-flight MCP request without closing the connection", async () => {
    const host = await fixtureHost();
    const slow = host.tools.get("mcp_fixture_slow");
    const echo = host.tools.get("mcp_fixture_echo");
    const controller = new AbortController();

    const waiting = slow?.execute("c1", { delayMs: 5_000 }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const cancelled = await waiting;
    expect(cancelled?.isError).toBe(true);

    const echoed = await echo?.execute(
      "c2",
      { text: "after-cancel" },
      new AbortController().signal,
    );
    expect(contentText(echoed?.content ?? [])).toBe("connected:after-cancel");
  });
});
