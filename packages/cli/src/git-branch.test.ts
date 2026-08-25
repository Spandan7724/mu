import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeGitBranch } from "./git-branch.ts";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const error = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(error);
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for branch update");
    await Bun.sleep(20);
  }
}

test("git branch observation publishes checkout changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mu-git-branch-"));
  let stop = () => {};
  try {
    await git(root, "init", "-b", "main");
    await writeFile(join(root, "README.md"), "test\n");
    await git(root, "add", "README.md");
    await git(
      root,
      "-c",
      "user.name=Mu Test",
      "-c",
      "user.email=mu@example.com",
      "commit",
      "-m",
      "initial",
    );

    const branches: (string | undefined)[] = [];
    stop = await observeGitBranch(root, (branch) => branches.push(branch));
    expect(branches).toEqual(["main"]);

    await git(root, "checkout", "-b", "feature/dynamic-footer");
    await waitFor(() => branches.at(-1) === "feature/dynamic-footer");
  } finally {
    stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("git branch observation is silent outside a repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "mu-no-git-branch-"));
  try {
    const branches: (string | undefined)[] = [];
    const stop = await observeGitBranch(root, (branch) => branches.push(branch));
    expect(branches).toEqual([undefined]);
    stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
