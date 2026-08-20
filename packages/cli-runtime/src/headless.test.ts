import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_VERSION } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { ExtensionHost, MemorySessionStore, SessionTree, userMessage } from "mu";
import { parseArgs } from "./args.ts";
import { EXIT, runHeadless } from "./headless.ts";
import { echoProduct } from "./testing/product.ts";

const product = echoProduct({ dataDir: await mkdtemp(join(tmpdir(), "mu-headless-")) });

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (c: string) => out.push(c), stderr: (c: string) => err.push(c) },
  };
}

describe("runHeadless", () => {
  // Passing tools explicitly opts out of profile loading, so these tests
  // exercise the headless plumbing rather than any product's profile.
  const base = (provider: FakeProvider) => ({ provider, model: fakeModel, tools: [] });
  const args = (argv: string[]) => parseArgs(argv, product);

  test("streams assistant text and exits 0", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "the answer" }] }]);
    const { out, io: sink } = io();
    const code = await runHeadless(product, args(["-p", "ask"]), base(provider), sink);
    expect(code).toBe(EXIT.done);
    expect(out.join("")).toContain("the answer");
  });

  test("resumes stored context before injecting the headless prompt", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "continued" }] }]);
    const store = new MemorySessionStore();
    const tree = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: "resume-me",
      createdAt: new Date(0).toISOString(),
      profile: "test",
      environment: {},
    });
    tree.appendMessage(userMessage("earlier context"));
    await store.save("resume-me", tree);
    const { io: sink } = io();

    const code = await runHeadless(
      product,
      args(["-p", "new prompt", "--resume", "resume-me"]),
      { ...base(provider), session: store },
      sink,
    );

    expect(code).toBe(EXIT.done);
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain("earlier context");
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain("new prompt");
  });

  test("--json emits one serialized event per line", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]);
    const { out, io: sink } = io();
    const code = await runHeadless(product, args(["-p", "ask", "--json"]), base(provider), sink);
    expect(code).toBe(EXIT.done);

    const lines = out.join("").trim().split("\n");
    const events = lines.map((line) => JSON.parse(line));
    expect(events[0].type).toBe("agent_start");
    expect(events[events.length - 1].type).toBe("agent_end");
    // Every line must be independently parseable — this is the RPC wire shape.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("built-in commands run headlessly without calling the provider", async () => {
    const provider = new FakeProvider([]);
    const { out, io: sink } = io();
    const code = await runHeadless(
      product,
      args(["-p", "/model anthropic/claude-opus-5"]),
      base(provider),
      sink,
    );

    expect(code).toBe(EXIT.done);
    expect(provider.callCount).toBe(0);
    expect(out.join("")).toContain("Model set to anthropic/claude-opus-5");
  });

  test("/compact is wired in headless mode", async () => {
    const provider = new FakeProvider([]);
    const { out, io: sink } = io();
    const code = await runHeadless(product, args(["-p", "/compact"]), base(provider), sink);

    expect(code).toBe(EXIT.done);
    expect(provider.callCount).toBe(0);
    expect(out.join("")).toContain("already compact enough");
  });

  test("headless commands have a JSON result shape", async () => {
    const provider = new FakeProvider([]);
    const { out, io: sink } = io();
    const code = await runHeadless(product, args(["-p", "/model", "--json"]), base(provider), sink);

    expect(code).toBe(EXIT.done);
    expect(provider.callCount).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({
      type: "command_result",
      message: "Current model: fake/fake-1",
    });
  });

  test("extension commands join the headless registry", async () => {
    const provider = new FakeProvider([]);
    const extensions = new ExtensionHost();
    await extensions.register({
      name: "demo",
      activate: (api) =>
        api.registerCommand({
          name: "demo",
          description: "Demo command",
          run: (ctx) => ({ handled: true, message: `extension says ${ctx.args}` }),
        }),
    });
    const { out, io: sink } = io();
    const code = await runHeadless(
      product,
      args(["-p", "/demo hello"]),
      { ...base(provider), extensions },
      sink,
    );

    expect(code).toBe(EXIT.done);
    expect(provider.callCount).toBe(0);
    expect(out.join("")).toContain("extension says hello");
  });

  test("a provider error exits 1 and reports the actual message", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "" }], errorMessage: "upstream exploded" },
    ]);
    const { err, io: sink } = io();
    const code = await runHeadless(product, args(["-p", "ask"]), base(provider), sink);
    expect(code).toBe(EXIT.error);
    // The provider's own message must survive to the user — a generic
    // "an error occurred" hides actionable causes like a missing API key.
    expect(err.join("")).toContain("upstream exploded");
  });

  test("hitting a budget exits 3", async () => {
    const provider = new FakeProvider(
      Array.from({ length: 5 }, (_, i) => ({
        content: [{ type: "toolCall" as const, id: `c${i}`, name: "missing", arguments: {} }],
      })),
    );
    const { err, io: sink } = io();
    const code = await runHeadless(
      product,
      args(["-p", "loop", "--max-turns", "2"]),
      base(provider),
      sink,
    );
    expect(code).toBe(3);
    expect(err.join("")).toContain("halted early");
  });

  test("a missing prompt exits 2 and is reported under the product's own name", async () => {
    const provider = new FakeProvider([]);
    const { err, io: sink } = io();
    const code = await runHeadless(
      product,
      {
        mode: "headless",
        product: {},
        json: false,
        allowAll: false,
        noInstructions: false,
        errors: [],
      },
      base(provider),
      sink,
    );
    expect(code).toBe(EXIT.usage);
    expect(err.join("")).toBe("echo-agent: -p requires a prompt\n");
  });
});
