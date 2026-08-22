// The executable proof that the seam is real: a product with no domain at all
// drives the interactive, headless, and RPC surfaces, and nothing in this file
// or in the runtime it exercises reaches for a coding tool, prompt, command,
// renderer, or UI module.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Terminal } from "@mu/tui";
import { ExtensionHost, FileSessionStore } from "mu";
import { parseArgs } from "./args.ts";
import { EXIT, runHeadless } from "./headless.ts";
import { runInteractive } from "./interactive.ts";
import { runRpc } from "./rpc.ts";
import { createCliSessionRuntime } from "./session-runtime.ts";
import { echoProduct } from "./testing/product.ts";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mu-neutral-product-"));
  roots.push(root);
  return root;
}

async function fakeModelHost(): Promise<ExtensionHost> {
  const host = new ExtensionHost();
  await host.register({ name: "fake-model", activate: (api) => api.registerModels([fakeModel]) });
  return host;
}

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (c: string) => out.push(c), stderr: (c: string) => err.push(c) },
  };
}

describe("a non-coding product composes every runtime surface", () => {
  test("headless runs the product's own profile and records its identity", async () => {
    const root = await dataDir();
    const product = echoProduct({ dataDir: root });
    const provider = new FakeProvider([{ content: [{ type: "text", text: "echoed" }] }]);
    const { out, io } = sink();

    const args = parseArgs(["-p", "say it", "--label", "beta", "--model", "fake/fake-1"], product);
    const code = await runHeadless(
      product,
      args,
      { provider, extensions: await fakeModelHost() },
      io,
    );

    expect(code).toBe(EXIT.done);
    expect(out.join("")).toContain("echoed");
    expect(product.profileCalls).toBe(1);

    // The header carries the product's real profile identity and the bounded
    // environment its profile produced, including the product-parsed --label.
    const store = new FileSessionStore({ root: join(root, "sessions"), scope: "echo" });
    const saved = await store.list();
    expect(saved).toHaveLength(1);
    const tree = await store.load(saved[0] as string);
    expect(tree?.header?.profile).toBe("echo");
    expect(tree?.header?.environment).toEqual({ surface: "echo", label: "beta" });
  });

  test("RPC drives the same composition and reaches the product's own toolset", async () => {
    const root = await dataDir();
    const product = echoProduct({ dataDir: root });
    const provider = new FakeProvider([
      {
        content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "through rpc" } }],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const runtime = await createCliSessionRuntime({
      cwd: root,
      product,
      productOptions: {},
      model: "fake/fake-1",
      permissions: "forward",
      agentOptions: { provider, extensions: await fakeModelHost() },
    });

    const written: Record<string, unknown>[] = [];
    await runRpc(
      {
        write: (line) => written.push(JSON.parse(line) as Record<string, unknown>),
        lines: (async function* () {
          yield JSON.stringify({ type: "input", text: "go", operationId: "run" });
          yield JSON.stringify({ type: "shutdown", operationId: "stop" });
        })(),
      },
      { agent: runtime.agent, cancelPermissions: runtime.cancelPermissions },
    );
    await runtime.agent.shutdown();

    expect(written[0]).toMatchObject({ type: "ready" });
    expect(written.at(-1)).toMatchObject({ type: "shutdown" });
    const toolEnd = written.find(
      (message) =>
        message.type === "event" &&
        (message.event as { type?: string }).type === "tool_execution_end",
    );
    expect(JSON.stringify(toolEnd)).toContain("through rpc");
    expect(runtime.agent.sessionProfile).toBe("echo");
  });

  test("the interactive surface reports under the product's own command name", async () => {
    const root = await dataDir();
    const product = echoProduct({ dataDir: root });
    const messages: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      messages.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // A non-tty terminal forces the interactive entry point's first branch —
      // enough to prove branding reaches it from the descriptor.
      const terminal = new Terminal({
        write: () => {},
        columns: 80,
        rows: 24,
        isTty: false,
      });
      const code = await runInteractive(product, parseArgs([], product), { terminal });
      expect(code).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(messages.join("")).toBe("echo-agent: not a terminal — use -p for headless mode\n");
  });

  test("the runtime offers no shell or file mentions to a product without them", () => {
    const product = echoProduct({ dataDir: "/tmp/unused" });
    expect(product.capabilities?.directShell).toBeUndefined();
    expect(product.capabilities?.fileMentions).toBeUndefined();
    expect(product.renderers).toBeUndefined();
  });

  test("permission modes and commands come from the product's profile alone", async () => {
    const root = await dataDir();
    const product = echoProduct({ dataDir: root });
    const runtime = await createCliSessionRuntime({
      cwd: root,
      product,
      productOptions: {},
      model: "fake/fake-1",
      permissionMode: "yolo",
      permissions: "deny",
      agentOptions: { provider: new FakeProvider([]), extensions: await fakeModelHost() },
    });
    try {
      expect(runtime.profile?.name).toBe("echo");
      expect(runtime.permissionMode?.id).toBe("yolo");
      expect(runtime.permissionModes.map((mode) => mode.id)).toEqual(["default", "yolo"]);
      expect(runtime.agentOptions.tools?.map((tool) => tool.name)).toEqual(["echo"]);
      // Kernel commands are present; no coding command is.
      const commands = runtime.commands.list().map((command) => command.name);
      expect(commands).toContain("compact");
      expect(commands).not.toContain("instructions");
    } finally {
      await runtime.agent.shutdown();
    }
  });

  test("a product-supplied environment is validated before it reaches a header", async () => {
    const root = await dataDir();
    const product = echoProduct({
      dataDir: root,
      environment: { "not a key": "v" } as Record<string, string>,
    });
    await expect(
      createCliSessionRuntime({
        cwd: root,
        product,
        productOptions: {},
        model: "fake/fake-1",
        permissions: "deny",
        agentOptions: { provider: new FakeProvider([]), extensions: await fakeModelHost() },
      }),
    ).rejects.toThrow("Invalid session environment key");
  });
});
