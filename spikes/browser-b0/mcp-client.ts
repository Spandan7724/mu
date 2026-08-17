import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

type JsonObject = Record<string, unknown>;

const directory = dirname(fileURLToPath(import.meta.url));
const cli = resolve(directory, "node_modules/@playwright/mcp/cli.js");
const sidecarRuntime = process.env.B0_SIDECAR_RUNTIME || process.execPath;
const sidecarCli = process.env.B0_SIDECAR_CLI || cli;

function parseArgs(argv: string[]): {
  serverArgs: string[];
  calls: { name: string; arguments: JsonObject; abortAfterMs?: number }[];
} {
  const separator = argv.indexOf("--calls");
  if (separator < 0)
    throw new Error("usage: mcp-client.ts <server args...> --calls '<JSON array>'");
  const serverArgs = argv.slice(0, separator);
  const raw = argv[separator + 1];
  if (!raw) throw new Error("missing calls JSON");
  const calls = JSON.parse(raw) as { name: string; arguments: JsonObject; abortAfterMs?: number }[];
  return { serverArgs, calls };
}

const { serverArgs, calls } = parseArgs(process.argv.slice(2));
const transport = new StdioClientTransport({
  command: sidecarRuntime,
  args: [sidecarCli, ...serverArgs],
  cwd: directory,
  env: {
    ...getDefaultEnvironment(),
    ...(process.env.DEBUG ? { DEBUG: process.env.DEBUG } : {}),
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(`[sidecar] ${String(chunk)}`));

const client = new Client({ name: "mu-browser-b0-spike", version: "0.0.0" });
const startedAt = Date.now();

try {
  console.error(`[client] starting ${sidecarRuntime} ${sidecarCli} ${serverArgs.join(" ")}`);
  await client.connect(transport, { timeout: 10_000 });
  const tools = await client.listTools(undefined, { timeout: 10_000 });
  console.log(
    JSON.stringify(
      {
        event: "initialized",
        ms: Date.now() - startedAt,
        sidecarPid: transport.pid,
        serverVersion: client.getServerVersion(),
        toolNames: tools.tools.map((tool) => tool.name),
      },
      null,
      2,
    ),
  );

  for (const call of calls) {
    const controller = new AbortController();
    const timer = call.abortAfterMs
      ? setTimeout(() => controller.abort("B0 cancellation probe"), call.abortAfterMs)
      : undefined;
    const callStartedAt = Date.now();
    try {
      const result = await client.callTool(
        { name: call.name, arguments: call.arguments },
        undefined,
        { signal: controller.signal, timeout: 90_000 },
      );
      console.log(
        JSON.stringify(
          { event: "tool-result", ms: Date.now() - callStartedAt, call, result },
          null,
          2,
        ),
      );
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            event: "tool-error",
            ms: Date.now() - callStartedAt,
            call,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
} finally {
  const stoppedAt = Date.now();
  await client.close();
  console.log(JSON.stringify({ event: "sidecar-exit", ms: Date.now() - stoppedAt }, null, 2));
}
