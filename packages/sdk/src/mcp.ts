// Built-in extension: MCP. The model sees one line per server; `mcp_open` returns a
// server's tool signatures (or a name index for large servers), `mcp_describe` fills in
// signatures, and `mcp_call` validates and calls. Servers connect on first use; tool
// lists are cached so the listing names tools before a server has ever started.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CallToolResult,
  type ContentBlock,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type CommandContext, type Extension, errorResult, type ToolResult } from "@mu/core";
import {
  type CatalogTool,
  describeText,
  isLargeServer,
  listingLine,
  openText,
  type ServerCatalog,
  validateArgs,
} from "./mcp-catalog.ts";
import {
  expandTransport,
  type McpApprovals,
  type McpConfigReport,
  type McpServerSpec,
  type McpTransport,
  transportFingerprint,
  updateUserServerEntry,
} from "./mcp-config.ts";
import { refreshedSnapshot } from "./skills.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const MAX_TEXT_CHARS = 50_000;
export const MCP_CONTEXT_TYPE = "mcp_servers";

function bounded(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const half = Math.floor(MAX_TEXT_CHARS / 2);
  return `${text.slice(0, half)}\n\n… [${text.length - half * 2} characters omitted] …\n\n${text.slice(-half)}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function segment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function contentBlock(block: ContentBlock): ToolResult["content"] {
  if (block.type === "text") return [{ type: "text", text: bounded(block.text) }];
  if (block.type === "image") {
    return [{ type: "image", mimeType: block.mimeType, data: block.data, evictable: true }];
  }
  if (block.type === "audio") {
    return [
      {
        type: "text",
        text: `[audio ${block.mimeType}, ${block.data.length.toLocaleString()} base64 characters]`,
      },
    ];
  }
  if (block.type === "resource_link") {
    return [
      {
        type: "text",
        text: bounded(
          safeJson({
            type: block.type,
            uri: block.uri,
            name: block.name,
            ...(block.description ? { description: block.description } : {}),
            ...(block.mimeType ? { mimeType: block.mimeType } : {}),
          }),
        ),
      },
    ];
  }
  return resourceContent(block.resource);
}

function resourceContent(
  resource: { uri: string; mimeType?: string | undefined } & ({ text: string } | { blob: string }),
): ToolResult["content"] {
  if ("text" in resource)
    return [{ type: "text", text: bounded(`[resource ${resource.uri}]\n${resource.text}`) }];
  if (resource.mimeType?.startsWith("image/")) {
    return [{ type: "image", mimeType: resource.mimeType, data: resource.blob, evictable: true }];
  }
  return [
    {
      type: "text",
      text: `[resource ${resource.uri}, ${resource.mimeType ?? "application/octet-stream"}, ${resource.blob.length.toLocaleString()} base64 characters]`,
    },
  ];
}

function toolResult(result: CallToolResult): ToolResult {
  const content = result.content.flatMap(contentBlock);
  if (content.length === 0 && result.structuredContent !== undefined) {
    content.push({ type: "text", text: bounded(safeJson(result.structuredContent)) });
  }
  if (content.length === 0) content.push({ type: "text", text: "(no content)" });
  return {
    content,
    ...(result.structuredContent !== undefined
      ? { details: { structuredContent: result.structuredContent } }
      : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

function matcher(patterns: string[] | undefined): ((name: string) => boolean) | undefined {
  if (!patterns) return undefined;
  const regexes = patterns.map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ),
  );
  return (name) => regexes.some((regex) => regex.test(name));
}

type Status = "idle" | "connecting" | "ready" | "failed";

interface ServerState {
  spec: McpServerSpec;
  status: Status;
  client?: Client | undefined;
  connecting?: Promise<Client> | undefined;
  starting?: Transport | undefined;
  catalog?: ServerCatalog | undefined;
  error?: string | undefined;
}

export interface McpExtensionOptions {
  servers: McpServerSpec[];
  shadowed?: McpServerSpec[];
  errors?: McpConfigReport["errors"];
  // Project root that project-scoped servers and approvals belong to.
  projectDir?: string;
  approvals?: McpApprovals;
  // Where tool lists are cached (default ~/.mu/mcp/catalog); false disables caching.
  cacheDir?: string | false;
  // User config that /mcp enable and /mcp disable write to.
  userFile?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  // Connect mu-configured servers in the background at startup (default true).
  warm?: boolean;
}

const OPEN_DESCRIPTION =
  "Open a connected MCP server to see its tools. Small servers return every tool signature; large servers return the tool names, so get the signatures you need with mcp_describe. Then call tools with mcp_call.";

export function mcpExtension(options: McpExtensionOptions): Extension {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const cacheDir =
    options.cacheDir === false
      ? undefined
      : (options.cacheDir ?? join(home, ".mu", "mcp", "catalog"));
  const states = new Map<string, ServerState>(
    options.servers.map((spec) => [spec.name, { spec, status: "idle" as Status }]),
  );
  const extra: Record<string, string> = {
    userHome: home,
    ...(options.projectDir ? { workspaceFolder: options.projectDir } : {}),
  };

  const needsApproval = (spec: McpServerSpec) =>
    spec.scope === "project" &&
    !(options.projectDir && options.approvals?.isApproved(options.projectDir, spec));

  const cacheFile = (spec: McpServerSpec) =>
    cacheDir ? join(cacheDir, `${transportFingerprint(spec.transport)}.json`) : undefined;

  const filtered = (spec: McpServerSpec, tools: CatalogTool[]) => {
    const include = matcher(spec.includeTools);
    const exclude = matcher(spec.excludeTools);
    return tools.filter((tool) => (!include || include(tool.name)) && !exclude?.(tool.name));
  };

  const loadCached = async (state: ServerState) => {
    const file = cacheFile(state.spec);
    if (!file) return;
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as ServerCatalog;
      if (Array.isArray(cached.tools))
        state.catalog = { ...cached, tools: filtered(state.spec, cached.tools) };
    } catch {
      // No cached tool list yet.
    }
  };

  const saveCatalog = async (spec: McpServerSpec, catalog: ServerCatalog) => {
    const file = cacheFile(spec);
    if (!file || !cacheDir) return;
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(catalog)}\n`, { mode: 0o600 }).catch(() => {});
  };

  const makeTransport = (transport: McpTransport, fallbackSse = false): Transport => {
    if (transport.type === "stdio") {
      return new StdioClientTransport({
        command: transport.command,
        ...(transport.args ? { args: transport.args } : {}),
        env: { ...getDefaultEnvironment(), ...(transport.env ?? {}) },
        ...(transport.cwd
          ? { cwd: transport.cwd }
          : options.projectDir
            ? { cwd: options.projectDir }
            : {}),
        stderr: "ignore",
      });
    }
    const requestInit = transport.headers ? { headers: transport.headers } : undefined;
    const url = new URL(transport.url);
    return (
      transport.type === "sse" || fallbackSse
        ? new SSEClientTransport(url, requestInit ? { requestInit } : undefined)
        : new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined)
    ) as Transport;
  };

  const fetchCatalog = async (client: Client, spec: McpServerSpec): Promise<ServerCatalog> => {
    const timeout = spec.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const tools: CatalogTool[] = [];
    if (client.getServerCapabilities()?.tools) {
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
        for (const tool of page.tools) {
          const entry: CatalogTool = {
            name: tool.name,
            inputSchema: tool.inputSchema as Record<string, unknown>,
          };
          if (tool.description) entry.description = tool.description;
          if (tool.annotations)
            entry.annotations = tool.annotations as NonNullable<CatalogTool["annotations"]>;
          tools.push(entry);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    const instructions = client.getInstructions();
    const info = client.getServerVersion();
    return {
      ...(info
        ? {
            serverInfo: {
              name: info.name,
              version: info.version,
              ...(info.title ? { title: info.title } : {}),
            },
          }
        : {}),
      ...(instructions ? { instructions } : {}),
      tools,
      resources: Boolean(client.getServerCapabilities()?.resources),
      fetchedAt: Date.now(),
    };
  };

  let closed = false;
  const connect = (state: ServerState): Promise<Client> => {
    if (closed) return Promise.reject(new Error("MCP is shut down"));
    if (state.client && state.status === "ready") return Promise.resolve(state.client);
    if (state.connecting) return state.connecting;
    const { spec } = state;
    state.status = "connecting";
    state.connecting = (async () => {
      const expanded = expandTransport(spec.transport, env, extra);
      if (expanded.missing.length > 0) {
        throw new Error(
          `missing environment variable${expanded.missing.length === 1 ? "" : "s"} ${expanded.missing.join(", ")}`,
        );
      }
      const timeout = spec.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
      const attempt = async (fallbackSse: boolean) => {
        const client = new Client({ name: "mu", version: "0.2" });
        const transport = makeTransport(expanded.transport, fallbackSse);
        state.starting = transport;
        try {
          await client.connect(transport, { timeout });
          return client;
        } catch (error) {
          await client.close().catch(() => {});
          throw error;
        } finally {
          state.starting = undefined;
        }
      };
      let client: Client;
      try {
        client = await attempt(false);
      } catch (error) {
        // Older servers speak only the HTTP+SSE transport.
        if (expanded.transport.type !== "http" || !/\b(404|405)\b/.test(message(error)))
          throw error;
        client = await attempt(true);
      }
      client.onclose = () => {
        if (state.client === client) {
          state.client = undefined;
          state.status = "idle";
        }
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          const catalog = await fetchCatalog(client, spec);
          await saveCatalog(spec, catalog);
          state.catalog = { ...catalog, tools: filtered(spec, catalog.tools) };
        } catch {
          // Keep the previous list; the next open refreshes it.
        }
      });
      const catalog = await fetchCatalog(client, spec);
      if (closed) {
        await client.close().catch(() => {});
        throw new Error("MCP is shut down");
      }
      await saveCatalog(spec, catalog);
      state.catalog = { ...catalog, tools: filtered(spec, catalog.tools) };
      state.client = client;
      state.status = "ready";
      state.error = undefined;
      return client;
    })();
    state.connecting
      .catch((error) => {
        state.status = "failed";
        state.error = message(error);
      })
      .finally(() => {
        state.connecting = undefined;
      });
    return state.connecting;
  };

  const disconnect = async (state: ServerState) => {
    const client = state.client;
    state.client = undefined;
    state.status = "idle";
    await client?.close().catch(() => {});
  };

  const serverNames = () =>
    [...states.values()]
      .filter((state) => state.spec.enabled && state.spec.exposure === "open")
      .map((s) => s.spec.name);

  // Resolves a usable server, or the error text the model should see.
  const usable = async (name: unknown, signal: AbortSignal): Promise<ServerState | string> => {
    const state = typeof name === "string" ? states.get(name) : undefined;
    if (!state || state.spec.exposure !== "open") {
      return `Unknown MCP server ${String(name)}. Servers: ${serverNames().join(", ") || "none"}`;
    }
    if (!state.spec.enabled)
      return `MCP server ${state.spec.name} is disabled. The user can enable it with /mcp enable ${state.spec.name}.`;
    if (needsApproval(state.spec)) {
      return `MCP server ${state.spec.name} is defined by this project (${state.spec.file}) and has not been approved. Ask the user to review it and run /mcp approve ${state.spec.name}.`;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        const onAbort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        connect(state).then(
          () => resolve(),
          (error) => reject(error),
        );
      });
      return state;
    } catch (error) {
      return `Could not connect MCP server ${state.spec.name}: ${message(error)}`;
    }
  };

  const listing = () => {
    const lines = [...states.values()]
      .filter((state) => state.spec.enabled && state.spec.exposure === "open")
      .map((state) =>
        listingLine(state.spec.name, {
          ...(state.spec.description ? { description: state.spec.description } : {}),
          ...(state.catalog ? { catalog: state.catalog } : {}),
          ...(needsApproval(state.spec)
            ? { note: `needs the user's approval: /mcp approve ${state.spec.name}` }
            : {}),
        }),
      );
    if (lines.length === 0) return "";
    return [
      "MCP servers. Open one with mcp_open to see its tools (large servers list tool names; get their signatures with mcp_describe), then call tools with mcp_call.",
      ...lines,
    ].join("\n");
  };

  const callTool = async (
    state: ServerState,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate?: (partial: ToolResult["content"]) => void,
  ): Promise<ToolResult> => {
    const client = await connect(state);
    const timeout = state.spec.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const result = await client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: timeout * 10,
      onprogress: ({ progress, total }) => {
        onUpdate?.([
          {
            type: "text",
            text: `mcp progress ${progress}${total === undefined ? "" : `/${total}`}`,
          },
        ]);
      },
    });
    if (!Array.isArray((result as { content?: unknown }).content)) {
      return {
        content: [
          {
            type: "text",
            text: bounded(safeJson((result as { toolResult?: unknown }).toolResult)),
          },
        ],
      };
    }
    return toolResult(result as CallToolResult);
  };

  const resourceCall = async (
    state: ServerState,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    const client = await connect(state);
    const timeout = state.spec.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    if (tool === "resources/list") {
      const resources: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listResources(cursor ? { cursor } : undefined, {
          signal,
          timeout,
        });
        resources.push(...page.resources);
        cursor = page.nextCursor;
      } while (cursor);
      return { content: [{ type: "text" as const, text: bounded(safeJson(resources)) }] };
    }
    if (typeof args.uri !== "string" || !args.uri)
      return errorResult("resources/read needs a string uri");
    const result = await client.readResource({ uri: args.uri }, { signal, timeout });
    const content = result.contents.flatMap((resource) =>
      resourceContent(resource as Parameters<typeof resourceContent>[0]),
    );
    return { content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty)" }] };
  };

  const statusLine = (state: ServerState) => {
    const { spec } = state;
    const status = !spec.enabled
      ? "disabled"
      : needsApproval(spec)
        ? "needs approval"
        : state.status === "ready"
          ? "connected"
          : state.status === "failed"
            ? "failed"
            : state.status === "connecting"
              ? "connecting"
              : "not started";
    const tools = state.catalog
      ? `${state.catalog.tools.length} tools${state.status === "ready" ? "" : " (cached)"}${isLargeServer(state.catalog) ? ", opens as index" : ""}`
      : "tools unknown";
    const where = `${spec.source} ${spec.scope} · ${spec.file}`;
    return { status, tools, where, error: state.error };
  };

  const report = () => {
    const all = [...states.values()];
    if (all.length === 0 && (options.shadowed ?? []).length === 0) {
      return "No MCP servers configured. Add them under mcpServers in ~/.mu/config.json or .mu/config.json; servers configured for Claude Code, Codex, Cursor, opencode, Gemini and VS Code are picked up automatically.";
    }
    const width = Math.max(...all.map((state) => state.spec.name.length), 4);
    const lines = [`MCP servers (${all.length})`];
    for (const state of all) {
      const line = statusLine(state);
      lines.push(
        `  ${state.spec.name.padEnd(width)}  ${line.status.padEnd(14)} ${line.tools}${state.spec.exposure === "direct" ? " · direct tools" : ""}`,
      );
      lines.push(`  ${" ".repeat(width)}  ${line.where}`);
      if (line.error && line.status === "failed")
        lines.push(`  ${" ".repeat(width)}  error: ${line.error}`);
    }
    if ((options.shadowed ?? []).length > 0) {
      lines.push("Skipped (same name or same command/URL as a server above):");
      for (const spec of options.shadowed ?? [])
        lines.push(`  ${spec.name}  ${spec.source} ${spec.scope} · ${spec.file}`);
    }
    for (const error of options.errors ?? [])
      lines.push(`warning: ${error.file}: ${error.message}`);
    lines.push(
      "Commands: /mcp approve <name> · /mcp enable <name> · /mcp disable <name> · /mcp reconnect <name>",
    );
    return lines.join("\n");
  };

  const runCommand = async (ctx: CommandContext) => {
    const [action = "", name = ""] = ctx.args.trim().split(/\s+/);
    if (!action) return report();
    const state = states.get(name);
    if (!state) return `Unknown MCP server: ${name || "(none)"}`;
    switch (action) {
      case "approve": {
        if (state.spec.scope !== "project")
          return `${name} is not defined by this project; nothing to approve.`;
        if (!options.projectDir || !options.approvals)
          return "Project approvals are unavailable in this session.";
        await options.approvals.approve(options.projectDir, state.spec);
        const transport = state.spec.transport;
        return `Approved ${name}: ${transport.type === "stdio" ? [transport.command, ...(transport.args ?? [])].join(" ") : transport.url}`;
      }
      case "enable":
      case "disable": {
        if (!options.userFile) return "No user config is available to record this.";
        const enabled = action === "enable";
        await updateUserServerEntry(options.userFile, name, { enabled });
        state.spec.enabled = enabled;
        if (!enabled) await disconnect(state);
        return `${enabled ? "Enabled" : "Disabled"} ${name} (saved in ${options.userFile}).`;
      }
      case "reconnect": {
        await disconnect(state);
        try {
          await connect(state);
          return `Reconnected ${name}: ${state.catalog?.tools.length ?? 0} tools.`;
        } catch (error) {
          return `Could not connect ${name}: ${message(error)}`;
        }
      }
      default:
        return `Unknown action: ${action}. Use approve, enable, disable or reconnect.`;
    }
  };

  return {
    name: "mcp",
    activate: async (api) => {
      await Promise.all([...states.values()].map(loadCached));

      // Direct servers register one tool per remote tool, so their list must be known now.
      const usedNames = new Set<string>();
      for (const state of states.values()) {
        const { spec } = state;
        if (spec.exposure !== "direct" || !spec.enabled || needsApproval(spec)) continue;
        if (!state.catalog) {
          try {
            await connect(state);
          } catch (error) {
            api.log(`could not connect ${spec.name}: ${message(error)}`);
            continue;
          }
        }
        for (const remote of state.catalog?.tools ?? []) {
          let toolName = `mcp_${segment(spec.name, "server")}_${segment(remote.name, "tool")}`;
          for (let suffix = 2; usedNames.has(toolName); suffix++)
            toolName = `${toolName}_${suffix}`;
          usedNames.add(toolName);
          api.registerTool({
            name: toolName,
            description:
              remote.description ?? `Run the ${remote.name} tool of the ${spec.name} MCP server.`,
            inputSchema: remote.inputSchema,
            ...(remote.annotations?.readOnlyHint && !remote.annotations.destructiveHint
              ? { isConcurrencySafe: () => true }
              : {}),
            execute: async (_id, args, signal, onUpdate) => {
              try {
                return await callTool(state, remote.name, args, signal, onUpdate);
              } catch (error) {
                return errorResult(
                  `MCP tool ${spec.name}/${remote.name} failed: ${message(error)}`,
                );
              }
            },
          });
        }
      }

      if ((options.warm ?? true) === true) {
        for (const state of states.values()) {
          const { spec } = state;
          if (
            spec.source === "mu" &&
            spec.enabled &&
            spec.exposure === "open" &&
            !needsApproval(spec)
          ) {
            void connect(state).catch(() => {});
          }
        }
      }

      api.registerCommand({
        name: "mcp",
        description: "List MCP servers; approve, enable, disable or reconnect one",
        run: async (ctx) => {
          ctx.print(await runCommand(ctx));
          return { handled: true };
        },
      });

      if (![...states.values()].some((state) => state.spec.exposure === "open")) return;

      api.registerContextProvider((messages) =>
        refreshedSnapshot(messages, MCP_CONTEXT_TYPE, listing()),
      );

      api.registerTool({
        name: "mcp_open",
        description: OPEN_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string", description: "Server name from the MCP servers list" },
          },
          required: ["server"],
          additionalProperties: false,
        },
        isConcurrencySafe: () => true,
        permissionPattern: (args: { server?: string }) => args.server ?? "",
        execute: async (_id, args: { server?: unknown }, signal) => {
          const state = await usable(args.server, signal);
          if (typeof state === "string") return errorResult(state);
          const catalog = state.catalog ?? { tools: [], resources: false, fetchedAt: Date.now() };
          return {
            content: [{ type: "text", text: openText(state.spec.name, catalog) }],
            details: { server: state.spec.name, tools: catalog.tools.length },
            retention: {
              key: `mcp_open:${state.spec.name}`,
              summary: `[tool list of ${state.spec.name} superseded by a later mcp_open]`,
            },
          };
        },
      });

      api.registerTool({
        name: "mcp_describe",
        description: "Get the call signatures of specific tools of an MCP server.",
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string" },
            tools: { type: "array", items: { type: "string" }, description: "Tool names" },
          },
          required: ["server", "tools"],
          additionalProperties: false,
        },
        isConcurrencySafe: () => true,
        permissionPattern: (args: { server?: string }) => args.server ?? "",
        execute: async (_id, args: { server?: unknown; tools?: unknown }, signal) => {
          const state = await usable(args.server, signal);
          if (typeof state === "string") return errorResult(state);
          const names = Array.isArray(args.tools) ? args.tools.map(String) : [];
          const catalog = state.catalog ?? { tools: [], resources: false, fetchedAt: Date.now() };
          return {
            content: [{ type: "text", text: describeText(state.spec.name, catalog, names) }],
          };
        },
      });

      api.registerTool({
        name: "mcp_call",
        description:
          'Call a tool of an MCP server with its arguments. Resources: tool "resources/list" or "resources/read" with {"uri": …}.',
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string" },
            tool: { type: "string", description: "Tool name as the server lists it" },
            arguments: { type: "object", description: "Tool arguments" },
          },
          required: ["server", "tool"],
          additionalProperties: false,
        },
        isConcurrencySafe: (args: { server?: string; tool?: string }) => {
          const tool = states
            .get(args.server ?? "")
            ?.catalog?.tools.find((candidate) => candidate.name === args.tool);
          return Boolean(tool?.annotations?.readOnlyHint && !tool.annotations.destructiveHint);
        },
        permissionPattern: (args: { server?: string; tool?: string }) =>
          `${args.server ?? ""}/${args.tool ?? ""}`,
        execute: async (
          _id,
          args: { server?: unknown; tool?: unknown; arguments?: unknown },
          signal,
          onUpdate,
        ) => {
          const state = await usable(args.server, signal);
          if (typeof state === "string") return errorResult(state);
          const name = typeof args.tool === "string" ? args.tool : "";
          const callArgs =
            typeof args.arguments === "object" &&
            args.arguments !== null &&
            !Array.isArray(args.arguments)
              ? (args.arguments as Record<string, unknown>)
              : {};
          try {
            if (name === "resources/list" || name === "resources/read") {
              return await resourceCall(state, name, callArgs, signal);
            }
            const tool = state.catalog?.tools.find((candidate) => candidate.name === name);
            if (!tool) {
              return errorResult(
                `Unknown tool ${name} on ${state.spec.name}. Tools: ${(state.catalog?.tools ?? []).map((t) => t.name).join(", ")}`,
              );
            }
            const problems = validateArgs(callArgs, tool.inputSchema);
            if (problems.length > 0) {
              return errorResult(
                `Invalid arguments for ${state.spec.name}/${name}: ${problems.join("; ")}\nInput schema: ${JSON.stringify(tool.inputSchema)}`,
              );
            }
            return await callTool(state, name, callArgs, signal, onUpdate);
          } catch (error) {
            return errorResult(`MCP tool ${state.spec.name}/${name} failed: ${message(error)}`);
          }
        },
      });
    },
    deactivate: async () => {
      closed = true;
      // A connection still starting would otherwise finish after shutdown and keep the process alive.
      await Promise.allSettled([...states.values()].map((state) => state.starting?.close()));
      await Promise.allSettled([...states.values()].map((state) => state.connecting));
      await Promise.allSettled([...states.values()].map(disconnect));
    },
  };
}
