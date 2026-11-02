import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_VERSION } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import {
  customMessage,
  ExtensionHost,
  MemorySessionStore,
  type ProfileRuntime,
  type ProfileRuntimeHost,
  SessionTree,
  userMessage,
} from "mu";
import { HELP_TEXT, parseArgs } from "./args.ts";
import { commandDataText, EXIT, runHeadless } from "./headless.ts";

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
    expect(HELP_TEXT).toContain("--no-instructions");
  });

  test("checkpoints can be turned off for one invocation", () => {
    expect(parseArgs(["--no-checkpoints"]).noCheckpoints).toBe(true);
    expect(parseArgs([]).noCheckpoints).toBe(false);
    expect(HELP_TEXT).toContain("--no-checkpoints");
  });

  test("help separates the coding and browser agents with their modes and commands", () => {
    const coding = HELP_TEXT.slice(
      HELP_TEXT.indexOf("Coding agent ("),
      HELP_TEXT.indexOf("Browser agent ("),
    );
    const browser = HELP_TEXT.slice(
      HELP_TEXT.indexOf("Browser agent ("),
      HELP_TEXT.indexOf("Options for both agents:"),
    );
    for (const mode of ["default", "accept-edits", "plan-readonly", "yolo", "/undo"])
      expect(coding).toContain(mode);
    for (const mode of ["supervised", "read-only", "autonomous", "--cdp", "/tabs"])
      expect(browser).toContain(mode);
    expect(coding).not.toContain("--cdp");
    expect(browser).not.toContain("--no-instructions");
  });

  test("help warns about -p denials up front and shows unattended examples for both agents", () => {
    const examples = HELP_TEXT.indexOf("Examples:");
    expect(HELP_TEXT.indexOf("With -p nothing can ask you")).toBeLessThan(examples);
    expect(HELP_TEXT.match(/nothing can ask/g)).toHaveLength(1);
    const section = HELP_TEXT.slice(examples, HELP_TEXT.indexOf("Coding agent ("));
    expect(section).toContain('mu -p "make the failing tests pass" --allow-all');
    expect(section).toContain("--permission-mode accept-edits");
    expect(section).toContain("--permission-mode autonomous");
    expect(section).toContain("mu browser login");
    const commands = section.split("\n").filter((line) => line.trim().startsWith("mu "));
    expect(commands).toHaveLength(7);
    for (const command of commands) {
      const argv = (command.match(/"[^"]*"|\S+/g) ?? []).map((token) =>
        token.replace(/^"|"$/g, ""),
      );
      expect(parseArgs(argv.slice(1)).errors).toEqual([]);
    }
  });

  test("web search has no startup mode", () => {
    expect(parseArgs(["--web-search", "live"]).errors[0]).toContain("Unknown flag");
    expect(HELP_TEXT).not.toContain("--web-search");
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

  test("agents is an explicit mode and does not change plain mu", () => {
    expect(parseArgs(["agents"]).mode).toBe("agents");
    expect(parseArgs(["agents", "stop"])).toMatchObject({ mode: "agents-stop", errors: [] });
    expect(parseArgs([]).mode).toBe("tui");
    expect(HELP_TEXT).toContain("mu agents");
    expect(HELP_TEXT).toContain("mu agents stop");
  });

  test("self update selects the package updater", () => {
    expect(parseArgs(["self", "update"])).toMatchObject({
      mode: "self-update",
      errors: [],
    });
    expect(parseArgs(["self"]).errors[0]).toContain('expects "update" or "uninstall"');
    expect(HELP_TEXT).toContain("mu self update");
  });

  test("self uninstall selects the uninstaller, and --purge opts into deleting ~/.mu", () => {
    expect(parseArgs(["self", "uninstall"])).toMatchObject({
      mode: "self-uninstall",
      purgeData: false,
      errors: [],
    });
    expect(parseArgs(["self", "uninstall", "--purge"])).toMatchObject({
      mode: "self-uninstall",
      purgeData: true,
      errors: [],
    });
    expect(parseArgs(["self", "remove"]).errors[0]).toContain('expects "update" or "uninstall"');
    expect(HELP_TEXT).toContain("mu self uninstall");
    expect(HELP_TEXT).toContain("--purge");
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
      parseArgs(["-p", "new prompt", "--resume", "resume-me"]),
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
    const code = await runHeadless(parseArgs(["-p", "ask", "--json"]), base(provider), sink);
    expect(code).toBe(EXIT.done);

    const lines = out.join("").trim().split("\n");
    const events = lines.map((line) => JSON.parse(line));
    expect(events[0].type).toBe("agent_start");
    expect(events.at(-2).type).toBe("agent_end");
    // The closing line names the session so a script can continue it with --resume.
    expect(events.at(-1)).toMatchObject({ type: "result", reason: "done" });
    expect(typeof events.at(-1).sessionId).toBe("string");
    expect(events.at(-1).usage.outputTokens).toBeGreaterThanOrEqual(0);
    // Every line must be independently parseable — this is the RPC wire shape.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("waits for a background subagent and its follow-up turn before exiting", async () => {
    const parent = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "bg",
            name: "task",
            arguments: { description: "slow work", prompt: "Work", run_in_background: true },
          },
        ],
      },
      { content: [{ type: "text", text: "started it" }] },
      { content: [{ type: "text", text: "child reported back" }] },
    ]);
    const child = new FakeProvider([
      { content: [{ type: "text", text: "child result" }], delayMs: 30 },
    ]);
    const provider = {
      id: "fake",
      stream: (...args: Parameters<FakeProvider["stream"]>) =>
        (args[1].systemPrompt ?? []).some((section) => section.text.includes("task subagent"))
          ? child.stream(...args)
          : parent.stream(...args),
    };
    const { out, io: sink } = io();

    const code = await runHeadless(
      parseArgs(["-p", "delegate"]),
      { provider, model: fakeModel, tools: [] },
      sink,
    );

    expect(code).toBe(EXIT.done);
    expect(out.join("")).toContain("started it");
    expect(out.join("")).toContain("child reported back");
    expect(JSON.stringify(parent.requests[2]?.messages)).toContain("child result");
  });

  test("built-in commands run headlessly without calling the provider", async () => {
    const provider = new FakeProvider([]);
    const { out, io: sink } = io();
    const code = await runHeadless(parseArgs(["-p", "/cost"]), base(provider), sink);

    expect(code).toBe(EXIT.done);
    expect(provider.callCount).toBe(0);
    expect(out.join("")).toContain("Session usage");
  });

  test("a command that submits a prompt, like a skill, runs it headlessly", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "reviewed" }] }]);
    const extensions = new ExtensionHost();
    await extensions.register({
      name: "review-skill",
      activate: (api) =>
        api.registerCommand({
          name: "review",
          description: "Review",
          run: (ctx) => ({
            handled: true,
            data: { kind: "markdown-command", prompt: `Review this: ${ctx.args}` },
          }),
        }),
    });
    const { out, io: sink } = io();
    const code = await runHeadless(
      parseArgs(["-p", "/review the parser"]),
      { ...base(provider), extensions },
      sink,
    );

    expect(code).toBe(EXIT.done);
    expect(provider.callCount).toBe(1);
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain("Review this: the parser");
    expect(out.join("")).toContain("reviewed");
  });

  test("/compact is wired in headless mode", async () => {
    const provider = new FakeProvider([]);
    const { out, io: sink } = io();
    const code = await runHeadless(parseArgs(["-p", "/compact"]), base(provider), sink);

    expect(code).toBe(EXIT.done);
    expect(provider.callCount).toBe(0);
    expect(out.join("")).toContain("already compact enough");
  });

  test("headless commands have a JSON result shape", async () => {
    const provider = new FakeProvider([]);
    const { out, io: sink } = io();
    const code = await runHeadless(parseArgs(["-p", "/cost", "--json"]), base(provider), sink);

    expect(code).toBe(EXIT.done);
    expect(provider.callCount).toBe(0);
    const result = JSON.parse(out.join(""));
    expect(result.type).toBe("command_result");
    expect(result.message).toStartWith("Session usage");
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

  test("a retried turn prints only the attempt that completed", async () => {
    const provider = new FakeProvider([
      {
        content: [{ type: "text", text: "partial words " }],
        errorMessage: "Our servers are currently overloaded. (server_is_overloaded)",
        errorKind: "overloaded",
        retryAfterMs: 1,
      },
      { content: [{ type: "text", text: "the answer" }] },
    ]);
    const { out, err, io: sink } = io();
    const code = await runHeadless(parseArgs(["-p", "ask"]), base(provider), sink);
    expect(code).toBe(EXIT.done);
    expect(out.join("").trim()).toBe("the answer");
    expect(err.join("")).toContain("retrying in 0s (1 of 4)");
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

  test("--thinking sets the run's level and rejects one the model lacks", async () => {
    expect(parseArgs(["-p", "x", "--thinking", "high"]).thinking).toBe("high");
    expect(parseArgs(["-p", "x", "--thinking"]).errors[0]).toContain("requires a level");
    const ok = io();
    expect(
      await runHeadless(
        parseArgs(["-p", "ask", "--thinking", "HIGH"]),
        base(new FakeProvider([{ content: [{ type: "text", text: "hi" }] }])),
        ok.io,
      ),
    ).toBe(EXIT.done);
    const bad = io();
    const code = await runHeadless(
      parseArgs(["-p", "ask", "--thinking", "ultra"]),
      base(new FakeProvider([])),
      bad.io,
    );
    expect(code).toBe(EXIT.usage);
    expect(bad.err.join("")).toContain('has no "ultra" level');
  });

  test("picker commands answer in text, and app-only commands say where they live", async () => {
    const run = async (prompt: string) => {
      const { out, io: sink } = io();
      const code = await runHeadless(parseArgs(["-p", prompt]), base(new FakeProvider([])), sink);
      return { code, out: out.join("") };
    };
    const thinking = await run("/thinking");
    expect(thinking.code).toBe(EXIT.done);
    expect(thinking.out).toMatch(/Thinking levels for fake\/fake-1: .*\(current\)/);
    expect((await run("/thinking high")).out).toContain("--thinking <level>");
    expect((await run("/model")).out).toContain("Current model: fake/fake-1");
    expect((await run("/model openai/gpt-5.1")).out).toContain("--model <ref>");
    expect((await run("/export")).out).toContain("Nothing to export yet.");
    expect((await run("/login")).out).toContain("/login is only available in the interactive app");
    expect((await run("/permissions")).out).toContain("pass --permission-mode or --allow-all");
  });

  test("--json listings carry structured data a harness can parse", async () => {
    const listing = async (prompt: string) => {
      const { out, io: sink } = io();
      await runHeadless(parseArgs(["-p", prompt, "--json"]), base(new FakeProvider([])), sink);
      return JSON.parse(out.join("")).data;
    };
    expect(await listing("/thinking")).toEqual({
      kind: "thinking-levels",
      model: "fake/fake-1",
      current: "off",
      levels: expect.arrayContaining(["off", "high"]),
    });
    const models = await listing("/model");
    expect(models).toMatchObject({ kind: "models", current: "fake/fake-1", thinking: "off" });
    for (const model of models.models) {
      expect(model.ref).toContain("/");
      expect(Array.isArray(model.thinkingLevels)).toBe(true);
    }
  });

  test("diff and undo listings print as text", () => {
    expect(
      commandDataText({
        kind: "diff",
        files: [
          {
            path: "a.txt",
            added: 1,
            removed: 0,
            hunks: ["diff --git a/a.txt b/a.txt", "@@ -0,0 +1 @@", "+hello", ""],
          },
          { path: "img.png", added: 0, removed: 0, hunks: [] },
        ],
      }),
    ).toEqual(["diff --git a/a.txt b/a.txt", "@@ -0,0 +1 @@", "+hello", "img.png (+0 -0)"]);
    expect(
      commandDataText({
        kind: "undo-points",
        points: [{ steps: 1, prompt: "fix\nthe bug", messageCount: 2 }],
      }),
    ).toEqual(["Undo through a prompt with /undo <n>:", "  1  fix the bug"]);
  });

  test("background tasks left running get one chance to be awaited, then the run ends", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-headless-root-"));
    const home = await mkdtemp(join(tmpdir(), "mu-headless-home-"));
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "sleep 30", run_in_background: true },
          },
        ],
      },
      { content: [{ type: "text", text: "started; I'll report when it exits" }] },
      { content: [{ type: "text", text: "leaving it" }] },
    ]);
    const { out, io: sink } = io();
    const started = Date.now();
    try {
      const code = await runHeadless(
        parseArgs(["-p", "run it", "--allow-all", "--model", "openai/gpt-5.1"]),
        { provider, session: new MemorySessionStore() },
        sink,
        { profileOptions: { root, home } },
      );
      expect(code).toBe(EXIT.done);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(provider.callCount).toBe(3);
    const notice = JSON.stringify(provider.requests[2]?.messages.at(-1));
    expect(notice).toContain("one-shot run");
    expect(notice).toContain("task_1 (sleep 30)");
    expect(out.join("")).toContain("leaving it");
  }, 30_000);

  test("waits for a step only the user can finish, then runs the turn it wakes", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "over to you" }] },
      { content: [{ type: "text", text: "signed in, continuing" }] },
    ]);
    let host: ProfileRuntimeHost | undefined;
    let waiting: { reason: string; done: Promise<void> } | undefined;
    const runtime: ProfileRuntime = {
      attach: (attached) => {
        host = attached;
      },
      waitingOnUser: () => waiting,
    };
    const { promise, resolve } = Promise.withResolvers<void>();
    waiting = { reason: "sign in to example.com", done: promise };
    setTimeout(() => {
      waiting = undefined;
      host?.followUp(customMessage("handoff", "the page moved on"));
      resolve();
    }, 30);
    const { out, err, io: sink } = io();

    const code = await runHeadless(parseArgs(["-p", "go"]), { ...base(provider), runtime }, sink);

    expect(code).toBe(EXIT.done);
    expect(err.join("")).toContain("mu: waiting for you: sign in to example.com");
    expect(provider.callCount).toBe(2);
    expect(out.join("")).toContain("signed in, continuing");
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
        noCheckpoints: false,
        purgeData: false,
        errors: [],
      },
      base(provider),
      sink,
    );
    expect(code).toBe(EXIT.usage);
  });
});
