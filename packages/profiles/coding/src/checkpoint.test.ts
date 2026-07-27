import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "mu";
import { ShadowCheckpointProvider } from "./checkpoint.ts";
import { codingProfile } from "./index.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-ckpt-"));
}

// Production puts the shadow repo under ~/.mu, i.e. entirely outside the
// session root. Mirror that here (in a temp dir) so tests never touch ~/.mu.
let shadowCounter = 0;
function provider(root: string): ShadowCheckpointProvider {
  return new ShadowCheckpointProvider({
    root,
    shadowDir: join(tmpdir(), `mu-shadow-${process.pid}-${shadowCounter++}`),
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

describe("shadow checkpoints", () => {
  test("snapshot then restore brings a modified file back", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "original\n");

    const p = provider(root);
    const ref = await p.snapshot("before edit");
    expect(ref).toBeDefined();

    await writeFile(join(root, "a.txt"), "modified\n");
    await p.restore(ref as string);

    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original\n");
  });

  test("restore removes files created after the snapshot", async () => {
    const root = await scratch();
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
    const root = await scratch();
    const p = provider(root);
    const empty = await p.snapshot("empty");
    await writeFile(join(root, "created.txt"), "created\n");
    await p.snapshot("with file");

    await p.restore(empty as string);

    expect(await readdir(root)).toEqual([]);
  });

  test("scoped restore removes a created file without touching unrelated later work", async () => {
    const root = await scratch();
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
    const root = await scratch();
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
    const root = await scratch();
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
    const root = await scratch();
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
    const root = await scratch();
    await writeFile(join(root, "deleted.txt"), "here\n");
    const p = provider(root);
    const ref = await p.snapshot();

    await rm(join(root, "deleted.txt"));
    await p.restore(ref as string);

    expect(await readFile(join(root, "deleted.txt"), "utf8")).toBe("here\n");
  });

  test("restore recovers existing ignored files and removes new ignored files", async () => {
    const root = await scratch();
    await writeFile(join(root, ".gitignore"), "*.secret\n");
    await writeFile(join(root, "user.secret"), "user state\n");
    const p = provider(root);
    const ref = await p.snapshot();

    await writeFile(join(root, "user.secret"), "overwritten\n");
    await writeFile(join(root, "created.secret"), "new\n");
    await p.restore(ref as string);

    expect(await readFile(join(root, "user.secret"), "utf8")).toBe("user state\n");
    await expect(access(join(root, "created.secret"))).rejects.toThrow();
  });

  test("diff reports per-file added and removed counts", async () => {
    const root = await scratch();
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

  test("successive snapshots produce distinct references", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "1\n");
    const p = provider(root);
    const first = await p.snapshot();
    await writeFile(join(root, "a.txt"), "2\n");
    const second = await p.snapshot();
    expect(first).not.toBe(second);
  });

  test("diff includes newly created, ignored and odd-named files before another snapshot", async () => {
    const root = await scratch();
    await writeFile(join(root, ".gitignore"), "*.secret\n");
    await writeFile(join(root, "base.txt"), "base\n");
    const p = provider(root);
    const first = await p.snapshot();

    await writeFile(join(root, "new.ts"), "export const value = 1;\n");
    await writeFile(join(root, "cache.secret"), "ignored but changed\n");
    await writeFile(join(root, "odd\tname\n.txt"), "odd\n");

    const files = await p.diff(first as string);
    expect(new Set(files.map((file) => file.path))).toEqual(
      new Set(["new.ts", "cache.secret", "odd\tname\n.txt"]),
    );
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
    const firstRoot = await scratch();
    const secondRoot = await scratch();
    const shadowDir = join(tmpdir(), `mu-shadow-owner-${process.pid}-${shadowCounter++}`);
    const first = new ShadowCheckpointProvider({ root: firstRoot, shadowDir });
    await first.snapshot();

    const second = new ShadowCheckpointProvider({ root: secondRoot, shadowDir });
    await expect(second.snapshot()).rejects.toThrow("belongs to");
  });
});

describe("the user's own repository is never touched", () => {
  test("no commits, refs or objects are added to the user's repo", async () => {
    const root = await scratch();
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
    const root = await scratch();
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
    const root = await scratch();
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
    const root = await scratch();
    const p = provider(root);
    await p.snapshot();
    expect(p.directory.startsWith(root)).toBe(false);
    expect(await readdir(p.directory)).toContain("HEAD");
    // Nothing of ours appears in the user's directory listing.
    expect(await readdir(root)).not.toContain(".shadow-git");
  });

  test("a shadow repo placed inside the root excludes itself", async () => {
    // Not the default layout, but it must not corrupt snapshots if configured.
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "content\n");
    const inside = new ShadowCheckpointProvider({ root, shadowDir: join(root, ".shadow-git") });
    const first = await inside.snapshot();
    await writeFile(join(root, "a.txt"), "changed\n");
    const second = await inside.snapshot();

    const files = await inside.diff(first as string, second as string);
    expect(files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  test("checkpoints work in a directory that is not a repository at all", async () => {
    const root = await scratch();
    await writeFile(join(root, "plain.txt"), "no repo here\n");
    const p = provider(root);
    const ref = await p.snapshot();
    expect(ref).toBeDefined();

    await writeFile(join(root, "plain.txt"), "changed\n");
    await p.restore(ref as string);
    expect(await readFile(join(root, "plain.txt"), "utf8")).toBe("no repo here\n");
    // And we did not turn their directory into a repo.
    await expect(readdir(join(root, ".git"))).rejects.toThrow();
  });
});

describe("turn-level agent undo", () => {
  test("one undo removes everything created by a write-then-verify turn", async () => {
    const root = await scratch();
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
});
