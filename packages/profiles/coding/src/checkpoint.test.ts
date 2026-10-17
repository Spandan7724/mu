import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { type CheckpointProvider, MemorySessionStore, type SessionTree, type Tool } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "mu";
import { partialCheckpointNotice, ShadowCheckpointProvider } from "./checkpoint.ts";
import { codingProfile } from "./index.ts";
import { loadProjectConfig } from "./permissions.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-ckpt-"));
}

// Checkpoints only run inside a repository, which supplies the ignore rules.
async function workspace(): Promise<string> {
  const root = await scratch();
  await git(root, "init", "--quiet");
  return root;
}

// Production puts the shadow repo under ~/.mu, i.e. entirely outside the
// session root. Mirror that here (in a temp dir) so tests never touch ~/.mu.
let shadowCounter = 0;
const shadowRun = randomUUID();
function provider(root: string): ShadowCheckpointProvider {
  return new ShadowCheckpointProvider({
    root,
    shadowDir: join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`),
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

describe("shadow checkpoints", () => {
  test("two coding workers checkpoint concurrently in one workspace", async () => {
    const root = await workspace();
    await git(root, "init", "--quiet");
    const home = await scratch();
    const gate = join(root, "start-workers");
    const fixture = join(import.meta.dir, "../testing/concurrent-checkpoint-worker.ts");
    const spawnWorker = (name: string) =>
      Bun.spawn([process.execPath, fixture, root, name, gate], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdout: "pipe",
        stderr: "pipe",
      });
    const first = spawnWorker("first-worker");
    const second = spawnWorker("second-worker");
    await writeFile(gate, "go\n");

    const results = await Promise.all(
      [first, second].map(async (worker) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(worker.stdout).text(),
          new Response(worker.stderr).text(),
          worker.exited,
        ]);
        return { stdout, stderr, exitCode };
      }),
    );
    expect(results).toEqual([
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]);
    expect(JSON.parse(await readFile(join(root, "first-worker.result.json"), "utf8"))).toEqual({
      checkpoints: 1,
    });
    expect(JSON.parse(await readFile(join(root, "second-worker.result.json"), "utf8"))).toEqual({
      checkpoints: 1,
    });
    expect(await readFile(join(root, "first-worker.txt"), "utf8")).toBe("first-worker\n");
    expect(await readFile(join(root, "second-worker.txt"), "utf8")).toBe("second-worker\n");
    const checkpointRoot = join(home, ".mu", "checkpoints");
    const entries = await readdir(checkpointRoot);
    expect(entries.filter((entry) => entry.endsWith(".lock"))).toEqual([]);
    expect(entries.filter((entry) => !entry.endsWith(".lock"))).toHaveLength(1);
  });

  test("snapshot then restore brings a modified file back", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "original\n");

    const p = provider(root);
    const ref = await p.snapshot("before edit");
    expect(ref).toBeDefined();

    await writeFile(join(root, "a.txt"), "modified\n");
    await p.restore(ref as string);

    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original\n");
  });

  test("restore removes files created after the snapshot", async () => {
    const root = await workspace();
    await writeFile(join(root, "keep.txt"), "keep\n");
    const p = provider(root);
    const ref = await p.snapshot();

    await writeFile(join(root, "added-later.txt"), "oops\n");
    await p.restore(ref as string);

    const entries = await readdir(root);
    expect(entries).toContain("keep.txt");
    // The file created after the snapshot is gone from the tracked tree.
    expect(entries).not.toContain("added-later.txt");
  });

  test("restore handles an empty snapshot", async () => {
    const root = await workspace();
    const p = provider(root);
    const empty = await p.snapshot("empty");
    await writeFile(join(root, "created.txt"), "created\n");
    await p.snapshot("with file");

    await p.restore(empty as string);

    expect(await readdir(root)).toEqual([".git"]);
  });

  test("scoped restore removes a created file without touching unrelated later work", async () => {
    const root = await workspace();
    const p = provider(root);
    const before = await p.snapshot("before turn");
    await writeFile(join(root, "agent.txt"), "agent\n");
    await p.snapshot("after turn");
    await writeFile(join(root, "user.txt"), "user\n");

    await p.restoreResources(before as string, ["agent.txt"]);

    await expect(access(join(root, "agent.txt"))).rejects.toThrow();
    expect(await readFile(join(root, "user.txt"), "utf8")).toBe("user\n");
  });

  test("scoped restore recovers only requested files", async () => {
    const root = await workspace();
    await writeFile(join(root, "agent.txt"), "before\n");
    await writeFile(join(root, "user.txt"), "before\n");
    const p = provider(root);
    const before = await p.snapshot("before turn");
    await writeFile(join(root, "agent.txt"), "agent edit\n");
    await writeFile(join(root, "user.txt"), "later user edit\n");
    await p.snapshot("after turn");

    await p.restoreResources(before as string, ["agent.txt"]);

    expect(await readFile(join(root, "agent.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(root, "user.txt"), "utf8")).toBe("later user edit\n");
  });

  test("scoped restore treats odd filenames literally", async () => {
    const root = await workspace();
    const odd = "odd\tname\n[1].txt";
    const p = provider(root);
    const before = await p.snapshot("before turn");
    await writeFile(join(root, odd), "created\n");
    const after = await p.snapshot("after turn");

    await p.restoreResources(before as string, [odd]);
    await expect(access(join(root, odd))).rejects.toThrow();
    await p.restoreResources(after as string, [odd]);
    expect(await readFile(join(root, odd), "utf8")).toBe("created\n");
  });

  test("diff expands renames so scoped restore sees both paths", async () => {
    const root = await workspace();
    await writeFile(join(root, "before.txt"), "same\n");
    const p = provider(root);
    const before = await p.snapshot("before rename");
    await Bun.$`mv ${join(root, "before.txt")} ${join(root, "after.txt")}`.quiet();
    const after = await p.snapshot("after rename");

    const files = await p.diff(before as string, after as string);
    expect(files.map((file) => file.path).sort()).toEqual(["after.txt", "before.txt"]);

    await p.restoreResources(
      before as string,
      files.map((file) => file.path),
    );
    expect(await readFile(join(root, "before.txt"), "utf8")).toBe("same\n");
    await expect(access(join(root, "after.txt"))).rejects.toThrow();
  });

  test("restore brings back a file that was deleted", async () => {
    const root = await workspace();
    await writeFile(join(root, "deleted.txt"), "here\n");
    const p = provider(root);
    const ref = await p.snapshot();

    await rm(join(root, "deleted.txt"));
    await p.restore(ref as string);

    expect(await readFile(join(root, "deleted.txt"), "utf8")).toBe("here\n");
  });

  test("restore neither reverts nor removes files the repository ignores", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitignore"), "*.secret\n");
    await writeFile(join(root, "user.secret"), "user state\n");
    const p = provider(root);
    const ref = await p.snapshot();

    await writeFile(join(root, "user.secret"), "overwritten\n");
    await writeFile(join(root, "created.secret"), "new\n");
    await p.restore(ref as string);

    expect(await readFile(join(root, "user.secret"), "utf8")).toBe("overwritten\n");
    expect(await readFile(join(root, "created.secret"), "utf8")).toBe("new\n");
  });

  test("ignored dependency and cache directories are preserved but not checkpointed", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitignore"), ".venv/\nnode_modules/\n");
    await mkdir(join(root, ".venv", "bin"), { recursive: true });
    await writeFile(join(root, ".venv", "bin", "python"), "original environment\n");
    await writeFile(join(root, "app.py"), "original\n");
    const p = provider(root);
    const ref = await p.snapshot();

    await writeFile(join(root, ".venv", "bin", "python"), "updated environment\n");
    await mkdir(join(root, "node_modules", "example"), { recursive: true });
    await writeFile(join(root, "node_modules", "example", "index.js"), "generated\n");
    await writeFile(join(root, "app.py"), "updated\n");

    expect((await p.diff(ref as string)).map((file) => file.path)).toEqual(["app.py"]);
    await p.restore(ref as string);

    expect(await readFile(join(root, ".venv", "bin", "python"), "utf8")).toBe(
      "updated environment\n",
    );
    expect(await readFile(join(root, "node_modules", "example", "index.js"), "utf8")).toBe(
      "generated\n",
    );
    expect(await readFile(join(root, "app.py"), "utf8")).toBe("original\n");
  });

  test("an included ignored file is recorded, restored and its later copy removed", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitignore"), "*.secret\nlocal/\n");
    await writeFile(join(root, "user.secret"), "original\n");
    await writeFile(join(root, "other.secret"), "original\n");
    const p = new ShadowCheckpointProvider({
      root,
      shadowDir: join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`),
      include: ["user.secret", "local"],
    });
    const ref = await p.snapshot();

    await writeFile(join(root, "user.secret"), "changed\n");
    await writeFile(join(root, "other.secret"), "changed\n");
    await mkdir(join(root, "local"));
    await writeFile(join(root, "local", "big.bin"), Buffer.alloc(3 * 1024 * 1024));
    expect((await p.diff(ref as string)).map((file) => file.path).sort()).toEqual([
      "local/big.bin",
      "user.secret",
    ]);
    await p.restore(ref as string);

    expect(await readFile(join(root, "user.secret"), "utf8")).toBe("original\n");
    expect(await readFile(join(root, "other.secret"), "utf8")).toBe("changed\n");
    await expect(access(join(root, "local"))).rejects.toThrow();
  });

  test("a path no longer included leaves the checkpoints without touching the file", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitignore"), "*.secret\n");
    await writeFile(join(root, "user.secret"), "kept\n");
    const p = new ShadowCheckpointProvider({
      root,
      shadowDir: join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`),
      include: ["user.secret"],
    });
    await p.snapshot();
    p.setIncludedPaths([]);
    const ref = await p.snapshot();

    await p.restore(ref as string);
    expect(await readFile(join(root, "user.secret"), "utf8")).toBe("kept\n");
    expect(
      await git(root, `--git-dir=${p.directory}`, "ls-tree", "-r", "--name-only", ref as string),
    ).not.toContain("user.secret");
  });

  test("ignore rules above a subdirectory root still apply", async () => {
    const repo = await workspace();
    await writeFile(join(repo, ".gitignore"), "build/\n");
    const root = join(repo, "packages", "app");
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, "main.ts"), "one\n");
    const p = provider(root);
    const ref = await p.snapshot();

    await writeFile(join(root, "main.ts"), "two\n");
    await writeFile(join(root, "build", "out.js"), "generated\n");
    expect((await p.diff(ref as string)).map((file) => file.path)).toEqual(["main.ts"]);
    await p.restore(ref as string);

    expect(await readFile(join(root, "main.ts"), "utf8")).toBe("one\n");
    expect(await readFile(join(root, "build", "out.js"), "utf8")).toBe("generated\n");
  });

  test("a large untracked file is neither recorded nor removed", async () => {
    const root = await workspace();
    const p = provider(root);
    const ref = await p.snapshot();
    await writeFile(join(root, "dump.bin"), Buffer.alloc(3 * 1024 * 1024));
    await writeFile(join(root, "small.txt"), "small\n");

    expect((await p.diff(ref as string)).map((file) => file.path)).toEqual(["small.txt"]);
    await p.restore(ref as string);

    expect((await readFile(join(root, "dump.bin"))).length).toBe(3 * 1024 * 1024);
    await expect(access(join(root, "small.txt"))).rejects.toThrow();
  });

  test("restore removes directories left empty by the files it removes", async () => {
    const root = await workspace();
    await writeFile(join(root, "keep.txt"), "keep\n");
    const p = provider(root);
    const ref = await p.snapshot();
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "src", "deep", "new.ts"), "new\n");

    await p.restore(ref as string);

    expect((await readdir(root)).sort()).toEqual([".git", "keep.txt"]);
  });

  test("a dependency-named directory is checkpointed when it is not ignored", async () => {
    const root = await workspace();
    await mkdir(join(root, "venv"), { recursive: true });
    await writeFile(join(root, "venv", "source.txt"), "original\n");
    const p = provider(root);
    const ref = await p.snapshot();

    await writeFile(join(root, "venv", "source.txt"), "changed\n");
    await p.restore(ref as string);

    expect(await readFile(join(root, "venv", "source.txt"), "utf8")).toBe("original\n");
  });

  test("mu's own project state is never checkpointed, restored or cleaned away", async () => {
    const root = await workspace();
    await mkdir(join(root, ".mu"), { recursive: true });
    await writeFile(join(root, ".mu", "config.json"), '{"permissions":[]}\n');
    await writeFile(join(root, "source.txt"), "original\n");
    const p = provider(root);
    const ref = await p.snapshot();

    await writeFile(join(root, ".mu", "config.json"), '{"permissions":["bash"]}\n');
    await writeFile(join(root, ".mu", "model"), "opus\n");
    await writeFile(join(root, "source.txt"), "changed\n");

    expect((await p.diff(ref as string)).map((file) => file.path)).toEqual(["source.txt"]);
    await p.restore(ref as string);

    expect(await readFile(join(root, ".mu", "config.json"), "utf8")).toBe(
      '{"permissions":["bash"]}\n',
    );
    expect(await readFile(join(root, ".mu", "model"), "utf8")).toBe("opus\n");
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("original\n");
  });

  test("project state created after a snapshot is not removed by restore", async () => {
    const root = await workspace();
    await writeFile(join(root, "source.txt"), "original\n");
    const p = provider(root);
    const ref = await p.snapshot();

    await mkdir(join(root, ".mu"), { recursive: true });
    await writeFile(join(root, ".mu", "config.json"), '{"permissions":["bash"]}\n');
    await p.restore(ref as string);

    expect(await readFile(join(root, ".mu", "config.json"), "utf8")).toBe(
      '{"permissions":["bash"]}\n',
    );
  });

  test("diff reports per-file added and removed counts", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "one\ntwo\n");
    const p = provider(root);
    const first = await p.snapshot();

    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\n");
    const second = await p.snapshot();

    const files = await p.diff(first as string, second as string);
    expect(files.length).toBe(1);
    expect(files[0]?.path).toBe("a.txt");
    expect(files[0]?.added).toBe(1);
    expect(files[0]?.removed).toBe(0);
    expect(files[0]?.hunks.join("\n")).toContain("+three");
  });

  test("an aborted snapshot kills its Git process and leaves the store usable", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "1\n");
    const shadowDir = join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`);
    const controller = new AbortController();
    let killed = false;
    const slow = new ShadowCheckpointProvider({
      root,
      shadowDir,
      run: async (args, env, cwd, options) => {
        const signal = options?.signal;
        if (args[0] !== "update-index") {
          const proc = Bun.spawn(["git", ...args], {
            cwd,
            env: { ...process.env, ...env },
            stdin: options?.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return { stdout, stderr, exitCode };
        }
        const proc = Bun.spawn(["sleep", "30"], signal ? { signal } : {});
        queueMicrotask(() => controller.abort());
        const exitCode = await proc.exited;
        killed = proc.signalCode !== null;
        return { stdout: "", stderr: "", exitCode };
      },
    });

    expect(await slow.snapshot("before", controller.signal)).toBeUndefined();
    expect(killed).toBe(true);
    expect(await new ShadowCheckpointProvider({ root, shadowDir }).snapshot()).toBeDefined();
  });

  test("an already aborted snapshot runs no Git at all", async () => {
    const root = await workspace();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const p = new ShadowCheckpointProvider({
      root,
      shadowDir: join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`),
      run: async () => {
        calls++;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(await p.snapshot("before", controller.signal)).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("an index lock left by a killed Git does not block later snapshots", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "1\n");
    const p = provider(root);
    await p.snapshot();
    await writeFile(join(p.directory, "index.lock"), "");
    await writeFile(join(root, "a.txt"), "2\n");
    const ref = await p.snapshot();
    expect(ref).toBeDefined();
    await writeFile(join(root, "a.txt"), "3\n");
    await p.restore(ref as string);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("2\n");
  });

  test("a store over the loose-object limit is packed in the background and stays readable", async () => {
    const root = await workspace();
    for (let index = 0; index < 2100; index++) {
      await writeFile(join(root, `file-${index}.txt`), `content ${index}\n`);
    }
    const p = provider(root);
    const ref = await p.snapshot();
    await p.settled();

    const stats = await git(root, `--git-dir=${p.directory}`, "count-objects", "-v");
    expect(Number(/^count: (\d+)$/m.exec(stats)?.[1])).toBeLessThan(100);
    expect(Number(/^packs: (\d+)$/m.exec(stats)?.[1])).toBeGreaterThanOrEqual(1);
    await writeFile(join(root, "file-0.txt"), "changed\n");
    await p.restoreResources(ref as string, ["file-0.txt"]);
    expect(await readFile(join(root, "file-0.txt"), "utf8")).toBe("content 0\n");
  });

  test("store maintenance runs at most once per interval", async () => {
    const root = await workspace();
    const commands: string[] = [];
    const p = new ShadowCheckpointProvider({
      root,
      shadowDir: join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`),
      run: async (args, env, cwd, options) => {
        commands.push(args[0] as string);
        const proc = Bun.spawn(["git", ...args], {
          cwd,
          env: { ...process.env, ...env },
          stdin: options?.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, exitCode };
      },
    });
    await p.snapshot();
    await p.settled();
    await p.snapshot();
    await p.settled();
    expect(commands.filter((command) => command === "count-objects")).toHaveLength(1);
    expect(commands).not.toContain("gc");
  });

  test("scoped restore removes folders left empty by the files it removes, and only those", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "keep.ts"), "keep\n");
    const p = provider(root);
    const before = await p.snapshot();
    await mkdir(join(root, "deep", "nested"), { recursive: true });
    await writeFile(join(root, "deep", "nested", "notes.txt"), "hello\n");
    await writeFile(join(root, "src", "new.ts"), "new\n");
    await p.snapshot();

    await p.restoreResources(before as string, ["deep/nested/notes.txt", "src/new.ts"]);

    await expect(access(join(root, "deep"))).rejects.toThrow();
    expect(await readFile(join(root, "src", "keep.ts"), "utf8")).toBe("keep\n");
    await expect(access(join(root, "src", "new.ts"))).rejects.toThrow();
  });

  test("successive snapshots produce distinct references", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "1\n");
    const p = provider(root);
    const first = await p.snapshot();
    await writeFile(join(root, "a.txt"), "2\n");
    const second = await p.snapshot();
    expect(first).not.toBe(second);
  });

  test("diff includes newly created and odd-named files, not ignored ones, before another snapshot", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitignore"), "*.secret\n");
    await writeFile(join(root, "base.txt"), "base\n");
    const p = provider(root);
    const first = await p.snapshot();

    await writeFile(join(root, "new.ts"), "export const value = 1;\n");
    await writeFile(join(root, "cache.secret"), "ignored but changed\n");
    await writeFile(join(root, "odd\tname\n.txt"), "odd\n");

    const files = await p.diff(first as string);
    expect(new Set(files.map((file) => file.path))).toEqual(new Set(["new.ts", "odd\tname\n.txt"]));
    expect(files.find((file) => file.path === "new.ts")?.hunks.join("\n")).toContain(
      "+export const value = 1;",
    );
  });

  test("default stores use a canonical collision-resistant workspace key", async () => {
    const base = await scratch();
    const firstRoot = join(base, "a-b", "c");
    const secondRoot = join(base, "a", "b-c");
    await mkdir(firstRoot, { recursive: true });
    await mkdir(secondRoot, { recursive: true });

    const first = new ShadowCheckpointProvider({ root: firstRoot });
    const second = new ShadowCheckpointProvider({ root: secondRoot });

    expect(first.directory).not.toBe(second.directory);
  });

  test("an explicitly reused store refuses a different workspace", async () => {
    const firstRoot = await workspace();
    const secondRoot = await workspace();
    const shadowDir = join(tmpdir(), `mu-shadow-owner-${process.pid}-${shadowCounter++}`);
    const first = new ShadowCheckpointProvider({ root: firstRoot, shadowDir });
    await first.snapshot();

    const second = new ShadowCheckpointProvider({ root: secondRoot, shadowDir });
    await expect(second.snapshot()).rejects.toThrow("belongs to");
  });

  test("a store written by another release keeps its checkpoints", async () => {
    for (const version of ["2", "3"]) {
      const root = await workspace();
      await writeFile(join(root, "a.txt"), "before\n");
      const shadowDir = join(tmpdir(), `mu-shadow-version-${process.pid}-${shadowCounter++}`);
      const before = await new ShadowCheckpointProvider({ root, shadowDir }).snapshot();
      await writeFile(join(shadowDir, "mu-checkpoint-version"), `${version}\n`);

      await writeFile(join(root, "a.txt"), "after\n");
      const reopened = new ShadowCheckpointProvider({ root, shadowDir });
      expect((await reopened.diff(before as string)).map((file) => file.path)).toEqual(["a.txt"]);
      await reopened.restoreResources(before as string, ["a.txt"]);
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before\n");
      // Releases that only know version 2 would otherwise rebuild the store.
      expect(await readFile(join(shadowDir, "mu-checkpoint-version"), "utf8")).toBe("2\n");
    }
  });

  test("a checkpoint missing from the store is reported plainly", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "1\n");
    const p = provider(root);
    const ref = (await p.snapshot()) as string;
    await rm(p.directory, { recursive: true, force: true });

    const fresh = provider(root);
    for (const attempt of [
      () => fresh.diff(ref),
      () => fresh.diff(ref, ref),
      () => fresh.restore(ref),
      () => fresh.restoreResources(ref, ["a.txt"]),
    ]) {
      await expect(attempt()).rejects.toThrow("is no longer in");
    }
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("1\n");
  });

  test("an older shadow-store format is rebuilt without touching the workspace", async () => {
    const root = await workspace();
    await writeFile(join(root, "source.txt"), "workspace state\n");
    const shadowDir = join(tmpdir(), `mu-shadow-version-${process.pid}-${shadowCounter++}`);
    const first = new ShadowCheckpointProvider({ root, shadowDir });
    await first.snapshot("old history");
    await writeFile(join(shadowDir, "mu-checkpoint-version"), "1\n");
    await writeFile(join(shadowDir, "obsolete-shadow-data"), "old\n");

    const rebuilt = new ShadowCheckpointProvider({ root, shadowDir });
    await rebuilt.snapshot("new history");

    await expect(access(join(shadowDir, "obsolete-shadow-data"))).rejects.toThrow();
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("workspace state\n");
    expect((await git(root, `--git-dir=${shadowDir}`, "rev-list", "--count", "HEAD")).trim()).toBe(
      "1",
    );
  });
});

describe("the user's own repository is never touched", () => {
  test("no commits, refs or objects are added to the user's repo", async () => {
    const root = await workspace();
    // A real user repo with its own history.
    await git(root, "init", "--quiet");
    await git(root, "config", "user.email", "user@example.com");
    await git(root, "config", "user.name", "Real User");
    await writeFile(join(root, "tracked.txt"), "v1\n");
    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "-m", "user's own commit");

    const commitsBefore = (await git(root, "log", "--oneline")).trim();
    const refsBefore = (await git(root, "show-ref")).trim();
    const statusBefore = (await git(root, "status", "--porcelain")).trim();

    // mu takes checkpoints around a change.
    const p = provider(root);
    const ref = await p.snapshot("before mu edits");
    await writeFile(join(root, "tracked.txt"), "v2 by mu\n");
    await p.snapshot("after mu edits");
    await p.restore(ref as string);

    expect((await git(root, "log", "--oneline")).trim()).toBe(commitsBefore);
    expect((await git(root, "show-ref")).trim()).toBe(refsBefore);
    // The user's working state is where mu put it back, not mangled.
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("v1\n");
    expect((await git(root, "status", "--porcelain")).trim()).toBe(statusBefore);
  });

  test("the user's uncommitted changes survive a snapshot", async () => {
    const root = await workspace();
    await git(root, "init", "--quiet");
    await git(root, "config", "user.email", "user@example.com");
    await git(root, "config", "user.name", "Real User");
    await writeFile(join(root, "tracked.txt"), "committed\n");
    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "-m", "base");

    // Dirty state the user has not committed.
    await writeFile(join(root, "tracked.txt"), "work in progress\n");
    await writeFile(join(root, "untracked.txt"), "scratch notes\n");

    const p = provider(root);
    await p.snapshot("with user's dirty state");

    // Snapshotting must not stage, commit or discard any of it.
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("work in progress\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("scratch notes\n");
    const status = await git(root, "status", "--porcelain");
    expect(status).toContain("tracked.txt");
    expect(status).toContain("untracked.txt");
    expect((await git(root, "log", "--oneline")).trim().split("\n").length).toBe(1);
  });

  test("restoring recovers the user's dirty state, not just committed state", async () => {
    const root = await workspace();
    await git(root, "init", "--quiet");
    await git(root, "config", "user.email", "u@e.com");
    await git(root, "config", "user.name", "U");
    await writeFile(join(root, "f.txt"), "committed\n");
    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "-m", "base");
    await writeFile(join(root, "f.txt"), "uncommitted work\n");

    const p = provider(root);
    const ref = await p.snapshot();
    await writeFile(join(root, "f.txt"), "mu overwrote it\n");
    await p.restore(ref as string);

    // The dirty state is what comes back — a plain `git checkout` would not.
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("uncommitted work\n");
  });

  test("the shadow repo lives entirely outside the session root", async () => {
    const root = await workspace();
    const p = provider(root);
    await p.snapshot();
    expect(p.directory.startsWith(root)).toBe(false);
    expect(await readdir(p.directory)).toContain("HEAD");
    // Nothing of ours appears in the user's directory listing.
    expect(await readdir(root)).not.toContain(".shadow-git");
  });

  test("a shadow repo placed inside the root excludes itself", async () => {
    // Not the default layout, but it must not corrupt snapshots if configured.
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "content\n");
    const inside = new ShadowCheckpointProvider({ root, shadowDir: join(root, ".shadow-git") });
    const first = await inside.snapshot();
    await writeFile(join(root, "a.txt"), "changed\n");
    const second = await inside.snapshot();

    const files = await inside.diff(first as string, second as string);
    expect(files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  test("a directory outside any repository is refused rather than walked", async () => {
    const root = await scratch();
    await writeFile(join(root, "plain.txt"), "no repo here\n");
    await expect(provider(root).snapshot()).rejects.toThrow("Could not list checkpoint paths");
    // And we did not turn their directory into a repo.
    await expect(readdir(join(root, ".git"))).rejects.toThrow();
  });
});

describe("where checkpoints run", () => {
  test("a git repository, or a directory inside one, gets checkpoints", async () => {
    const root = await scratch();
    const home = await scratch();
    await git(root, "init", "--quiet");
    await mkdir(join(root, "packages", "app"), { recursive: true });
    expect(await partialCheckpointNotice(root, home)).toBeUndefined();
    expect(await partialCheckpointNotice(join(root, "packages", "app"), home)).toBeUndefined();
    const profile = await codingProfile({ root, home });
    expect(profile.checkpointProvider?.coverage).toBe("full");
    expect(profile.checkpointNotice).toBeUndefined();
    expect(profile.checkpointUnavailable).toBeUndefined();
  });

  test("a directory outside any repository records only named files and says so", async () => {
    const root = await scratch();
    const home = await scratch();
    const notice = await partialCheckpointNotice(root, home);
    expect(notice).toContain("outside a git repository");
    expect(notice).toContain("shell commands");
    const profile = await codingProfile({ root, home });
    expect(profile.checkpointProvider?.coverage).toBe("declared");
    expect(profile.checkpointNotice).toBe(notice);
    expect(profile.checkpointUnavailable).toBeUndefined();
    expect((profile.checkpointProvider as ShadowCheckpointProvider).directory).toStartWith(
      join(home, ".mu", "checkpoints"),
    );
  });

  test("the home directory and its ancestors never get checkpoints, even as a repository", async () => {
    const parent = await scratch();
    const home = join(parent, "user");
    await mkdir(home);
    await git(home, "init", "--quiet");
    await git(parent, "init", "--quiet");
    expect(await partialCheckpointNotice(home, home)).toContain("home directory");
    expect(await partialCheckpointNotice(parent, home)).toContain("home directory");
    expect(await partialCheckpointNotice(parse(parent).root, home)).toContain("filesystem root");
  });

  test("checkpoints can be turned off by the flag, project config or user config", async () => {
    const root = await scratch();
    const home = await scratch();
    await git(root, "init", "--quiet");
    const config = (dir: string, enabled: boolean) =>
      mkdir(join(dir, ".mu"), { recursive: true }).then(() =>
        writeFile(join(dir, ".mu", "config.json"), JSON.stringify({ checkpoints: { enabled } })),
      );

    await config(home, false);
    const user = await codingProfile({ root, home });
    expect(user.checkpointProvider).toBeUndefined();
    expect(user.checkpointUnavailable).toContain(join(home, ".mu", "config.json"));

    await config(root, true);
    expect((await codingProfile({ root, home })).checkpointProvider).toBeDefined();

    await config(root, false);
    const project = await codingProfile({ root, home });
    expect(project.checkpointProvider).toBeUndefined();
    expect(project.checkpointUnavailable).toContain(join(root, ".mu", "config.json"));
    expect(
      (await codingProfile({ root, home, checkpoints: true })).checkpointProvider,
    ).toBeDefined();

    await config(root, true);
    const flag = await codingProfile({ root, home, checkpoints: false });
    expect(flag.checkpointProvider).toBeUndefined();
    expect(flag.checkpointUnavailable).toContain("--no-checkpoints");
    const track = flag.commands?.find((command) => command.name === "track");
    expect(await track?.run({ args: "" } as never)).toMatchObject({
      message: flag.checkpointUnavailable,
    });
  });

  test("a project below the home directory is unaffected by the home guard", async () => {
    const home = await scratch();
    const root = join(home, "code", "project");
    await mkdir(root, { recursive: true });
    await git(root, "init", "--quiet");
    expect(await partialCheckpointNotice(root, home)).toBeUndefined();
  });
});

describe("which coding tools need an after-turn checkpoint", () => {
  test("reading tools and inspection commands are read-only; writers and other commands are not", async () => {
    const profile = await codingProfile({ root: await scratch(), home: await scratch() });
    const changes = (name: string, args: unknown = {}) => {
      const flag = profile.toolset.find((tool) => tool.name === name)?.changesState;
      return typeof flag === "function" ? flag(args) : flag;
    };
    for (const name of ["read", "ls", "todo", "task_output", "task_list"]) {
      expect(changes(name)).toBe(false);
    }
    expect(changes("write")).toBe(true);
    expect(changes("edit")).toBe(true);
    expect(changes("bash", { command: "rg --files" })).toBe(false);
    expect(changes("bash", { command: "npm install" })).toBe(true);
    expect(changes("task_kill")).toBeUndefined();
  });
});

describe("turn-level agent undo", () => {
  test("one undo removes everything created by a write-then-verify turn", async () => {
    const root = await workspace();
    const profile = await codingProfile({ root });
    const checkpoints = provider(root);
    const prompt = "create fibonacci.py and verify it";
    const agent = new Agent({
      provider: new FakeProvider([
        {
          content: [
            {
              type: "toolCall",
              id: "write-1",
              name: "write",
              arguments: { path: "fibonacci.py", content: "print('0 1 1 2 3')\n" },
            },
          ],
        },
        {
          content: [
            {
              type: "toolCall",
              id: "bash-1",
              name: "bash",
              arguments: { command: "python3 fibonacci.py" },
            },
          ],
        },
        { content: [{ type: "text", text: "Created and verified fibonacci.py." }] },
      ]),
      model: fakeModel,
      tools: profile.toolset,
      checkpointProvider: checkpoints,
      permissions: [{ permission: "*", pattern: "*", action: "allow" }],
    });

    await agent.run(prompt);
    expect(agent.checkpointHistory.all()).toHaveLength(1);
    expect(await readFile(join(root, "fibonacci.py"), "utf8")).toContain("0 1 1 2 3");

    const undone = await agent.undo();
    expect(undone.ok).toBe(true);
    expect(undone.data?.prompt).toBe(prompt);
    expect(undone.data?.files.map((file) => file.path)).toEqual(["fibonacci.py"]);
    await expect(access(join(root, "fibonacci.py"))).rejects.toThrow();

    expect((await agent.redo()).ok).toBe(true);
    expect(await readFile(join(root, "fibonacci.py"), "utf8")).toContain("0 1 1 2 3");
  });

  test("a permission granted mid-turn survives undo of that turn", async () => {
    const root = await workspace();
    const profile = await codingProfile({ root });
    const checkpoints = provider(root);
    // Stands in for the user answering "always allow" while the turn is running.
    const grant: Tool = {
      name: "grant",
      description: "remember a permission",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        await profile.rememberPermission?.("bash", "npm test*");
        return { content: [{ type: "text", text: "granted" }] };
      },
    };
    const agent = new Agent({
      provider: new FakeProvider([
        {
          content: [
            {
              type: "toolCall",
              id: "write-1",
              name: "write",
              arguments: { path: "app.py", content: "print('hi')\n" },
            },
          ],
        },
        { content: [{ type: "toolCall", id: "grant-1", name: "grant", arguments: {} }] },
        { content: [{ type: "text", text: "Done." }] },
      ]),
      model: fakeModel,
      tools: [...profile.toolset, grant],
      checkpointProvider: checkpoints,
      permissions: [{ permission: "*", pattern: "*", action: "allow" }],
    });

    await agent.run("create app.py");
    expect(await loadProjectConfig(root)).toMatchObject({
      permissions: [{ permission: "bash", pattern: "npm test*", action: "allow" }],
    });

    const undone = await agent.undo();
    expect(undone.ok).toBe(true);
    expect(undone.data?.files.map((file) => file.path)).toEqual(["app.py"]);
    await expect(access(join(root, "app.py"))).rejects.toThrow();
    // The turn's edit is gone; the user's own decision is not.
    expect(await loadProjectConfig(root)).toMatchObject({
      permissions: [{ permission: "bash", pattern: "npm test*", action: "allow" }],
    });
  });
});

describe("capturing only named files", () => {
  const tree = async (p: ShadowCheckpointProvider, ref: string) =>
    (await git(p.directory, `--git-dir=${p.directory}`, "ls-tree", "-r", "--name-only", ref))
      .split("\n")
      .filter(Boolean);
  const show = (p: ShadowCheckpointProvider, ref: string, path: string) =>
    git(p.directory, `--git-dir=${p.directory}`, "show", `${ref}:${path}`);

  test("named files take their current state and every other file keeps the base", async () => {
    const root = await workspace();
    await writeFile(join(root, "named.txt"), "before\n");
    await writeFile(join(root, "other.txt"), "before\n");
    await writeFile(join(root, "gone.txt"), "before\n");
    const p = provider(root);
    const base = (await p.snapshot()) as string;
    await writeFile(join(root, "named.txt"), "after\n");
    await writeFile(join(root, "other.txt"), "after\n");
    await writeFile(join(root, "created.txt"), "new\n");
    await rm(join(root, "gone.txt"));

    const ref = (await p.snapshotResources(base, [
      "named.txt",
      "created.txt",
      "gone.txt",
    ])) as string;

    expect(await tree(p, ref)).toEqual(["created.txt", "named.txt", "other.txt"]);
    expect(await show(p, ref, "named.txt")).toBe("after\n");
    expect(await show(p, ref, "other.txt")).toBe("before\n");
    expect((await p.diff(base, ref)).map((file) => file.path)).toEqual([
      "created.txt",
      "gone.txt",
      "named.txt",
    ]);
    expect(await git(p.directory, `--git-dir=${p.directory}`, "rev-parse", "HEAD")).toBe(
      `${ref}\n`,
    );
    expect((await readdir(p.directory)).filter((name) => name.startsWith("index.mu-"))).toEqual([]);
  });

  test("named files outside what a full snapshot records are left out", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitignore"), "*.log\n*.secret\n");
    await writeFile(join(root, "kept.secret"), "before\n");
    const p = new ShadowCheckpointProvider({
      root,
      shadowDir: join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`),
      include: ["kept.secret"],
    });
    const base = (await p.snapshot()) as string;
    await writeFile(join(root, "debug.log"), "ignored\n");
    await writeFile(join(root, "kept.secret"), "after\n");
    await writeFile(join(root, "dump.bin"), Buffer.alloc(3 * 1024 * 1024));
    await mkdir(join(root, ".mu"), { recursive: true });
    await writeFile(join(root, ".mu", "config.json"), "{}\n");

    const ref = (await p.snapshotResources(base, [
      "debug.log",
      "kept.secret",
      "dump.bin",
      ".mu/config.json",
      "../outside.txt",
    ])) as string;

    expect((await p.diff(base, ref)).map((file) => file.path)).toEqual(["kept.secret"]);
  });

  test("a named directory or an unknown base cannot be captured this way", async () => {
    const root = await workspace();
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "a.txt"), "a\n");
    const p = provider(root);
    const base = (await p.snapshot()) as string;
    expect(await p.snapshotResources(base, ["folder"])).toBeUndefined();
    expect(await p.snapshotResources("0".repeat(40), ["folder/a.txt"])).toBeUndefined();
  });

  test("a full snapshot after a named capture still sees every change", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "one\n");
    await writeFile(join(root, "b.txt"), "one\n");
    const p = provider(root);
    const base = (await p.snapshot()) as string;
    await writeFile(join(root, "a.txt"), "two\n");
    await p.snapshotResources(base, ["a.txt"]);
    await writeFile(join(root, "b.txt"), "two\n");
    const full = (await p.snapshot()) as string;

    expect(await show(p, full, "a.txt")).toBe("two\n");
    expect(await show(p, full, "b.txt")).toBe("two\n");
  });
});

type Call = [name: string, args: Record<string, unknown>];
function scripted(...turns: Call[][]): FakeProvider {
  let id = 0;
  return new FakeProvider(
    turns.flatMap((calls) => [
      ...calls.map(([name, args]) => ({
        content: [{ type: "toolCall" as const, id: `call-${id++}`, name, arguments: args }],
      })),
      { content: [{ type: "text" as const, text: "done" }] },
    ]),
  );
}

function counted(p: ShadowCheckpointProvider) {
  const calls: string[] = [];
  const checkpoints = {
    coverage: p.coverage,
    snapshot: (label?: string, signal?: AbortSignal) => {
      calls.push("full");
      return p.snapshot(label, signal);
    },
    snapshotResources: (base: string | undefined, resources: string[], label?: string) => {
      calls.push(`resources ${resources.join(",")}`);
      return p.snapshotResources(base, resources, label);
    },
    restore: (ref: string) => p.restore(ref),
    restoreResources: (ref: string, paths: string[]) => p.restoreResources(ref, paths),
    diff: (from: string, to?: string) => p.diff(from, to),
  };
  return { calls, checkpoints };
}

async function agentFor(
  root: string,
  provider: FakeProvider,
  checkpoints: CheckpointProvider,
  extraTools: Tool[] = [],
  session?: MemorySessionStore,
) {
  const profile = await codingProfile({
    root,
    home: await scratch(),
    instructions: { enabled: false },
  });
  return new Agent({
    provider,
    model: fakeModel,
    tools: [...profile.toolset, ...extraTools],
    checkpointProvider: checkpoints,
    permissions: [{ permission: "*", pattern: "*", action: "allow" }],
    ...(session ? { session } : {}),
  });
}

const read = (path: string): Call => ["read", { path }];
const write = (path: string, content: string): Call => ["write", { path, content }];
const edit = (path: string, oldString: string, newString: string): Call => [
  "edit",
  { path, edits: [{ oldString, newString }] },
];
const text = (root: string, path: string) => readFile(join(root, path), "utf8");

describe("turns that only edit files capture only those files", () => {
  test("undo of an edit-only turn restores the edited file and nothing else", async () => {
    const root = await workspace();
    await writeFile(join(root, "agent.txt"), "before\n");
    await writeFile(join(root, "user.txt"), "before\n");
    const { calls, checkpoints } = counted(provider(root));
    // Stands in for the user saving a file in an editor while the turn runs.
    const userEdit: Tool = {
      name: "user_edit",
      description: "the user edits a file",
      inputSchema: { type: "object", properties: {} },
      changesState: false,
      execute: async () => {
        await writeFile(join(root, "user.txt"), "user edit\n");
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const agent = await agentFor(
      root,
      scripted([read("agent.txt"), ["user_edit", {}], edit("agent.txt", "before", "after")]),
      checkpoints,
      [userEdit],
    );

    await agent.run("edit agent.txt");
    expect(calls).toEqual(["full", "resources agent.txt"]);
    const undone = await agent.undo();
    expect(undone.data?.files.map((file) => file.path)).toEqual(["agent.txt"]);
    expect(await text(root, "agent.txt")).toBe("before\n");
    expect(await text(root, "user.txt")).toBe("user edit\n");
  });

  test("an edit followed by a shell command takes a full capture", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "before\n");
    const { calls, checkpoints } = counted(provider(root));
    const agent = await agentFor(
      root,
      scripted([
        read("a.txt"),
        edit("a.txt", "before", "after"),
        ["bash", { command: "echo made > made.txt" }],
      ]),
      checkpoints,
    );

    await agent.run("edit and build");
    expect(calls).toEqual(["full", "full"]);
    expect(await text(root, "made.txt")).toBe("made\n");
    expect((await agent.undo()).data?.files.map((file) => file.path)).toEqual([
      "a.txt",
      "made.txt",
    ]);
    expect(await text(root, "a.txt")).toBe("before\n");
    await expect(access(join(root, "made.txt"))).rejects.toThrow();
  });

  test("a written ignored file is neither restored nor deleted by undo", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitignore"), "*.log\n");
    const { calls, checkpoints } = counted(provider(root));
    const agent = await agentFor(root, scripted([write("debug.log", "trace\n")]), checkpoints);

    await agent.run("write a log");
    expect(calls).toEqual(["full", "resources debug.log"]);
    const undone = await agent.undo();
    expect(undone.ok).toBe(true);
    expect(undone.data?.files).toEqual([]);
    expect(await text(root, "debug.log")).toBe("trace\n");
  });

  test("an edited ignored file that /track includes is restored", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitignore"), "*.secret\n");
    await writeFile(join(root, "app.secret"), "original\n");
    const p = new ShadowCheckpointProvider({
      root,
      shadowDir: join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`),
      include: ["app.secret"],
    });
    const { calls, checkpoints } = counted(p);
    const agent = await agentFor(
      root,
      scripted([read("app.secret"), edit("app.secret", "original", "changed")]),
      checkpoints,
    );

    await agent.run("edit the secret");
    expect(calls).toEqual(["full", "resources app.secret"]);
    expect((await agent.undo()).data?.files.map((file) => file.path)).toEqual(["app.secret"]);
    expect(await text(root, "app.secret")).toBe("original\n");
  });

  test("a created file is removed by undo and brought back by redo", async () => {
    const root = await workspace();
    const { calls, checkpoints } = counted(provider(root));
    const agent = await agentFor(
      root,
      scripted([write("src/new.ts", "export {};\n")]),
      checkpoints,
    );

    await agent.run("create a file");
    expect(calls).toEqual(["full", "resources src/new.ts"]);
    expect((await agent.undo()).data?.files.map((file) => file.path)).toEqual(["src/new.ts"]);
    await expect(access(join(root, "src", "new.ts"))).rejects.toThrow();
    expect((await agent.redo()).ok).toBe(true);
    expect(await text(root, "src/new.ts")).toBe("export {};\n");
  });

  test("a failed edit records no change", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "before\n");
    const { checkpoints } = counted(provider(root));
    const agent = await agentFor(
      root,
      scripted([read("a.txt"), edit("a.txt", "missing", "after")]),
      checkpoints,
    );

    await agent.run("edit");
    const [entry] = agent.checkpointHistory.all();
    expect(await checkpoints.diff(entry?.beforeRef as string, entry?.afterRef)).toEqual([]);
    expect((await agent.undo()).data?.files).toEqual([]);
    expect(await text(root, "a.txt")).toBe("before\n");
  });

  test("undo and redo span turns captured by name and in full", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "v0\n");
    const { calls, checkpoints } = counted(provider(root));
    const agent = await agentFor(
      root,
      scripted(
        [write("x.txt", "x1\n")],
        [read("a.txt"), edit("a.txt", "v0", "v1"), ["bash", { command: "echo y > y.txt" }]],
        [read("x.txt"), edit("x.txt", "x1", "x2"), read("a.txt"), edit("a.txt", "v1", "v2")],
      ),
      checkpoints,
    );
    await agent.run("one");
    await agent.run("two");
    await agent.run("three");
    expect(calls).toEqual([
      "full",
      "resources x.txt",
      "full",
      "full",
      "full",
      "resources x.txt,a.txt",
    ]);

    const diff = await agent.sessionDiff();
    expect(diff.map((file) => file.path)).toEqual(["a.txt", "x.txt", "y.txt"]);

    expect((await agent.undo(3)).ok).toBe(true);
    expect(await text(root, "a.txt")).toBe("v0\n");
    await expect(access(join(root, "x.txt"))).rejects.toThrow();
    await expect(access(join(root, "y.txt"))).rejects.toThrow();

    expect((await agent.redo()).ok).toBe(true);
    expect(await text(root, "x.txt")).toBe("x1\n");
    await expect(access(join(root, "y.txt"))).rejects.toThrow();
    expect((await agent.redo()).ok).toBe(true);
    expect(await text(root, "a.txt")).toBe("v1\n");
    expect(await text(root, "y.txt")).toBe("y\n");
    expect((await agent.redo()).ok).toBe(true);
    expect(await text(root, "a.txt")).toBe("v2\n");
    expect(await text(root, "x.txt")).toBe("x2\n");
  });

  test("a resumed session undoes a turn captured by name", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "before\n");
    const shadowDir = join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`);
    const session = new MemorySessionStore();
    const first = await agentFor(
      root,
      scripted([read("a.txt"), edit("a.txt", "before", "after")]),
      new ShadowCheckpointProvider({ root, shadowDir }),
      [],
      session,
    );
    await first.run("edit");
    await first.shutdown();

    const second = await agentFor(
      root,
      scripted(),
      new ShadowCheckpointProvider({ root, shadowDir }),
      [],
      session,
    );
    second.resume((await session.load(first.sessionId)) as SessionTree);
    expect((await second.undo()).data?.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(await text(root, "a.txt")).toBe("before\n");
  });
});

describe("outside a git repository only edits and writes are recorded", () => {
  function declared(root: string): ShadowCheckpointProvider {
    return new ShadowCheckpointProvider({
      root,
      shadowDir: join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`),
      coverage: "declared",
    });
  }
  const files = (p: ShadowCheckpointProvider, ref: string) =>
    git(p.directory, `--git-dir=${p.directory}`, "ls-tree", "-r", "--name-only", ref).then((out) =>
      out.split("\n").filter(Boolean),
    );

  test("named files are recorded without a repository, scan or size cap", async () => {
    const root = await scratch();
    await writeFile(join(root, "big.bin"), Buffer.alloc(3 * 1024 * 1024));
    await writeFile(join(root, "unnamed.txt"), "left alone\n");
    await mkdir(join(root, ".mu"));
    await writeFile(join(root, ".mu", "config.json"), "{}\n");
    const p = declared(root);

    const empty = (await p.snapshotResources(undefined, [])) as string;
    expect(await files(p, empty)).toEqual([]);
    const first = (await p.snapshotResources(undefined, ["big.bin", ".mu/config.json"])) as string;
    expect(await files(p, first)).toEqual(["big.bin"]);
    await writeFile(join(root, "note.txt"), "note\n");
    const second = (await p.snapshotResources(undefined, ["note.txt"])) as string;
    expect(await files(p, second)).toEqual(["big.bin", "note.txt"]);
    await expect(readdir(join(root, ".git"))).rejects.toThrow();
  });

  test("undoing a created nested file removes the folders it leaves empty", async () => {
    const root = await scratch();
    const p = declared(root);
    const before = (await p.snapshotResources(undefined, ["deep/nested/notes.txt"])) as string;
    await mkdir(join(root, "deep", "nested"), { recursive: true });
    await writeFile(join(root, "deep", "nested", "notes.txt"), "hello\n");
    await p.snapshotResources(before, ["deep/nested/notes.txt"]);

    await p.restoreResources(before, ["deep/nested/notes.txt"]);

    await expect(access(join(root, "deep"))).rejects.toThrow();
  });

  test("a full snapshot, restore and diff cover only recorded files", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "one\n");
    const p = declared(root);
    const base = (await p.snapshotResources(undefined, ["a.txt"])) as string;
    await writeFile(join(root, "a.txt"), "two\n");
    await writeFile(join(root, "unnamed.txt"), "new\n");

    expect((await p.diff(base)).map((file) => file.path)).toEqual(["a.txt"]);
    const now = (await p.snapshot()) as string;
    expect(await files(p, now)).toEqual(["a.txt"]);
    await p.restore(base);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(root, "unnamed.txt"), "utf8")).toBe("new\n");
  });

  test("an edit and a created file are undone and redone", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "before\n");
    const { calls, checkpoints } = counted(declared(root));
    const agent = await agentFor(
      root,
      scripted([read("a.txt"), edit("a.txt", "before", "after"), write("new/b.txt", "b\n")]),
      checkpoints,
    );

    await agent.run("edit and create");
    expect(calls).toEqual([
      "resources ",
      "resources a.txt",
      "resources new/b.txt",
      "resources a.txt,new/b.txt",
    ]);
    const undone = await agent.undo();
    expect(undone.data?.files.map((file) => file.path)).toEqual(["a.txt", "new/b.txt"]);
    expect(await text(root, "a.txt")).toBe("before\n");
    await expect(access(join(root, "new", "b.txt"))).rejects.toThrow();
    expect((await agent.redo()).ok).toBe(true);
    expect(await text(root, "a.txt")).toBe("after\n");
    expect(await text(root, "new/b.txt")).toBe("b\n");
    expect(calls.some((call) => call === "full")).toBe(false);
  });

  test("shell command changes are neither undone nor removed", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "before\n");
    const { calls, checkpoints } = counted(declared(root));
    const agent = await agentFor(
      root,
      scripted([
        read("a.txt"),
        edit("a.txt", "before", "after"),
        ["bash", { command: "echo made > made.txt" }],
      ]),
      checkpoints,
    );

    await agent.run("edit and build");
    expect(calls).not.toContain("full");
    expect((await agent.undo()).data?.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(await text(root, "a.txt")).toBe("before\n");
    expect(await text(root, "made.txt")).toBe("made\n");
  });

  test("a denied write records nothing", async () => {
    const root = await scratch();
    const { calls, checkpoints } = counted(declared(root));
    const profile = await codingProfile({
      root,
      home: await scratch(),
      instructions: { enabled: false },
    });
    const agent = new Agent({
      provider: scripted([write("a.txt", "a\n")]),
      model: fakeModel,
      tools: profile.toolset,
      checkpointProvider: checkpoints,
      permissions: [{ permission: "write", pattern: "*", action: "deny" }],
    });
    await agent.run("write");
    expect(calls).toEqual(["resources "]);
    await expect(access(join(root, "a.txt"))).rejects.toThrow();
  });

  test("undoing several turns restores a file from before the turn that first changed it", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "a0\n");
    await writeFile(join(root, "later.txt"), "l0\n");
    const { checkpoints } = counted(declared(root));
    const agent = await agentFor(
      root,
      scripted(
        [read("a.txt"), edit("a.txt", "a0", "a1")],
        [
          read("later.txt"),
          edit("later.txt", "l0", "l1"),
          read("a.txt"),
          edit("a.txt", "a1", "a2"),
        ],
      ),
      checkpoints,
    );
    await agent.run("one");
    await agent.run("two");

    const diff = await agent.sessionDiff();
    expect(diff.map((file) => [file.path, file.added, file.removed])).toEqual([
      ["a.txt", 1, 1],
      ["later.txt", 1, 1],
    ]);
    expect(diff[0]?.hunks).toContain("-a0");
    expect(diff[0]?.hunks).toContain("+a2");

    expect((await agent.undo(2)).ok).toBe(true);
    expect(await text(root, "a.txt")).toBe("a0\n");
    expect(await text(root, "later.txt")).toBe("l0\n");
    expect((await agent.redo()).ok).toBe(true);
    expect(await text(root, "a.txt")).toBe("a1\n");
    expect(await text(root, "later.txt")).toBe("l0\n");
    expect((await agent.redo()).ok).toBe(true);
    expect(await text(root, "a.txt")).toBe("a2\n");
    expect(await text(root, "later.txt")).toBe("l1\n");
  });

  test("a change made between turns is what undo of the next turn returns to", async () => {
    const root = await scratch();
    const { checkpoints } = counted(declared(root));
    const agent = await agentFor(
      root,
      scripted([write("a.txt", "agent\n")], [read("a.txt"), edit("a.txt", "user", "agent again")]),
      checkpoints,
    );
    await agent.run("create");
    await writeFile(join(root, "a.txt"), "user\n");
    await agent.run("edit");

    expect((await agent.undo()).ok).toBe(true);
    expect(await text(root, "a.txt")).toBe("user\n");
  });

  test("a resumed session undoes its edits", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "before\n");
    const shadowDir = join(tmpdir(), `mu-shadow-${process.pid}-${shadowRun}-${shadowCounter++}`);
    const session = new MemorySessionStore();
    const first = await agentFor(
      root,
      scripted([read("a.txt"), edit("a.txt", "before", "after")]),
      new ShadowCheckpointProvider({ root, shadowDir, coverage: "declared" }),
      [],
      session,
    );
    await first.run("edit");
    await first.shutdown();

    const second = await agentFor(
      root,
      scripted(),
      new ShadowCheckpointProvider({ root, shadowDir, coverage: "declared" }),
      [],
      session,
    );
    second.resume((await session.load(first.sessionId)) as SessionTree);
    expect((await second.undo()).data?.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(await text(root, "a.txt")).toBe("before\n");
  });

  test("/track explains that it applies only in a git repository", async () => {
    const profile = await codingProfile({ root: await scratch(), home: await scratch() });
    const track = profile.commands?.find((command) => command.name === "track");
    const result = await track?.run({ args: "x" } as Parameters<
      NonNullable<typeof track>["run"]
    >[0]);
    expect(result).toMatchObject({ message: expect.stringContaining("only in a git repository") });
  });
});
