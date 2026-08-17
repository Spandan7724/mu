import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "./args.ts";
import { runHeadless } from "./headless.ts";
import { runRpc } from "./rpc.ts";
import { createCliSessionRuntime } from "./session-runtime.ts";

interface WorkerResult {
  outputs: Record<string, unknown>[];
  stderr: string;
  exitCode: number;
}

const temporary: string[] = [];
let executable = "";

beforeAll(async () => {
  const buildRoot = await mkdtemp(join(tmpdir(), "mu-compiled-profile-test-"));
  temporary.push(buildRoot);
  executable = join(buildRoot, process.platform === "win32" ? "mu.exe" : "mu");
  const root = resolve(import.meta.dir, "../../..");
  const entry = resolve(import.meta.dir, "../testing/compiled-worker-entry.ts");
  const build = Bun.spawn(
    [process.execPath, "build", entry, "--compile", "--outfile", executable],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (exitCode !== 0) throw new Error(`compiled test build failed: ${stdout}\n${stderr}`);
});

afterAll(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runWorker(options: {
  home: string;
  lifecycle: string;
  profile: string;
  instance: string;
}): Promise<WorkerResult> {
  const token = randomUUID();
  const operations = [
    { type: "snapshot", operationId: `snapshot-${options.instance}` },
    { type: "resize", cols: 111, rows: 37, operationId: `resize-${options.instance}` },
    { type: "command", text: "/fixture", operationId: `command-${options.instance}` },
    { type: "shutdown", operationId: `shutdown-${options.instance}` },
  ];
  const input = join(options.home, `.worker-${options.instance}-${token}.ndjson`);
  await writeFile(
    input,
    `${operations
      .map((operation) => JSON.stringify({ ...operation, ownershipToken: token }))
      .join("\n")}\n`,
  );
  const child = Bun.spawn(
    [
      executable,
      "__agents-worker",
      "--session-id",
      `custom-${options.instance}`,
      "--ownership-token",
      token,
      "--profile",
      options.profile,
      "--model",
      "anthropic/claude-haiku-4-5",
    ],
    {
      cwd: options.home,
      env: {
        ...process.env,
        HOME: options.home,
        USERPROFILE: options.home,
        MU_HOME: join(options.home, ".mu"),
        MU_PROFILE_FIXTURE_VALUE: `value-${options.instance}`,
        MU_PROFILE_SCOPE: "shared",
        MU_PROFILE_INSTANCE: options.instance,
        MU_PROFILE_LIFECYCLE_FILE: options.lifecycle,
        MU_COMPILED_WORKER_INPUT: input,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    outputs: stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    stderr,
    exitCode,
  };
}

describe("compiled managed custom profiles", () => {
  test("keeps custom-profile command behavior aligned across TUI runtime, headless, RPC, and managed worker modes", async () => {
    const home = await mkdtemp(join(tmpdir(), "mu-profile-parity-"));
    temporary.push(home);
    const profile = resolve(import.meta.dir, "../testing/custom-profile-fixture.mjs");
    const lifecycle = join(home, "parity-lifecycle.log");
    const previous = {
      value: process.env.MU_PROFILE_FIXTURE_VALUE,
      scope: process.env.MU_PROFILE_SCOPE,
      instance: process.env.MU_PROFILE_INSTANCE,
      lifecycle: process.env.MU_PROFILE_LIFECYCLE_FILE,
    };
    Object.assign(process.env, {
      MU_PROFILE_FIXTURE_VALUE: "value-parity",
      MU_PROFILE_SCOPE: "shared",
      MU_PROFILE_INSTANCE: "parity-local",
      MU_PROFILE_LIFECYCLE_FILE: lifecycle,
    });
    const restoreEnvironment = () => {
      for (const [name, value] of [
        ["MU_PROFILE_FIXTURE_VALUE", previous.value],
        ["MU_PROFILE_SCOPE", previous.scope],
        ["MU_PROFILE_INSTANCE", previous.instance],
        ["MU_PROFILE_LIFECYCLE_FILE", previous.lifecycle],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };

    try {
      const interactiveRuntime = await createCliSessionRuntime({
        cwd: home,
        profile,
        model: "anthropic/claude-haiku-4-5",
        permissions: "forward",
      });
      const interactive = await interactiveRuntime.commands.execute("/fixture", {
        inject: () => {},
        print: () => {},
        getModel: () => interactiveRuntime.agent.modelRef,
        setModel: (model) => interactiveRuntime.agent.setModel(model),
      });
      await interactiveRuntime.agent.shutdown();

      let headlessOutput = "";
      const headlessCode = await runHeadless(
        parseArgs([
          "-p",
          "/fixture",
          "--profile",
          profile,
          "--model",
          "anthropic/claude-haiku-4-5",
        ]),
        {},
        {
          stdout: (chunk) => {
            headlessOutput += chunk;
          },
          stderr: () => {},
        },
      );

      const rpcRuntime = await createCliSessionRuntime({
        cwd: home,
        profile,
        model: "anthropic/claude-haiku-4-5",
        permissions: "forward",
      });
      const rpcOutput: Record<string, unknown>[] = [];
      await runRpc(
        {
          write: (line) => rpcOutput.push(JSON.parse(line) as Record<string, unknown>),
          lines: (async function* () {
            yield JSON.stringify({ type: "command", text: "/fixture", operationId: "parity" });
            yield JSON.stringify({ type: "shutdown", operationId: "shutdown" });
          })(),
        },
        {
          agent: rpcRuntime.agent,
          runCommand: (text) =>
            rpcRuntime.commands.execute(text, {
              inject: () => {},
              print: () => {},
              getModel: () => rpcRuntime.agent.modelRef,
              setModel: (model) => rpcRuntime.agent.setModel(model),
            }),
        },
      );
      await rpcRuntime.agent.shutdown();

      const managed = await runWorker({
        home,
        lifecycle,
        profile,
        instance: "parity",
      });
      const expected = "fixture:value-parity";
      expect(interactive.message).toBe(expected);
      expect(headlessCode).toBe(0);
      expect(headlessOutput.trim()).toBe(expected);
      expect(rpcOutput.find((output) => output.type === "command_result")?.message).toBe(expected);
      expect(managed.outputs.find((output) => output.type === "command_result")?.message).toBe(
        expected,
      );
    } finally {
      restoreEnvironment();
    }
  }, 30_000);

  test("loads an external module with custom scope, environment, commands, runtime, and simultaneous instances", async () => {
    const home = await mkdtemp(join(tmpdir(), "mu-managed-profile-home-"));
    temporary.push(home);
    const lifecycle = join(home, "lifecycle.log");
    const profile = resolve(import.meta.dir, "../testing/custom-profile-fixture.mjs");

    const [first, second] = await Promise.all([
      runWorker({ home, lifecycle, profile, instance: "one" }),
      runWorker({ home, lifecycle, profile, instance: "two" }),
    ]);
    for (const [instance, result] of [
      ["one", first],
      ["two", second],
    ] as const) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.outputs.every((output) => typeof output.ownershipToken === "string")).toBe(
        true,
      );
      expect(result.outputs.some((output) => output.type === "ready")).toBe(true);
      const snapshot = result.outputs.find((output) => output.type === "snapshot")?.snapshot as
        | { commands?: { label: string }[] }
        | undefined;
      if (!snapshot)
        throw new Error(`worker ${instance} did not return a snapshot: ${JSON.stringify(result)}`);
      expect(snapshot?.commands?.some((command) => command.label === "fixture")).toBe(true);
      expect(
        result.outputs.some(
          (output) =>
            output.type === "command_result" && output.message === `fixture:value-${instance}`,
        ),
      ).toBe(true);
      expect(
        result.outputs
          .filter((output) => output.type === "op_result")
          .every((output) => output.ok === true),
      ).toBe(true);
    }

    const sessions = join(home, ".mu", "sessions", "fixture-shared");
    const stored = await Promise.all(
      (await readdir(sessions)).map((name) => readFile(join(sessions, name), "utf8")),
    );
    expect(stored).toHaveLength(2);
    expect(stored.some((content) => content.includes('"id":"custom-one"'))).toBe(true);
    expect(stored.some((content) => content.includes('"fixture":"value-one"'))).toBe(true);
    expect(stored.some((content) => content.includes('"id":"custom-two"'))).toBe(true);
    expect(stored.some((content) => content.includes('"fixture":"value-two"'))).toBe(true);

    const lifecycleLines = (await readFile(lifecycle, "utf8")).trim().split("\n");
    for (const instance of ["one", "two"]) {
      expect(lifecycleLines).toContain(`${instance}:attach`);
      expect(lifecycleLines).toContain(`${instance}:resize:111x37`);
      expect(lifecycleLines).toContain(`${instance}:stop`);
      expect(lifecycleLines).toContain(`${instance}:shutdown`);
    }
  }, 30_000);
});
