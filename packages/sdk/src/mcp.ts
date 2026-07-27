import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { type Extension, errorResult, type ToolResult } from "@mu/core";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const MAX_TEXT_CHARS = 50_000;

export interface McpStdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export interface McpConfigReport {
  servers: Record<string, McpStdioServerConfig>;
  errors: { file: string; message: string }[];
}

export interface LoadMcpConfigOptions {
  projectDir?: string;
  userFile?: string;
}

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

  const resource = block.resource;
  if ("text" in resource) {
    return [
      {
        type: "text",
        text: bounded(`[resource ${resource.uri}]\n${resource.text}`),
      },
    ];
  }
  if (resource.mimeType?.startsWith("image/")) {
    return [
      {
        type: "image",
        mimeType: resource.mimeType,
        data: resource.blob,
        evictable: true,
      },
    ];
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

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function validPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseServer(value: unknown, baseDir: string): McpStdioServerConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.command !== "string" || record.command.trim().length === 0) return undefined;
  if (
    record.args !== undefined &&
    (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string"))
  ) {
    return undefined;
  }
  if (
    record.env !== undefined &&
    (typeof record.env !== "object" ||
      record.env === null ||
      Array.isArray(record.env) ||
      Object.values(record.env).some((item) => typeof item !== "string"))
  ) {
    return undefined;
  }
  if (record.cwd !== undefined && typeof record.cwd !== "string") return undefined;
  if (record.startupTimeoutMs !== undefined && !validPositive(record.startupTimeoutMs)) {
    return undefined;
  }
  if (record.toolTimeoutMs !== undefined && !validPositive(record.toolTimeoutMs)) return undefined;

  const cwd =
    typeof record.cwd === "string"
      ? isAbsolute(record.cwd)
        ? record.cwd
        : resolve(baseDir, record.cwd)
      : undefined;
  return {
    command: record.command,
    ...(record.args ? { args: record.args as string[] } : {}),
    ...(record.env ? { env: record.env as Record<string, string> } : {}),
    ...(cwd ? { cwd } : {}),
    ...(record.startupTimeoutMs ? { startupTimeoutMs: record.startupTimeoutMs as number } : {}),
    ...(record.toolTimeoutMs ? { toolTimeoutMs: record.toolTimeoutMs as number } : {}),
  };
}

async function configFile(
  file: string,
): Promise<{ servers: Record<string, McpStdioServerConfig>; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
    return { servers: {}, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const parsed = JSON.parse(raw) as { mcpServers?: unknown };
    if (typeof parsed !== "object" || parsed === null || parsed.mcpServers === undefined) {
      return { servers: {} };
    }
    if (
      typeof parsed.mcpServers !== "object" ||
      parsed.mcpServers === null ||
      Array.isArray(parsed.mcpServers)
    ) {
      return { servers: {}, error: "mcpServers must be an object" };
    }

    const servers: Record<string, McpStdioServerConfig> = {};
    const invalid: string[] = [];
    for (const [name, value] of Object.entries(parsed.mcpServers)) {
      const config = parseServer(value, dirname(file));
      if (config) servers[name] = config;
      else invalid.push(name);
    }
    return {
      servers,
      ...(invalid.length > 0
        ? {
            error: `invalid MCP server config${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`,
          }
        : {}),
    };
  } catch (error) {
    return { servers: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

// User config loads first; project config overrides servers with the same name.
export async function loadMcpConfig(options: LoadMcpConfigOptions = {}): Promise<McpConfigReport> {
  const files = [
    options.userFile ?? join(homedir(), ".mu", "config.json"),
    ...(options.projectDir ? [join(options.projectDir, ".mu", "config.json")] : []),
  ];
  const servers: Record<string, McpStdioServerConfig> = {};
  const errors: McpConfigReport["errors"] = [];
  for (const file of files) {
    const loaded = await configFile(file);
    Object.assign(servers, loaded.servers);
    if (loaded.error) errors.push({ file, message: loaded.error });
  }
  return { servers, errors };
}

async function allResources(client: Client, signal: AbortSignal, timeout: number) {
  const resources: Awaited<ReturnType<Client["listResources"]>>["resources"] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listResources(cursor ? { cursor } : undefined, { signal, timeout });
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);
  return resources;
}

export function mcpExtension(servers: Record<string, McpStdioServerConfig>): Extension {
  const clients: Client[] = [];

  return {
    name: "mcp",
    activate: async (api) => {
      const usedNames = new Set<string>();
      for (const [serverName, config] of Object.entries(servers)) {
        const serverSegment = segment(serverName, "server");
        const client = new Client({ name: "mu", version: "0.0.1" });
        const transport = new StdioClientTransport({
          command: config.command,
          ...(config.args ? { args: config.args } : {}),
          env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
          ...(config.cwd ? { cwd: config.cwd } : {}),
          stderr: "pipe",
        });
        transport.stderr?.on("data", (chunk) => {
          const text = String(chunk).trim();
          if (text) api.log(`${serverName}: ${text}`);
        });

        try {
          await client.connect(transport, {
            timeout: config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
          });
        } catch (error) {
          await transport.close().catch(() => {});
          api.log(
            `could not connect ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        clients.push(client);

        const timeout = config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
        const remoteTools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
        let cursor: string | undefined;
        try {
          do {
            const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
            remoteTools.push(...page.tools);
            cursor = page.nextCursor;
          } while (cursor);
        } catch (error) {
          clients.pop();
          await client.close().catch(() => {});
          api.log(
            `could not discover tools from ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        for (const remote of remoteTools) {
          let name = `mcp_${serverSegment}_${segment(remote.name, "tool")}`;
          let suffix = 2;
          while (usedNames.has(name)) name = `${name}_${suffix++}`;
          usedNames.add(name);
          api.registerTool({
            name,
            description:
              remote.description ??
              `Run the ${remote.name} tool provided by the ${serverName} MCP server.`,
            inputSchema: remote.inputSchema as Record<string, unknown>,
            ...(remote.annotations?.readOnlyHint && !remote.annotations.destructiveHint
              ? { isConcurrencySafe: () => true }
              : {}),
            execute: async (_toolCallId, args, signal, onUpdate) => {
              try {
                const result = await client.callTool(
                  { name: remote.name, arguments: args },
                  undefined,
                  {
                    signal,
                    timeout,
                    resetTimeoutOnProgress: true,
                    maxTotalTimeout: timeout,
                    onprogress: ({ progress, total }) => {
                      onUpdate?.([
                        {
                          type: "text",
                          text: `mcp progress ${progress}${total === undefined ? "" : `/${total}`}`,
                        },
                      ]);
                    },
                  },
                );
                if (!isCallToolResult(result)) {
                  return {
                    content: [{ type: "text", text: bounded(safeJson(result.toolResult)) }],
                  };
                }
                return toolResult(result);
              } catch (error) {
                return errorResult(
                  `MCP tool ${serverName}/${remote.name} failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            },
          });
        }

        if (!client.getServerCapabilities()?.resources) continue;
        const listName = `mcp_${serverSegment}_resources_list`;
        if (!usedNames.has(listName)) {
          usedNames.add(listName);
          api.registerTool({
            name: listName,
            description: `List resources exposed by the ${serverName} MCP server.`,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            isConcurrencySafe: () => true,
            execute: async (_toolCallId, _args, signal) => {
              try {
                return {
                  content: [
                    {
                      type: "text",
                      text: bounded(safeJson(await allResources(client, signal, timeout))),
                    },
                  ],
                };
              } catch (error) {
                return errorResult(
                  `Could not list MCP resources from ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            },
          });
        }

        const readName = `mcp_${serverSegment}_resource_read`;
        if (!usedNames.has(readName)) {
          usedNames.add(readName);
          api.registerTool({
            name: readName,
            description: `Read a resource exposed by the ${serverName} MCP server.`,
            inputSchema: {
              type: "object",
              properties: { uri: { type: "string", description: "Resource URI to read" } },
              required: ["uri"],
              additionalProperties: false,
            },
            isConcurrencySafe: () => true,
            execute: async (_toolCallId, args: { uri?: unknown }, signal) => {
              if (typeof args.uri !== "string" || args.uri.length === 0) {
                return errorResult("uri must be a non-empty string");
              }
              try {
                const result = await client.readResource({ uri: args.uri }, { signal, timeout });
                const content: ToolResult["content"] = [];
                for (const resource of result.contents) {
                  if ("text" in resource) {
                    content.push({
                      type: "text",
                      text: bounded(`[resource ${resource.uri}]\n${resource.text}`),
                    });
                    continue;
                  }
                  if (resource.mimeType?.startsWith("image/")) {
                    content.push({
                      type: "image",
                      mimeType: resource.mimeType,
                      data: resource.blob,
                      evictable: true,
                    });
                    continue;
                  }
                  content.push({
                    type: "text",
                    text: `[resource ${resource.uri}, ${resource.mimeType ?? "application/octet-stream"}, ${resource.blob.length.toLocaleString()} base64 characters]`,
                  });
                }
                return {
                  content: content.length > 0 ? content : [{ type: "text", text: "(empty)" }],
                };
              } catch (error) {
                return errorResult(
                  `Could not read MCP resource ${args.uri}: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            },
          });
        }
      }
    },
    deactivate: async () => {
      await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    },
  };
}
