import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;
type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: unknown;
  method?: string;
  params?: unknown;
};

const directory = import.meta.dir;
const executable = resolve(directory, "node_modules/.bin/playwright-mcp");

class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private stdout = "";

  async start(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    this.child = spawn(executable, args, { cwd: directory, env: { ...process.env, ...env } });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => process.stderr.write(`[sidecar] ${chunk}`));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.once("exit", (code, signal) => {
      const error = new Error(`sidecar exited code=${String(code)} signal=${String(signal)}`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mu-browser-b0-spike", version: "0.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    if (signal?.aborted) throw signal.reason;
    const promise = new Promise<unknown>((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
    });
    const abort = () => {
      this.notify("notifications/cancelled", { requestId: id, reason: "B0 cancellation probe" });
      this.pending.get(id)?.reject(new Error("request aborted"));
      this.pending.delete(id);
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.write({ jsonrpc: "2.0", id, method, params });
    try {
      return await promise;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const child = this.child;
    if (!child) return { code: null, signal: null };
    child.stdin.end();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      },
    );
    const timeout = setTimeout(() => child.kill("SIGTERM"), 3000);
    try {
      return await exited;
    } finally {
      clearTimeout(timeout);
      this.child = undefined;
    }
  }

  private write(message: JsonObject): void {
    if (!this.child?.stdin.writable) throw new Error("sidecar stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as RpcResponse;
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }
}

function parseArgs(argv: string[]): {
  serverArgs: string[];
  calls: { name: string; arguments: JsonObject }[];
} {
  const separator = argv.indexOf("--calls");
  if (separator < 0)
    throw new Error("usage: mcp-client.ts <server args...> --calls '<JSON array>'");
  const serverArgs = argv.slice(0, separator);
  const raw = argv[separator + 1];
  if (!raw) throw new Error("missing calls JSON");
  const calls = JSON.parse(raw) as { name: string; arguments: JsonObject }[];
  return { serverArgs, calls };
}

const { serverArgs, calls } = parseArgs(process.argv.slice(2));
const client = new StdioMcpClient();
const startedAt = Date.now();

try {
  await client.start(serverArgs, {});
  const tools = (await client.request("tools/list", {})) as {
    tools?: { name: string; inputSchema: unknown }[];
  };
  console.log(
    JSON.stringify(
      { event: "initialized", ms: Date.now() - startedAt, tools: tools.tools },
      null,
      2,
    ),
  );
  for (const call of calls) {
    const result = await client.request("tools/call", call);
    console.log(JSON.stringify({ event: "tool-result", call, result }, null, 2));
  }
} finally {
  const stoppedAt = Date.now();
  const exit = await client.stop();
  console.log(
    JSON.stringify({ event: "sidecar-exit", ms: Date.now() - stoppedAt, ...exit }, null, 2),
  );
}
