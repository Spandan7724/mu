import { describe, expect, test } from "bun:test";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { parseArgs } from "./args.ts";
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
  const base = (provider: FakeProvider) => ({ provider, model: fakeModel });

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

  test("a provider error exits 1", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "" }], errorMessage: "upstream exploded" },
    ]);
    const { err, io: sink } = io();
    const code = await runHeadless(parseArgs(["-p", "ask"]), base(provider), sink);
    expect(code).toBe(EXIT.error);
    expect(err.join("")).toContain("error");
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
      { mode: "headless", json: false, allowAll: false, errors: [] },
      base(provider),
      sink,
    );
    expect(code).toBe(EXIT.usage);
  });
});
