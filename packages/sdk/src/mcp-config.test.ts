import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  expandTransport,
  expandVariables,
  loadMcpApprovals,
  loadMcpConfig,
  parseJsonc,
  updateUserServerEntry,
} from "./mcp-config.ts";

async function put(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "mu-mcp-config-"));
  const home = join(root, "home");
  const project = join(root, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return { root, home, project };
}

describe("mu config", () => {
  test("project entries replace user entries; invalid ones are reported", async () => {
    const { home, project } = await sandbox();
    await put(
      join(home, ".mu", "config.json"),
      JSON.stringify({
        mcpServers: { shared: { command: "user" }, solo: { command: "solo", args: ["--stdio"] } },
      }),
    );
    const projectFile = join(project, ".mu", "config.json");
    await put(
      projectFile,
      JSON.stringify({
        mcpServers: { shared: { command: "project", cwd: ".." }, broken: { args: ["x"] } },
      }),
    );

    const report = await loadMcpConfig({ home, projectDir: project, foreign: false });
    const shared = report.servers.find((s) => s.name === "shared");
    expect(shared?.transport).toEqual({ type: "stdio", command: "project", cwd: project });
    expect(shared?.scope).toBe("project");
    expect(report.servers.find((s) => s.name === "solo")?.transport).toEqual({
      type: "stdio",
      command: "solo",
      args: ["--stdio"],
    });
    expect(report.errors).toEqual([
      { file: projectFile, message: "invalid MCP server config: broken" },
    ]);
  });

  test("HTTP entries, exposure and tool filters are read", async () => {
    const { home } = await sandbox();
    await put(
      join(home, ".mu", "config.json"),
      JSON.stringify({
        mcpServers: {
          docs: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer ${TOKEN}" },
            exposure: "direct",
            excludeTools: ["delete_*"],
          },
          legacy: { type: "sse", url: "https://example.com/sse" },
        },
      }),
    );
    const report = await loadMcpConfig({ home, foreign: false });
    expect(report.servers.map((s) => [s.name, s.transport.type, s.exposure])).toEqual([
      ["docs", "http", "direct"],
      ["legacy", "sse", "open"],
    ]);
    expect(report.servers[0]?.excludeTools).toEqual(["delete_*"]);
  });
});

describe("other agents' configs", () => {
  test("reads Claude Code, Codex, Cursor, opencode, Gemini and VS Code formats", async () => {
    const { home, project } = await sandbox();
    await put(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { claudeUser: { command: "npx", args: ["-y", "claude-user"] } },
        projects: {
          [project]: {
            mcpServers: { claudeLocal: { type: "http", url: "https://local.example/mcp" } },
          },
        },
      }),
    );
    await put(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { repoTools: { command: "./tools/mcp" } } }),
    );
    await put(
      join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.linear]",
        'url = "https://mcp.linear.app/mcp"',
        'bearer_token_env_var = "LINEAR_TOKEN"',
        "[mcp_servers.off]",
        'command = "off-server"',
        "enabled = false",
        "startup_timeout_sec = 5",
      ].join("\n"),
    );
    await put(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { cursorOne: { command: "cursor-one", env: { A: "1" } } } }),
    );
    await put(
      join(home, ".config", "opencode", "opencode.jsonc"),
      `{
        // comment
        "mcp": {
          "ocLocal": { "type": "local", "command": ["bunx", "oc-local"], "environment": { "KEY": "{env:OC_KEY}" } },
          "ocRemote": { "type": "remote", "url": "https://oc.example/mcp", },
        },
      }`,
    );
    await put(
      join(home, ".gemini", "settings.json"),
      JSON.stringify({
        mcpServers: {
          gemSse: { url: "https://g.example/sse" },
          gemHttp: { httpUrl: "https://g.example/mcp" },
        },
      }),
    );
    await put(
      join(project, ".vscode", "mcp.json"),
      JSON.stringify({
        servers: {
          vsGood: { type: "stdio", command: "vs-good" },
          vsInput: { command: "vs", env: { K: "${input:key}" } },
        },
      }),
    );

    const report = await loadMcpConfig({ home, projectDir: project });
    const by = Object.fromEntries(report.servers.map((s) => [s.name, s]));
    expect(by.repoTools?.scope).toBe("project");
    expect(by.claudeLocal?.transport).toEqual({ type: "http", url: "https://local.example/mcp" });
    expect(by.claudeUser?.scope).toBe("user");
    expect(by.linear?.transport).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
    });
    expect(by.off?.enabled).toBe(false);
    expect(by.off?.startupTimeoutMs).toBe(5000);
    expect(by.cursorOne?.source).toBe("cursor");
    expect(by.ocLocal?.transport).toEqual({
      type: "stdio",
      command: "bunx",
      args: ["oc-local"],
      env: { KEY: "${OC_KEY}" },
    });
    expect(by.ocRemote?.transport.type).toBe("http");
    expect(by.gemSse?.transport.type).toBe("sse");
    expect(by.gemHttp?.transport.type).toBe("http");
    expect(by.vsGood?.scope).toBe("project");
    expect(by.vsInput).toBeUndefined();
    expect(report.errors.some((e) => e.message.includes("VS Code input variables"))).toBe(true);
  });

  test("mu wins by name, a repeated command is listed once, and mu entries can switch others off", async () => {
    const { home } = await sandbox();
    await put(
      join(home, ".mu", "config.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "mu-github" },
          playwright: { enabled: false, exposure: "direct" },
        },
      }),
    );
    await put(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "claude-github" },
          playwright: { command: "npx", args: ["@playwright/mcp"] },
        },
      }),
    );
    await put(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { pw: { command: "npx", args: ["@playwright/mcp"] } } }),
    );

    const report = await loadMcpConfig({ home });
    expect(report.servers.map((s) => [s.name, s.source])).toEqual([
      ["github", "mu"],
      ["playwright", "claude"],
    ]);
    expect(report.servers[1]?.enabled).toBe(false);
    expect(report.servers[1]?.exposure).toBe("direct");
    expect(report.shadowed.map((s) => [s.name, s.source])).toEqual([
      ["github", "claude"],
      ["pw", "cursor"],
    ]);
  });
});

describe("variables, approvals and writes", () => {
  test("expands ${VAR}, ${env:VAR}, defaults and workspace variables; reports missing ones", () => {
    expect(
      expandVariables(
        "${A}-${env:B}-${C:-c}-${workspaceFolder}",
        { A: "a", B: "b" },
        { workspaceFolder: "/w" },
      ),
    ).toEqual({
      value: "a-b-c-/w",
      missing: [],
    });
    const { missing } = expandTransport(
      { type: "http", url: "https://x", headers: { Authorization: "Bearer ${NOPE}" } },
      {},
    );
    expect(missing).toEqual(["NOPE"]);
  });

  test("an approval holds only for the command it approved", async () => {
    const { root } = await sandbox();
    const file = join(root, "approvals.json");
    const approvals = await loadMcpApprovals(file);
    const server = {
      name: "repo",
      transport: { type: "stdio" as const, command: "./mcp" },
      source: "claude" as const,
      scope: "project" as const,
      file: "/r/.mcp.json",
      enabled: true,
      exposure: "open" as const,
    };
    await approvals.approve("/r", server);
    const reloaded = await loadMcpApprovals(file);
    expect(reloaded.isApproved("/r", server)).toBe(true);
    expect(
      reloaded.isApproved("/r", { ...server, transport: { type: "stdio", command: "./other" } }),
    ).toBe(false);
    expect(reloaded.isApproved("/elsewhere", server)).toBe(false);
  });

  test("updating a server entry keeps the rest of the user config", async () => {
    const { root } = await sandbox();
    const file = join(root, "config.json");
    await writeFile(file, JSON.stringify({ model: "x/y", mcpServers: { a: { command: "a" } } }));
    await updateUserServerEntry(file, "a", { enabled: false });
    await updateUserServerEntry(file, "b", { enabled: false });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      model: "x/y",
      mcpServers: { a: { command: "a", enabled: false }, b: { enabled: false } },
    });
  });

  test("JSONC keeps comment-like text inside strings", () => {
    expect(parseJsonc('{ "url": "https://x//y", /* c */ "a": [1,], }')).toEqual({
      url: "https://x//y",
      a: [1],
    });
  });
});
