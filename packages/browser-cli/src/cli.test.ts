import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCliSessionRuntime,
  EXIT,
  parseArgs,
  runHeadless,
  runInteractive,
  runRpc,
} from "@mu/cli-runtime";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import type { BrowserProfile } from "@mu/profile-browser/profile";
import { Terminal } from "@mu/tui";
import { ExtensionHost, FileSessionStore } from "mu";
import { browserDoctorChecks, runBrowserDoctor } from "./doctor.ts";
import {
  BROWSER_COMMAND,
  browserProduct,
  browserProfileOptionsFrom,
  createBrowserProduct,
  emptyBrowserProductOptions,
  HELP_TEXT,
} from "./product.ts";

const homes: string[] = [];
afterAll(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mu-browser-cli-"));
  homes.push(home);
  return home;
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

const parse = (argv: string[]) => parseArgs(argv, browserProduct);

describe("argv", () => {
  test("the surface flags and the product flags coexist", () => {
    const args = parse([
      "-p",
      "open the form",
      "--fake-browser",
      "--allow-origin",
      "https://jobs.example.com",
    ]);
    expect(args.errors).toEqual([]);
    expect(args.mode).toBe("headless");
    expect(args.prompt).toBe("open the form");
    expect(args.product.fakeBrowser).toBe(true);
    expect(args.product.allowedOrigins).toEqual(["https://jobs.example.com"]);
  });

  test("repeatable origin flags accumulate rather than replacing", () => {
    const args = parse([
      "--allow-origin",
      "https://a.example.com",
      "--allow-origin",
      "https://b.example.com",
    ]);
    expect(args.product.allowedOrigins).toHaveLength(2);
  });

  test("the removed document flag is not accepted", () => {
    expect(parse(["--document", "/documents/resume.pdf"]).errors.join(" ")).toContain(
      "--document was removed",
    );
  });

  test("the removed connection selector is refused", () => {
    expect(parse(["--connection", "extension"]).errors.join(" ")).toContain(
      "--connection was removed",
    );
    expect(parse(["--browser", "firefox"]).errors).toEqual([
      '--browser expects chrome | edge | chromium, got "firefox"',
    ]);
  });

  test("headless browsing and named Mu profiles work with the owned browser", () => {
    expect(parse(["--headless"]).errors).toEqual([]);
    expect(parse(["--browser-profile", "work"]).errors).toEqual([]);
  });

  test("doctor is a product command, and --help still outranks it", () => {
    expect(parse(["doctor"]).mode).toBe("product");
    expect(parse(["doctor"]).productCommand).toBe("doctor");
    expect(parse(["doctor", "--help"]).mode).toBe("help");
  });
});

describe("help", () => {
  test("it is the browser product's own help, with no coding command in it", () => {
    expect(
      HELP_TEXT.startsWith(`${BROWSER_COMMAND} — a general-purpose browser automation agent`),
    ).toBe(true);
    expect(HELP_TEXT).toContain("mu-browser doctor");
    expect(HELP_TEXT).toContain("--fake-browser");
    expect(HELP_TEXT).toContain("profile to load (default: browser)");
    expect(HELP_TEXT).toContain("confirm-submission | confirm-every-write | read-only");
    expect(HELP_TEXT).toContain("autonomous-submit | yolo");
    expect(HELP_TEXT).toContain("alias for --permission-mode yolo (no permission prompts)");
    for (const coding of ["mu agents", "self update", "self uninstall", "--purge"]) {
      expect(HELP_TEXT).not.toContain(coding);
    }
  });
});

describe("doctor", () => {
  test("it reports the data root and available browser paths without a network call", async () => {
    const home = await tempHome();
    const checks = await browserDoctorChecks(home);
    expect(checks.some((check) => check.detail.includes(join(home, ".mu", "browser")))).toBe(true);
    const modes = checks.filter((check) => !check.name.startsWith("data "));
    expect(modes.map((check) => check.name)).toEqual([
      "deterministic fake browser",
      "Playwright MCP sidecar",
      "Mu-owned browser",
    ]);
  });

  test("an unavailable browser is a note, not a broken install", async () => {
    const { out, io } = sink();
    expect(await runBrowserDoctor(io, await tempHome())).toBe(0);
    const text = out.join("");
    expect(text).toContain("No network was used and no browser was launched.");
    expect(text).toContain("--fake-browser");
  });
});

describe("profile selection", () => {
  test("the fake browser uses the persistent connection contract", () => {
    const options = browserProfileOptionsFrom({
      ...emptyBrowserProductOptions(),
      fakeBrowser: true,
    });
    expect(options.factory).toBeDefined();
  });

  test("the launch directory becomes the profile's workspace boundary", () => {
    const options = browserProfileOptionsFrom(emptyBrowserProductOptions(), undefined, "/work/job");
    expect(options.workspaceRoot).toBe("/work/job");
  });

  test("a profile this product does not ship is refused rather than substituted", async () => {
    const product = createBrowserProduct({ home: await tempHome() });
    await expect(
      product.createProfile({
        name: "coding",
        cwd: process.cwd(),
        noInstructions: false,
        options: emptyBrowserProductOptions(),
      }),
    ).rejects.toThrow('Unknown profile "coding"');
  });
});

describe("a browser session runs end to end against the fake driver", () => {
  test("headless reaches the browser toolset and records browser session identity", async () => {
    const home = await tempHome();
    const product = createBrowserProduct({ home });
    const provider = new FakeProvider([
      {
        content: [
          { type: "toolCall", id: "c1", name: "browser_status", arguments: { connect: true } },
        ],
      },
      { content: [{ type: "text", text: "the browser is ready" }] },
    ]);
    const { out, io } = sink();
    const args = parseArgs(
      [
        "-p",
        "check the browser",
        "--fake-browser",
        "--model",
        "fake/fake-1",
        "--permission-mode",
        "read-only",
      ],
      product,
    );

    expect(
      await runHeadless(product, args, { provider, extensions: await fakeModelHost() }, io),
    ).toBe(EXIT.done);
    expect(out.join("")).toContain("the browser is ready");

    const store = new FileSessionStore({
      root: join(home, ".mu", "browser", "sessions"),
      scope: "persistent-chrome",
    });
    const saved = await store.list();
    expect(saved).toHaveLength(1);
    const tree = await store.load(saved[0] as string);
    expect(tree?.header?.profile).toBe("browser");
    expect(tree?.header?.environment).toMatchObject({
      surface: "browser",
      connection: "persistent",
      browser: "chrome",
    });
  });

  test("--allow-all selects the browser full-access mode", async () => {
    const home = await tempHome();
    const runtime = await createCliSessionRuntime({
      cwd: process.cwd(),
      product: createBrowserProduct({ home }),
      productOptions: { ...emptyBrowserProductOptions(), fakeBrowser: true },
      model: "fake/fake-1",
      allowAll: true,
      permissions: "deny",
      agentOptions: { provider: new FakeProvider([]), extensions: await fakeModelHost() },
    });
    try {
      expect(runtime.permissionMode?.id).toBe("yolo");
      expect(runtime.agentOptions.permissions?.at(-1)).toEqual({
        permission: "*",
        pattern: "*",
        action: "allow",
      });
    } finally {
      await runtime.agent.shutdown();
    }
  });

  test("a saved browser session resumes with the same product and profile identity", async () => {
    const home = await tempHome();
    const product = createBrowserProduct({ home });
    const runtime = await createCliSessionRuntime({
      cwd: process.cwd(),
      product,
      productOptions: { ...emptyBrowserProductOptions(), fakeBrowser: true },
      model: "fake/fake-1",
      sessionId: "browser-resume-1",
      permissions: "deny",
      agentOptions: { provider: new FakeProvider([]), extensions: await fakeModelHost() },
    });
    try {
      expect(runtime.agent.sessionProfile).toBe("browser");
      const tree = await runtime.agent.sessionStore.load("browser-resume-1");
      expect(tree?.header?.profile).toBe("browser");
      const resumed = await createCliSessionRuntime({
        cwd: process.cwd(),
        product,
        productOptions: { ...emptyBrowserProductOptions(), fakeBrowser: true },
        model: "fake/fake-1",
        resumeSessionId: "browser-resume-1",
        permissions: "deny",
        agentOptions: { provider: new FakeProvider([]), extensions: await fakeModelHost() },
      });
      expect(resumed.agent.sessionProfile).toBe("browser");
      expect(resumed.agent.sessionEnvironment).toMatchObject({ surface: "browser" });
      await resumed.agent.shutdown();
    } finally {
      await runtime.agent.shutdown();
    }
  });

  test("RPC drives the same composition and no coding tool is reachable", async () => {
    const home = await tempHome();
    const product = createBrowserProduct({ home });
    const runtime = await createCliSessionRuntime({
      cwd: process.cwd(),
      product,
      productOptions: { ...emptyBrowserProductOptions(), fakeBrowser: true },
      model: "fake/fake-1",
      // Exercise the restrictive mode here; browser_status only needs browser:observe.
      permissionMode: "read-only",
      permissions: "forward",
      agentOptions: {
        provider: new FakeProvider([
          {
            content: [{ type: "toolCall", id: "c1", name: "browser_status", arguments: {} }],
          },
          { content: [{ type: "text", text: "done" }] },
        ]),
        extensions: await fakeModelHost(),
      },
    });
    const written: Record<string, unknown>[] = [];
    await runRpc(
      {
        write: (line) => written.push(JSON.parse(line) as Record<string, unknown>),
        lines: (async function* () {
          yield JSON.stringify({ type: "input", text: "status", operationId: "run" });
          yield JSON.stringify({ type: "shutdown", operationId: "stop" });
        })(),
      },
      { agent: runtime.agent, cancelPermissions: runtime.cancelPermissions },
    );
    await runtime.agent.shutdown();

    expect(runtime.agentOptions.tools?.map((tool) => tool.name).sort()).toEqual([
      "browser_act",
      "browser_navigate",
      "browser_observe",
      "browser_status",
      "browser_submit",
      "browser_tabs",
      "browser_takeover",
      "browser_task",
      "browser_upload",
      "browser_wait",
    ]);
    const commands = runtime.commands.list().map((command) => command.name);
    expect(commands).toContain("browser");
    expect(commands).toContain("disconnect");
    expect(commands).not.toContain("instructions");
    const toolEnd = written.find(
      (message) =>
        message.type === "event" &&
        (message.event as { type?: string }).type === "tool_execution_end",
    );
    expect(JSON.stringify(toolEnd)).toContain("chrome (persistent) ready");
  });

  test("shutting the session down leaves the browser connection closed", async () => {
    const home = await tempHome();
    const product = createBrowserProduct({ home });
    const runtime = await createCliSessionRuntime({
      cwd: process.cwd(),
      product,
      productOptions: { ...emptyBrowserProductOptions(), fakeBrowser: true },
      model: "fake/fake-1",
      permissions: "deny",
      agentOptions: { provider: new FakeProvider([]), extensions: await fakeModelHost() },
    });
    const profile = runtime.profile as unknown as BrowserProfile;
    await runtime.agent.shutdown();
    expect(profile.runtime.status().phase).toBe("disconnected");
  });
});

describe("the interactive surface", () => {
  test("it reports under mu-browser's own command name", async () => {
    const messages: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      messages.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // A non-tty terminal forces the interactive entry point's first branch —
      // enough to prove the branding comes from this descriptor.
      const product = createBrowserProduct({ home: await tempHome() });
      const terminal = new Terminal({
        write: () => {},
        columns: 80,
        rows: 24,
        isTty: false,
      });
      expect(await runInteractive(product, parseArgs([], product), { terminal })).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(messages.join("")).toBe("mu-browser: not a terminal — use -p for headless mode\n");
  });
});

describe("the browser product offers no coding capability", () => {
  test("no direct shell and no file mentions", () => {
    expect(browserProduct.capabilities?.directShell).toBeUndefined();
    expect(browserProduct.capabilities?.fileMentions).toBeUndefined();
  });

  test("only the browser status renderer is registered", () => {
    expect(Object.keys(browserProduct.renderers ?? {})).toEqual(["browser_status"]);
  });

  test("its data namespace is the browser one, never the coding config file", () => {
    const home = "/home/tester";
    expect(browserProduct.data.configFile(home)).toBe(join(home, ".mu", "browser", "config.json"));
    expect(browserProduct.data.sessionRoot?.(home)).toBe(join(home, ".mu", "browser", "sessions"));
  });
});
