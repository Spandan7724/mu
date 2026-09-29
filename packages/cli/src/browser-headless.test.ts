import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { MemorySessionStore } from "@mu/core";
import {
  replayCredentials,
  replayProvider,
  SCENARIOS,
} from "@mu/profile-browser/testing/agent-scenarios.ts";
import {
  describeWithBrowser,
  tempUserDataDir,
  testBrowserPath,
} from "@mu/profile-browser/testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "@mu/profile-browser/testing/fixture-site.ts";
import { parseArgs } from "./args.ts";
import { EXIT, runHeadless } from "./headless.ts";
import { runRpc } from "./rpc.ts";
import { createCliSessionRuntime } from "./session-runtime.ts";

setDefaultTimeout(60_000);

describeWithBrowser("mu browser -p (headless) with recorded model turns", () => {
  let site: FixtureSite;
  beforeAll(() => {
    site = startFixtureSite();
  });
  afterAll(() => site.stop());

  async function run(cassetteName: string, flags: string[]) {
    const replay = replayProvider(cassetteName, site);
    const scenario = SCENARIOS.find((candidate) => candidate.name === "mail-send-default");
    const home = tempUserDataDir();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runHeadless(
      parseArgs([
        "browser",
        "-p",
        scenario?.prompt(site) ?? "",
        "--headless",
        "--model",
        replay.model,
        ...flags,
      ]),
      {
        provider: replay.provider,
        getCredentials: replayCredentials,
        session: new MemorySessionStore(),
      },
      { stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk) },
      {
        profileOptions: {
          home,
          keepOpen: false,
          vision: "off",
          ...(testBrowserPath ? { executable: testBrowserPath } : {}),
        },
      },
    );
    rmSync(home, { recursive: true, force: true });
    return { code, out: out.join(""), err: err.join("") };
  }

  test("default mode denies the send with a clear message", async () => {
    const result = await run("mail-send-default", []);
    expect(result.code).toBe(EXIT.done);
    expect(result.err).toContain(
      "mu: denied browser:commit (Consequential browser action on 127.0.0.1",
    );
    expect(result.err).toContain("rerun with --permission-mode autonomous or --allow-all");
  });

  test("--permission-mode autonomous completes it without asking", async () => {
    const result = await run("mail-send-autonomous", ["--permission-mode", "autonomous"]);
    expect(result.code).toBe(EXIT.done);
    expect(result.err).not.toContain("denied");
    expect(result.out).toMatch(/sent/i);
  });
});

describeWithBrowser("mu browser --rpc", () => {
  test("the browser profile runs unchanged over the RPC protocol", async () => {
    const site = startFixtureSite();
    const home = tempUserDataDir();
    const replay = replayProvider("mail-send-autonomous", site);
    const runtime = await createCliSessionRuntime({
      cwd: home,
      profile: "browser",
      model: replay.model,
      permissionMode: "autonomous",
      permissions: "forward",
      agentOptions: {
        provider: replay.provider,
        getCredentials: replayCredentials,
        session: new MemorySessionStore(),
      },
      profileOptions: {
        home,
        headless: true,
        keepOpen: false,
        vision: "off",
        ...(testBrowserPath ? { executable: testBrowserPath } : {}),
      },
    });
    const prompt = SCENARIOS.find((candidate) => candidate.name === "mail-send-autonomous")?.prompt(
      site,
    );
    const written: string[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = runtime.agent.subscribe((event) => {
      if (event.type === "agent_end") finish();
    });
    await runRpc(
      {
        write: (line) => written.push(line),
        lines: (async function* () {
          yield JSON.stringify({ type: "input", text: prompt });
          await finished;
          yield JSON.stringify({ type: "shutdown" });
        })(),
      },
      { agent: runtime.agent, resolvePermission: runtime.resolvePermission },
    );
    unsubscribe();
    await runtime.agent.shutdown();
    const events = written.map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          event?: { type: string; result?: { toolName?: string } };
        },
    );
    const tools = events
      .filter((out) => out.event?.type === "tool_execution_end")
      .map((out) => out.event?.result?.toolName);
    expect(tools).toContain("navigate");
    expect(tools).toContain("click");
    expect(events.some((out) => out.event?.type === "permission_asked")).toBe(false);
    expect(events.at(-1)?.type).toBe("shutdown");
    replay.assertExhausted();
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });
});
