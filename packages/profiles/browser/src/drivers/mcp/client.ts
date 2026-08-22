// The concrete stdio sidecar client.
//
// It reuses the Model Context Protocol SDK client Mu already depends on and the
// abort/timeout lifecycle `packages/sdk/src/mcp.ts` established — connect with a
// startup timeout, call with `{ signal, timeout }` so a cancelled operation sends
// the protocol's own cancellation and leaves the connection reusable, pipe stderr
// rather than inheriting it, and close the transport on every failure path.
//
// It reaches that SDK through `mu`'s own resolution root instead of importing it
// directly. `@mu/profile-browser` does not declare the SDK, and its manifest is
// not this lane's to change; loading it lazily keeps the dependency exactly where
// it already is, keeps `drivers/` type-checkable without it, and keeps it out of
// every test that injects a sidecar instead.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { BrowserDriverError } from "../../contracts/driver.ts";
import type {
  McpCallOptions,
  McpContent,
  McpServerIdentity,
  McpSidecar,
  McpSidecarLauncher,
  McpToolResult,
} from "./protocol.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

interface SdkClient {
  connect(transport: unknown, options: { timeout: number }): Promise<void>;
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    schema: undefined,
    options: { signal: AbortSignal; timeout: number; maxTotalTimeout: number },
  ): Promise<unknown>;
  getServerVersion(): { name?: string; version?: string } | undefined;
  close(): Promise<void>;
}

interface SdkModule {
  Client: new (info: { name: string; version: string }) => SdkClient;
  StdioClientTransport: new (
    options: Record<string, unknown>,
  ) => {
    stderr?: { on(event: "data", listener: (chunk: unknown) => void): void } | undefined;
    close(): Promise<void>;
  };
  getDefaultEnvironment(): Record<string, string>;
}

let cached: Promise<SdkModule> | undefined;

async function loadSdk(): Promise<SdkModule> {
  const require_ = createRequire(import.meta.resolve("mu"));
  const load = async (specifier: string): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(require_.resolve(specifier)).href)) as Record<string, unknown>;
  const index = await load("@modelcontextprotocol/sdk/client/index.js");
  const stdio = await load("@modelcontextprotocol/sdk/client/stdio.js");
  return {
    Client: index.Client as SdkModule["Client"],
    StdioClientTransport: stdio.StdioClientTransport as SdkModule["StdioClientTransport"],
    getDefaultEnvironment: stdio.getDefaultEnvironment as SdkModule["getDefaultEnvironment"],
  };
}

export function mcpSdk(): Promise<SdkModule> {
  cached ??= loadSdk();
  return cached;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return true;
  }
  const code = (error as { code?: unknown } | null)?.code;
  // The protocol's own cancellation, returned when a call is aborted mid-flight.
  return code === -32001;
}

function isTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32001) return false;
  return error instanceof Error && /timed? ?out/i.test(error.message);
}

export function normalizeSidecarFailure(error: unknown, what: string): BrowserDriverError {
  if (error instanceof BrowserDriverError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (isAbortError(error)) return new BrowserDriverError("aborted", `${what} was cancelled`);
  if (isTimeout(error)) return new BrowserDriverError("timeout", `${what} timed out: ${message}`);
  if (/connection closed|EPIPE|ECONNRESET|process exited|closed/i.test(message)) {
    return new BrowserDriverError(
      "connection-lost",
      `the browser bridge disconnected during ${what}: ${message}`,
      { cause: error },
    );
  }
  if (/target (page|frame|browser) .*closed|browser has been closed|crash/i.test(message)) {
    return new BrowserDriverError("browser-crashed", `the browser stopped: ${message}`, {
      cause: error,
    });
  }
  if (/unsupported|unknown tool|not found: browser_/i.test(message)) {
    return new BrowserDriverError("protocol-mismatch", `${what} is not supported: ${message}`, {
      cause: error,
    });
  }
  return new BrowserDriverError("connection-lost", `${what} failed: ${message}`, { cause: error });
}

function toolResult(value: unknown): McpToolResult {
  const record = (value ?? {}) as { content?: unknown; isError?: unknown };
  const content = Array.isArray(record.content) ? (record.content as McpContent[]) : [];
  return { content, ...(record.isError === true ? { isError: true } : {}) };
}

// A live sidecar. Every operation is abort-aware; nothing here retries, because a
// retried browser call can repeat an external effect (BD18).
export const stdioSidecarLauncher: McpSidecarLauncher = async (spec, signal) => {
  if (signal.aborted) throw new BrowserDriverError("aborted", "sidecar start was cancelled");
  const sdk = await mcpSdk().catch((error: unknown) => {
    throw new BrowserDriverError(
      "unsupported",
      `the Model Context Protocol client could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });

  const transport = new sdk.StdioClientTransport({
    command: spec.runtime,
    args: [spec.cli, ...spec.args],
    env: { ...sdk.getDefaultEnvironment(), ...(spec.env ?? {}) },
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    stderr: "pipe",
  });
  const diagnostics: string[] = [];
  transport.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    // Bounded: a chatty sidecar must not become an unbounded buffer, and the text
    // is never surfaced to the model.
    if (text.length > 0 && diagnostics.length < 50) diagnostics.push(text.slice(0, 2_000));
  });

  const client = new sdk.Client({ name: "mu-browser", version: "0.0.1" });
  const startupTimeout = spec.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  try {
    await client.connect(transport, { timeout: startupTimeout });
  } catch (error) {
    await transport.close().catch(() => {});
    const tail = diagnostics.slice(-3).join(" | ");
    throw normalizeSidecarFailure(
      error instanceof Error && tail.length > 0 ? new Error(`${error.message} (${tail})`) : error,
      "starting the browser bridge",
    );
  }

  const callTimeout = spec.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sidecar: McpSidecar = {
    async callTool(name, args, options: McpCallOptions) {
      if (options.signal.aborted) {
        throw new BrowserDriverError("aborted", `${name} was cancelled before it started`);
      }
      const timeout = options.timeoutMs ?? callTimeout;
      try {
        return toolResult(
          await client.callTool({ name, arguments: args }, undefined, {
            signal: options.signal,
            timeout,
            // A deadline, not an orphaned operation: the sidecar is told to stop.
            maxTotalTimeout: timeout,
          }),
        );
      } catch (error) {
        throw normalizeSidecarFailure(error, name);
      }
    },
    serverIdentity(): McpServerIdentity | undefined {
      const version = client.getServerVersion();
      if (version?.name === undefined || version.version === undefined) return undefined;
      return { name: version.name, version: version.version };
    },
    async close() {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
  return sidecar;
};
