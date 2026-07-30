import { describe, expect, test } from "bun:test";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { ExtensionHost } from "mu";
import { HELP_TEXT, parseArgs } from "./args.ts";
import { EXIT, runHeadless } from "./headless.ts";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (c: string) => out.push(c), stderr: (c: string) => err.push(c) },
  };
}

describe("parseArgs", () => {
  test("defaults to the interactive app", () => {
    expect(parseArgs([]).mode).toBe("tui");
  });

  test("--resume selects a saved interactive session", () => {
    const args = parseArgs(["--resume", "019fa562-3975-71e6-b7a1-ed63c54f1fac"]);
    expect(args.mode).toBe("tui");
    expect(args.resumeSessionId).toBe("019fa562-3975-71e6-b7a1-ed63c54f1fac");
    expect(args.errors).toEqual([]);
    expect(parseArgs(["--resume"]).errors[0]).toContain("requires a session id");
    expect(parseArgs(["-p", "hello", "--resume", "session-id"]).errors[0]).toContain(
      "interactive mode",
    );
  });

  test("-p selects headless and captures the prompt", () => {
    const args = parseArgs(["-p", "do the thing"]);
    expect(args.mode).toBe("headless");
    expect(args.prompt).toBe("do the thing");
    expect(args.json).toBe(false);
  });

  test("--json, --model and budget flags parse", () => {
    const args = parseArgs([
      "-p",
      "x",
      "--json",
      "--model",
      "anthropic/claude-opus-5",
      "--max-turns",
      "5",
      "--max-cost",
      "0.5",
    ]);
    expect(args.json).toBe(true);
    expect(args.model).toBe("anthropic/claude-opus-5");
    expect(args.maxTurns).toBe(5);
    expect(args.maxCostUsd).toBe(0.5);
    expect(args.errors).toEqual([]);
  });

  test("permission modes and the full-access alias parse", () => {
    expect(parseArgs(["--permission-mode", "plan-readonly"]).permissionMode).toBe("plan-readonly");
    expect(parseArgs(["--allow-all"]).allowAll).toBe(true);
    expect(parseArgs(["--permission-mode"]).errors[0]).toContain("requires a value");
  });

  test("instruction loading can be disabled for one invocation", () => {
    expect(parseArgs(["--no-instructions"]).noInstructions).toBe(true);
    expect(HELP_TEXT).toContain("--no-instructions");
  });

  test("unknown flags and bad numbers are reported", () => {
    expect(parseArgs(["--nope"]).errors[0]).toContain("Unknown flag");
    expect(parseArgs(["-p", "x", "--max-turns", "abc"]).errors[0]).toContain("expects a number");
    expect(parseArgs(["-p"]).errors[0]).toContain("requires a prompt");
  });

  test("--rpc and --help select their modes", () => {
    expect(parseArgs(["--rpc"]).mode).toBe("rpc");
    expect(parseArgs(["--help"]).mode).toBe("help");
    expect(parseArgs(["-v"]).mode).toBe("version");
  });
});

describe("runHeadless", () => {
  // Passing tools explicitly opts out of profile loading, so these tests
  // exercise the headless plumbing rather than the coding profile.
  const base = (provider: FakeProvider) => ({ provider, model: fakeModel, tools: [] });

  test("streams assistant text and exits 0", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "the answer" }] }]);
    const { out, io: sink } = io();
    const code = await runHeadless(parseArgs(["-p", "ask"]), base(provider), sink);
    expect(code).toBe(EXIT.done);
    expect(out.join("")).toContain("the answer");
  });

  test("--json emits one serialized event per line", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]);
    const { out, io: sink } = io();
    const code = await runHeadless(parseArgs(["-p", "ask", "--json"]), base(provider), sink);
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
      parseArgs(["-p", "/model anthropic/claude-opus-5"]),
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
    const code = await runHeadless(parseArgs(["-p", "/compact"]), base(provider), sink);

    expect(code).toBe(EXIT.done);
    expect(provider.callCount).toBe(0);
    expect(out.join("")).toContain("Compacting before the next turn.");
  });

  test("headless commands have a JSON result shape", async () => {
    const provider = new FakeProvider([]);
    const { out, io: sink } = io();
    const code = await runHeadless(parseArgs(["-p", "/model", "--json"]), base(provider), sink);

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
      parseArgs(["-p", "/demo hello"]),
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
    const code = await runHeadless(parseArgs(["-p", "ask"]), base(provider), sink);
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
      parseArgs(["-p", "loop", "--max-turns", "2"]),
      base(provider),
      sink,
    );
    expect(code).toBe(3);
    expect(err.join("")).toContain("halted early");
  });

  test("a missing prompt exits 2", async () => {
    const provider = new FakeProvider([]);
    const { io: sink } = io();
    const code = await runHeadless(
      {
        mode: "headless",
        json: false,
        allowAll: false,
        noInstructions: false,
        errors: [],
      },
      base(provider),
      sink,
    );
    expect(code).toBe(EXIT.usage);
  });
});
