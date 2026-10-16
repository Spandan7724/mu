import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "mu";
import { ShadowCheckpointProvider } from "./checkpoint.ts";
import { codingProfile } from "./index.ts";
import { loadProjectConfig } from "./permissions.ts";
import { trackCommands } from "./track-commands.ts";

const run = randomUUID();
let counter = 0;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mu-track-"));
  const proc = Bun.spawn(["git", "init", "--quiet"], { cwd: root });
  await proc.exited;
  await writeFile(join(root, ".gitignore"), ".env\nlocal/\n");
  return root;
}

function provider(root: string, include?: string[]): ShadowCheckpointProvider {
  return new ShadowCheckpointProvider({
    root,
    shadowDir: join(tmpdir(), `mu-track-shadow-${process.pid}-${run}-${counter++}`),
    ...(include ? { include } : {}),
  });
}

function registry(options: Parameters<typeof trackCommands>[0]): CommandRegistry {
  const commands = new CommandRegistry();
  for (const command of trackCommands(options)) commands.register(command);
  return commands;
}

function ctx(running = false) {
  return {
    inject: () => {},
    print: () => {},
    getModel: () => "fake/model",
    setModel: () => {},
    isRunning: () => running,
  };
}

describe("/track and /untrack", () => {
  test("add, list and remove paths, persisted in the project config", async () => {
    const root = await workspace();
    const checkpoints = provider(root);
    const commands = registry({ root, checkpoints });

    expect((await commands.execute("/track", ctx())).message).toContain("No extra paths");
    expect((await commands.execute("/track .env", ctx())).message).toBe(
      ".env is included in checkpoints from the next prompt.",
    );
    expect((await commands.execute('/track "local/"', ctx())).message).toContain("local is");
    expect((await commands.execute("/track ./.env", ctx())).message).toContain("already");
    expect((await commands.execute("/track", ctx())).message).toBe(
      "Also included in checkpoints:\n  .env\n  local",
    );
    expect(checkpoints.includedPaths).toEqual([".env", "local"]);
    expect((await loadProjectConfig(root)).checkpoints).toEqual({ include: [".env", "local"] });

    expect((await commands.execute("/untrack .env", ctx())).message).toBe(
      ".env is no longer included in checkpoints.",
    );
    expect((await commands.execute("/untrack .env", ctx())).message).toContain("was not added");
    expect((await loadProjectConfig(root)).checkpoints).toEqual({ include: ["local"] });
    await commands.execute("/untrack local", ctx());
    expect((await loadProjectConfig(root)).checkpoints).toBeUndefined();
  });

  test("other project settings survive a change", async () => {
    const root = await workspace();
    await mkdir(join(root, ".mu"));
    await writeFile(join(root, ".mu", "config.json"), JSON.stringify({ model: "fake/model" }));
    await registry({ root, checkpoints: provider(root) }).execute("/track .env", ctx());
    expect(await loadProjectConfig(root)).toEqual({
      model: "fake/model",
      checkpoints: { include: [".env"] },
    });
  });

  test("changes are refused while a run is active", async () => {
    const root = await workspace();
    const checkpoints = provider(root);
    const commands = registry({ root, checkpoints });
    expect((await commands.execute("/track .env", ctx(true))).message).toContain(
      "Wait for the run",
    );
    expect(checkpoints.includedPaths).toEqual([]);
    await expect(access(join(root, ".mu"))).rejects.toThrow();
  });

  test("paths outside the workspace or never checkpointed are refused", async () => {
    const root = await workspace();
    const commands = registry({ root, checkpoints: provider(root) });
    expect((await commands.execute("/track ..", ctx())).message).toContain("outside the workspace");
    expect((await commands.execute("/track .", ctx())).message).toContain("always checkpointed");
    expect((await commands.execute("/track .git", ctx())).message).toContain("never checkpointed");
    expect((await commands.execute("/track .mu/config.json", ctx())).message).toContain(
      "never checkpointed",
    );
  });

  test("a failed save leaves the included paths unchanged", async () => {
    const root = await workspace();
    const checkpoints = provider(root);
    const commands = registry({
      root,
      checkpoints,
      save: async () => {
        throw new Error("disk full");
      },
    });
    expect((await commands.execute("/track .env", ctx())).message).toContain("disk full");
    expect(checkpoints.includedPaths).toEqual([]);
  });

  test("without checkpoints the commands say why", async () => {
    const root = await workspace();
    const commands = registry({ root, unavailable: "Checkpoints are off here, really." });
    for (const command of ["/track", "/track .env", "/untrack .env"]) {
      expect((await commands.execute(command, ctx())).message).toBe(
        "Checkpoints are off here, really.",
      );
    }
  });

  test("the coding profile loads saved paths and reports invalid ones", async () => {
    const root = await workspace();
    await mkdir(join(root, ".mu"));
    await writeFile(
      join(root, ".mu", "config.json"),
      JSON.stringify({ checkpoints: { include: [".env", "../elsewhere"] } }),
    );
    const profile = await codingProfile({ root, home: await mkdtemp(join(tmpdir(), "mu-home-")) });
    expect((profile.checkpointProvider as ShadowCheckpointProvider).includedPaths).toEqual([
      ".env",
    ]);
    expect(profile.diagnostics?.some((line) => line.includes("../elsewhere"))).toBe(true);
    expect(profile.commands?.map((command) => command.name)).toContain("track");
  });

  test("undo restores a tracked ignored file a turn edited", async () => {
    const root = await workspace();
    await writeFile(join(root, ".env"), "TOKEN=original\n");
    const checkpoints = provider(root);
    await registry({ root, checkpoints }).execute("/track .env", ctx());
    const profile = await codingProfile({ root, home: await mkdtemp(join(tmpdir(), "mu-home-")) });
    const agent = new Agent({
      provider: new FakeProvider([
        {
          content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: ".env" } }],
        },
        {
          content: [
            {
              type: "toolCall",
              id: "write-1",
              name: "write",
              arguments: { path: ".env", content: "TOKEN=changed\n" },
            },
          ],
        },
        { content: [{ type: "text", text: "Done." }] },
      ]),
      model: fakeModel,
      tools: profile.toolset,
      checkpointProvider: checkpoints,
      permissions: [{ permission: "*", pattern: "*", action: "allow" }],
    });

    await agent.run("rotate the token");
    expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=changed\n");
    const undone = await agent.undo();
    expect(undone.data?.files.map((file) => file.path)).toEqual([".env"]);
    expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=original\n");
  });
});
