import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "mu-test-fixture", version: "1.0.0" },
  { capabilities: { resources: {} } },
);

server.registerTool(
  "echo",
  {
    description: "Echo text with a value supplied through the server environment.",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({
    content: [
      {
        type: "text",
        text: `${process.env.MCP_FIXTURE_VALUE ?? "fixture"}:${text}`,
      },
    ],
  }),
);

server.registerTool(
  "slow",
  {
    description: "Wait until the requested delay elapses or the caller cancels.",
    inputSchema: { delayMs: z.number().int().positive() },
  },
  async ({ delayMs }, { signal }) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("fixture cancelled"));
        },
        { once: true },
      );
    });
    return { content: [{ type: "text", text: "finished waiting" }] };
  },
);

server.registerResource(
  "fixture-note",
  "fixture://note",
  { description: "A deterministic test resource", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: "fixture resource body" }],
  }),
);

await server.connect(new StdioServerTransport());
