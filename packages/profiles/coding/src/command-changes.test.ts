import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyTool, ToolResult } from "@mu/core";
import { ShadowCheckpointProvider } from "./checkpoint.ts";
import { type ChangedFile, changedFilesNote, commandChanges } from "./command-changes.ts";
import { codingProfile } from "./index.ts";
import { FileState } from "./state.ts";
import { bashTool } from "./tools/bash.ts";

const signal = new AbortController().signal;
const agentContext = { model: "fake/model", acceptsImages: true };

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mu-cmd-changes-"));
  Bun.spawnSync(["git", "init", "--quiet"], { cwd: root });
  return root;
}

async function tracker(root: string, state = new FileState()) {
  const checkpoints = new ShadowCheckpointProvider({
    root,
    shadowDir: await mkdtemp(join(tmpdir(), "mu-cmd-shadow-")),
  });
  return { changes: commandChanges(root, checkpoints, state), state };
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function changedFiles(result: ToolResult): ChangedFile[] | undefined {
  return (result.details as { changedFiles?: ChangedFile[] }).changedFiles;
}

describe("commandChanges", () => {
  test("reports each file a command changed, created or deleted, with its diff", async () => {
    const root = await repository();
    await writeFile(join(root, "kept.txt"), "one\ntwo\n");
    await writeFile(join(root, "gone.txt"), "bye\n");
    const { changes } = await tracker(root);

    const before = await changes.before(signal);
    await writeFile(join(root, "kept.txt"), "one\nTWO\n");
    await writeFile(join(root, "new.txt"), "hello\n");
    await Bun.file(join(root, "gone.txt")).delete();
    const files = await changes.after(before as string, true);

    const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
    expect(Object.keys(byPath).sort()).toEqual(["gone.txt", "kept.txt", "new.txt"]);
    expect(byPath["kept.txt"]).toMatchObject({ added: 1, removed: 1 });
    expect(byPath["kept.txt"]?.hunks).toContain("+TWO");
    expect(byPath["new.txt"]).toMatchObject({ added: 1, removed: 0 });
    expect(byPath["gone.txt"]).toMatchObject({ added: 0, removed: 1 });
  });

  test("a command that changes nothing reports nothing", async () => {
    const root = await repository();
    await writeFile(join(root, "a.txt"), "a\n");
    const { changes } = await tracker(root);
    const before = await changes.before(signal);
    expect(await changes.after(before as string, true)).toEqual([]);
  });

  test("the agent's own change keeps a file it had read current for edit and write", async () => {
    const root = await repository();
    const path = join(root, "a.txt");
    await writeFile(path, "a\n");
    const { changes, state } = await tracker(root);
    state.markRead(path, "a\n");

    const before = await changes.before(signal);
    await writeFile(path, "b\n");
    await changes.after(before as string, true);

    expect(state.isStale(path)).toBe(false);
    expect(state.modifiedFiles()).toContain(path);
  });

  test("a file that had changed since the agent read it stays stale", async () => {
    const root = await repository();
    const path = join(root, "a.txt");
    await writeFile(path, "a\n");
    const { changes, state } = await tracker(root);
    state.markRead(path, "a\n");
    await writeFile(path, "changed by someone else\n");

    const before = await changes.before(signal);
    await writeFile(path, "b\n");
    await changes.after(before as string, true);

    expect(state.isStale(path)).toBe(true);
  });

  test("a user's command never counts as the agent's change", async () => {
    const root = await repository();
    const path = join(root, "a.txt");
    await writeFile(path, "a\n");
    const { changes, state } = await tracker(root);
    state.markRead(path, "a\n");

    const before = await changes.before(signal);
    await writeFile(path, "b\n");
    const files = await changes.after(before as string, false);

    expect(files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(state.isStale(path)).toBe(true);
    expect(state.modifiedFiles()).toEqual([]);
  });

  test("diffs past the kept budget keep their counts only", async () => {
    const root = await repository();
    const big = Array.from({ length: 3_000 }, (_, index) => `line ${index}`).join("\n");
    const { changes } = await tracker(root);
    const before = await changes.before(signal);
    await writeFile(join(root, "big.txt"), big);
    await writeFile(join(root, "small.txt"), "x\n");
    const files = await changes.after(before as string, true);

    const bigFile = files.find((file) => file.path === "big.txt");
    expect(bigFile).toMatchObject({ added: 3_000, hunks: [], hunksOmitted: true });
    expect(files.find((file) => file.path === "small.txt")?.hunks.length).toBeGreaterThan(0);
  });

  test("the note lists at most 20 files", () => {
    const files = Array.from({ length: 23 }, (_, index) => ({
      path: `f${index}.ts`,
      added: 1,
      removed: 0,
      hunks: [],
    }));
    const note = changedFilesNote(files);
    expect(note).toStartWith("[changed 23 files: f0.ts (+1 -0), ");
    expect(note).toContain("f19.ts (+1 -0), and 3 more]");
    expect(note).not.toContain("f20.ts");
  });
});

describe("bash reports the files it changed", () => {
  test("a state-changing command lists its changes for the model and the details", async () => {
    const root = await repository();
    await writeFile(join(root, "a.ts"), "const a = 1;\n");
    const profile = await codingProfile({ root, home: await mkdtemp(join(tmpdir(), "mu-home-")) });
    const bash = profile.toolset.find((tool) => tool.name === "bash") as AnyTool;

    const result = await bash.execute(
      "t1",
      { command: "sed -i 's/1/2/' a.ts" },
      signal,
      undefined,
      undefined,
      agentContext,
    );

    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("const a = 2;\n");
    expect(textOf(result)).toEndWith("[changed 1 file: a.ts (+1 -1)]");
    expect(changedFiles(result)?.map((file) => file.path)).toEqual(["a.ts"]);
    expect(profile.fileState.modifiedFiles()).toContain(join(root, "a.ts"));
  });

  test("read-only commands are not measured", async () => {
    let measured = 0;
    const bash = bashTool({
      root: "/tmp",
      spawn: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      changes: {
        before: async () => {
          measured++;
          return "ref";
        },
        after: async () => [],
      },
    }) as AnyTool;
    await bash.execute("t1", { command: "rg needle" }, signal, undefined, undefined, agentContext);
    expect(measured).toBe(0);
    await bash.execute("t2", { command: "touch x" }, signal, undefined, undefined, agentContext);
    expect(measured).toBe(1);
  });

  test("a command run outside the agent loop is not the agent's change", async () => {
    let byAgent: boolean | undefined;
    const bash = bashTool({
      root: "/tmp",
      spawn: async () => ({ stdout: "ok\n", stderr: "", exitCode: 1, timedOut: false }),
      changes: {
        before: async () => "ref",
        after: async (_before, agent) => {
          byAgent = agent;
          return [{ path: "x.txt", added: 2, removed: 0, hunks: [] }];
        },
      },
    }) as AnyTool;
    const result = await bash.execute("t1", { command: "make" }, signal);
    expect(byAgent).toBe(false);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("ok\n\n[exit code 1]\n\n[changed 1 file: x.txt (+2 -0)]");
  });

  test("a failed measurement leaves the command's result unchanged", async () => {
    const bash = bashTool({
      root: "/tmp",
      spawn: async () => ({ stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false }),
      changes: {
        before: async () => {
          throw new Error("store gone");
        },
        after: async () => [],
      },
    }) as AnyTool;
    const result = await bash.execute("t1", { command: "make" }, signal);
    expect(textOf(result)).toBe("ok");
    expect(changedFiles(result)).toBeUndefined();
  });
});
