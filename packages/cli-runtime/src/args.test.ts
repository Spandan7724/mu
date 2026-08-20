import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpText, parseArgs, usageLine } from "./args.ts";
import { echoProduct } from "./testing/product.ts";

const product = echoProduct({ dataDir: await mkdtemp(join(tmpdir(), "mu-args-")) });

describe("parseArgs", () => {
  test("defaults to the interactive app", () => {
    expect(parseArgs([]).mode).toBe("tui");
  });

  test("--resume selects a saved session on interactive and headless surfaces", () => {
    const args = parseArgs(["--resume", "019fa562-3975-71e6-b7a1-ed63c54f1fac"]);
    expect(args.mode).toBe("tui");
    expect(args.resumeSessionId).toBe("019fa562-3975-71e6-b7a1-ed63c54f1fac");
    expect(args.errors).toEqual([]);
    expect(parseArgs(["--resume"]).errors[0]).toContain("requires a session id");
    const headless = parseArgs(["-p", "hello", "--resume", "session-id"]);
    expect(headless.errors).toEqual([]);
    expect(headless.resumeSessionId).toBe("session-id");
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
    expect(helpText(product)).toContain("--no-instructions");
  });

  test("unknown flags and bad numbers are reported", () => {
    expect(parseArgs(["--nope"]).errors[0]).toContain("Unknown flag");
    expect(parseArgs(["-p", "x", "--max-turns", "abc"]).errors[0]).toContain("expects a number");
    expect(parseArgs(["-p"]).errors[0]).toContain("requires a prompt");
  });

  test("budget flags reject non-finite and invalid boundary values", () => {
    for (const value of ["0", "-1", "1.5", "Infinity"]) {
      expect(parseArgs(["--max-turns", value]).errors).not.toEqual([]);
    }
    for (const value of ["-0.01", "Infinity", "-Infinity"]) {
      expect(parseArgs(["--max-cost", value]).errors).not.toEqual([]);
    }
    expect(parseArgs(["--max-cost", "0"]).errors).toEqual([]);
  });

  test("--rpc and --help select their modes", () => {
    expect(parseArgs(["--rpc"]).mode).toBe("rpc");
    expect(parseArgs(["--help"]).mode).toBe("help");
    expect(parseArgs(["-v"]).mode).toBe("version");
  });
});

describe("product-owned argv", () => {
  test("a product token is claimed with its arity and never seen as a flag", () => {
    const args = parseArgs(["--label", "beta", "-p", "hello"], product);
    expect(args.errors).toEqual([]);
    expect(args.product.label).toBe("beta");
    expect(args.prompt).toBe("hello");
  });

  test("a product token the runtime does not know is still an unknown flag", () => {
    expect(parseArgs(["--label", "beta"]).errors[0]).toContain("Unknown flag: --label");
  });

  test("product argument errors join the runtime's own", () => {
    expect(parseArgs(["--label"], product).errors).toEqual(["--label requires a value"]);
  });
});

describe("helpText", () => {
  test("branding, the default profile, and product sections come from the descriptor", () => {
    const text = helpText(product);
    expect(text.startsWith("echo-agent — a product with no domain at all\n")).toBe(true);
    expect(text).toContain("  echo-agent               start the interactive terminal app");
    expect(text).toContain("--profile <name>     profile to load (default: echo)");
    expect(text).toContain("--label <text>       record a label in the session environment");
    expect(text).not.toContain("mu ");
  });

  test("descriptions align in one column regardless of command length", () => {
    expect(usageLine("mu", "x")).toBe(`  mu${" ".repeat(23)}x`);
    expect(usageLine("mu --resume <session>", "x")).toBe("  mu --resume <session>    x");
  });
});
