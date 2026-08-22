// The narrow MCP surface the Playwright sidecar is driven through. The adapter is
// written against this rather than against a concrete client, so the whole driver
// is exercisable without a browser and no module under `drivers/` needs the MCP
// SDK resolvable at type-check time.
//
// BD25/BD31: the tool names named in `driver.ts` are the only ones Mu ever calls,
// and nothing in this module is reachable from a model-visible tool.

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpImageContent {
  type: "image";
  mimeType: string;
  data: string;
}

export type McpContent = McpTextContent | McpImageContent | { type: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean | undefined;
}

export interface McpCallOptions {
  signal: AbortSignal;
  timeoutMs?: number | undefined;
}

export interface McpServerIdentity {
  name: string;
  version: string;
}

export interface McpSidecar {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<McpToolResult>;
  serverIdentity(): McpServerIdentity | undefined;
  // Ends the helper process. It never closes a browser: closing an owned browser
  // is a `browser_close` call the caller makes and awaits first (BD29).
  close(): Promise<void>;
}

// Everything needed to start one sidecar. `runtime` and `cli` are absolute paths
// that already exist: nothing here resolves a package name at runtime, downloads
// code, or runs `npx` (BD31).
export interface McpSidecarSpec {
  runtime: string;
  cli: string;
  args: readonly string[];
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  startupTimeoutMs?: number | undefined;
  callTimeoutMs?: number | undefined;
}

export type McpSidecarLauncher = (spec: McpSidecarSpec, signal: AbortSignal) => Promise<McpSidecar>;

export function textOf(result: McpToolResult): string {
  return result.content
    .filter((block): block is McpTextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function imageOf(result: McpToolResult): McpImageContent | undefined {
  return result.content.find((block): block is McpImageContent => block.type === "image");
}
