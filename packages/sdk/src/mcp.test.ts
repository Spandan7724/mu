import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentMessage, ExtensionHost, type PermissionRequest } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";
import { MCP_CONTEXT_TYPE, mcpExtension } from "./mcp.ts";
import { loadMcpApprovals, type McpServerSpec } from "./mcp-config.ts";

const fixture = fileURLToPath(new URL("./testing/mcp-fixture-server.ts", import.meta.url));
const activeHosts: ExtensionHost[] = [];
const signal = () => new AbortController().signal;

afterEach(async () => {
  await Promise.allSettled(activeHosts.splice(0).map((host) => host.shutdown()));
});

function text(content: { type: string; text?: string }[] | undefined): string {
  return (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function spec(overrides: Partial<McpServerSpec> = {}): McpServerSpec {
  return {
    name: "fixture",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [fixture],
      env: { MCP_FIXTURE_VALUE: "connected" },
    },
    source: "mu",
    scope: "user",
    file: "/config.json",
    enabled: true,
    exposure: "open",
    startupTimeoutMs: 10_000,
    ...overrides,
  };
}

async function host(
  servers: McpServerSpec[],
  extra: Partial<Parameters<typeof mcpExtension>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mu-mcp-"));
  const instance = new ExtensionHost();
  activeHosts.push(instance);
  await instance.register(
    mcpExtension({
      servers,
      cacheDir: join(root, "catalog"),
      userFile: join(root, "config.json"),
      home: root,
      warm: false,
      ...extra,
    }),
  );
  return { host: instance, root };
}

function listingText(messages: AgentMessage[]): string {
  const message = messages.find((m) => m.role === "custom" && m.customType === MCP_CONTEXT_TYPE);
  return message?.role === "custom"
    ? text(message.content as { type: string; text?: string }[])
    : "";
}

describe("MCP open exposure", () => {
  test("registers three fixed tools and lists servers before connecting", async () => {
    const { host: h } = await host([spec()]);
    expect([...h.tools.keys()].sort()).toEqual(["mcp_call", "mcp_describe", "mcp_open"]);
    const listing = listingText(await h.runContextProviders([], { sessionId: "s" }));
    expect(listing).toContain("- fixture: (not connected yet; mcp_open connects it)");
  });

  test("opening connects, returns signatures, and caches the tool list for the listing", async () => {
    const { host: h, root } = await host([spec()]);
    const opened = await h.tools.get("mcp_open")?.execute("1", { server: "fixture" }, signal());
    const body = text(opened?.content);
    expect(body).toContain(
      "echo(text: string) — Echo text with a value supplied through the server environment.",
    );
    expect(body).toContain('"resources/list"');
    expect(opened?.retention?.key).toBe("mcp_open:fixture");
    expect(await readdir(join(root, "catalog"))).toHaveLength(1);

    const listing = listingText(await h.runContextProviders([], { sessionId: "s" }));
    expect(listing).toContain("- fixture: Tools: echo, slow");

    const { host: fresh } = await host([spec()], { cacheDir: join(root, "catalog") });
    expect(listingText(await fresh.runContextProviders([], { sessionId: "s" }))).toContain(
      "Tools: echo, slow",
    );
  });

  test("mcp_call validates against the real schema, calls, and reads resources", async () => {
    const { host: h } = await host([spec()]);
    const call = h.tools.get("mcp_call");
    const invalid = await call?.execute(
      "1",
      { server: "fixture", tool: "echo", arguments: { text: 3 } },
      signal(),
    );
    expect(invalid?.isError).toBe(true);
    expect(text(invalid?.content)).toContain("arguments.text must be string");
    expect(text(invalid?.content)).toContain("Input schema:");

    const ok = await call?.execute(
      "2",
      { server: "fixture", tool: "echo", arguments: { text: "hi" } },
      signal(),
    );
    expect(text(ok?.content)).toBe("connected:hi");
    expect(call?.isConcurrencySafe?.({ server: "fixture", tool: "echo" })).toBe(true);
    expect(call?.isConcurrencySafe?.({ server: "fixture", tool: "slow" })).toBe(false);
    expect(call?.permissionPattern?.({ server: "fixture", tool: "echo" })).toBe("fixture/echo");

    const listed = await call?.execute(
      "3",
      { server: "fixture", tool: "resources/list" },
      signal(),
    );
    expect(text(listed?.content)).toContain("fixture://note");
    const read = await call?.execute(
      "4",
      { server: "fixture", tool: "resources/read", arguments: { uri: "fixture://note" } },
      signal(),
    );
    expect(text(read?.content)).toContain("fixture resource body");

    const unknown = await call?.execute(
      "5",
      { server: "fixture", tool: "nope", arguments: {} },
      signal(),
    );
    expect(text(unknown?.content)).toContain("Tools: echo, slow");
    const describe = await h.tools
      .get("mcp_describe")
      ?.execute("6", { server: "fixture", tools: ["slow"] }, signal());
    expect(text(describe?.content)).toBe(
      "slow(delayMs: number) — Wait until the requested delay elapses or the caller cancels.",
    );
  });

  test("an abort cancels an in-flight call without closing the connection", async () => {
    const { host: h } = await host([spec()]);
    const call = h.tools.get("mcp_call");
    const controller = new AbortController();
    const waiting = call?.execute(
      "1",
      { server: "fixture", tool: "slow", arguments: { delayMs: 5_000 } },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 200);
    expect((await waiting)?.isError).toBe(true);
    const after = await call?.execute(
      "2",
      { server: "fixture", tool: "echo", arguments: { text: "after" } },
      signal(),
    );
    expect(text(after?.content)).toBe("connected:after");
  });

  test("excludeTools hides tools from the list and from calls", async () => {
    const { host: h } = await host([spec({ excludeTools: ["slow"] })]);
    const opened = await h.tools.get("mcp_open")?.execute("1", { server: "fixture" }, signal());
    expect(text(opened?.content)).not.toContain("slow(");
    const call = await h.tools
      .get("mcp_call")
      ?.execute("2", { server: "fixture", tool: "slow", arguments: { delayMs: 1 } }, signal());
    expect(call?.isError).toBe(true);
  });
});

describe("MCP lifecycle", () => {
  test("shutting down while a server is still connecting closes it and refuses later use", async () => {
    const { host: h } = await host([spec()], { warm: true });
    const started = Date.now();
    await h.shutdown();
    expect(Date.now() - started).toBeLessThan(5_000);
    const after = await h.tools.get("mcp_open")?.execute("1", { server: "fixture" }, signal());
    expect(text(after?.content)).toContain("shut down");
    activeHosts.splice(activeHosts.indexOf(h), 1);
  });
});

describe("MCP trust and control", () => {
  test("a project-defined server runs only after /mcp approve", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-mcp-trust-"));
    const approvals = await loadMcpApprovals(join(root, "approvals.json"));
    const { host: h } = await host([spec({ scope: "project", file: join(root, ".mcp.json") })], {
      projectDir: root,
      approvals,
    });
    const blocked = await h.tools.get("mcp_open")?.execute("1", { server: "fixture" }, signal());
    expect(text(blocked?.content)).toContain("/mcp approve fixture");
    expect(listingText(await h.runContextProviders([], { sessionId: "s" }))).toContain(
      "needs the user's approval",
    );

    const printed: string[] = [];
    const ctx = (args: string) => ({
      args,
      inject: () => {},
      print: (line: string) => void printed.push(line),
      getModel: () => "m",
      setModel: () => {},
    });
    await h.commands.get("mcp")?.run(ctx("approve fixture"));
    expect(printed.at(-1)).toContain("Approved fixture");
    const opened = await h.tools.get("mcp_open")?.execute("2", { server: "fixture" }, signal());
    expect(text(opened?.content)).toContain("echo(");
    expect(
      JSON.parse(await readFile(join(root, "approvals.json"), "utf8")).projects[root].fixture,
    ).toBeString();
  });

  test("/mcp disable records the choice in the user config and refuses use", async () => {
    const { host: h, root } = await host([spec()]);
    const printed: string[] = [];
    await h.commands.get("mcp")?.run({
      args: "disable fixture",
      inject: () => {},
      print: (line) => void printed.push(line),
      getModel: () => "m",
      setModel: () => {},
    });
    expect(
      JSON.parse(await readFile(join(root, "config.json"), "utf8")).mcpServers.fixture,
    ).toEqual({ enabled: false });
    const refused = await h.tools.get("mcp_open")?.execute("1", { server: "fixture" }, signal());
    expect(text(refused?.content)).toContain("disabled");
  });

  test("direct exposure registers one tool per remote tool, as before", async () => {
    const { host: h } = await host([spec({ exposure: "direct" })]);
    expect(h.tools.has("mcp_fixture_echo")).toBe(true);
    expect(h.tools.has("mcp_open")).toBe(false);
    const echoed = await h.tools.get("mcp_fixture_echo")?.execute("1", { text: "d" }, signal());
    expect(text(echoed?.content)).toBe("connected:d");
  });

  test("calls pass through the Agent permission engine keyed by server/tool", async () => {
    const { host: h } = await host([spec()]);
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "mcp_call",
            arguments: { server: "fixture", tool: "echo", arguments: { text: "from-agent" } },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const asked: PermissionRequest[] = [];
    const agent = new Agent({
      provider,
      model: fakeModel,
      extensions: h,
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      onPermission: async (request) => {
        asked.push(request);
        return "allow";
      },
    });
    const result = await agent.run("use the echo tool");
    expect(asked.map((request) => `${request.toolName} ${request.pattern}`)).toEqual([
      "mcp_call fixture/echo",
    ]);
    const tool = result.messages.find((message) => message.role === "toolResult");
    expect(tool?.role === "toolResult" && text(tool.content)).toBe("connected:from-agent");
    expect(listingText(agent.session.messagesAt())).toContain("- fixture:");
    await agent.shutdown();
    activeHosts.splice(activeHosts.indexOf(h), 1);
  });
});
