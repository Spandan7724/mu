// Shadow-repository checkpoints. The user's own repository is never touched:
// we point a separate --git-dir at a directory under ~/.mu and use the session
// root as the work tree, so no commits, refs, index entries or hooks of theirs
// are involved.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { CheckpointDiffFile, CheckpointProvider } from "@mu/core";

export interface ShadowCheckpointOptions {
  root: string;
  // Where the shadow repository lives. Default: ~/.mu/checkpoints/<scope>
  shadowDir?: string;
  scope?: string;
  run?: GitRunner;
}

export type GitRunner = (
  args: string[],
  env: Record<string, string>,
  cwd: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultRun: GitRunner = async (args, env, cwd) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

function parseNumstat(output: string): CheckpointDiffFile[] {
  const files: CheckpointDiffFile[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const [added, removed, path] = line.split("\t");
    if (!path) continue;
    files.push({
      path,
      added: added === "-" ? 0 : Number(added ?? 0),
      removed: removed === "-" ? 0 : Number(removed ?? 0),
      hunks: [],
    });
  }
  return files;
}

export class ShadowCheckpointProvider implements CheckpointProvider {
  private readonly root: string;
  private readonly shadowDir: string;
  private readonly run: GitRunner;
  private initialized = false;

  constructor(options: ShadowCheckpointOptions) {
    this.root = resolve(options.root);
    const scope = options.scope ?? this.root.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    this.shadowDir = options.shadowDir ?? join(homedir(), ".mu", "checkpoints", scope);
    this.run = options.run ?? defaultRun;
  }

  get directory(): string {
    return this.shadowDir;
  }

  private env(): Record<string, string> {
    return {
      GIT_DIR: this.shadowDir,
      GIT_WORK_TREE: this.root,
      // Never read the user's identity or hooks for our own bookkeeping.
      GIT_AUTHOR_NAME: "mu",
      GIT_AUTHOR_EMAIL: "mu@localhost",
      GIT_COMMITTER_NAME: "mu",
      GIT_COMMITTER_EMAIL: "mu@localhost",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
  }

  private async git(
    ...args: string[]
  ): Promise<{ stdout: string; exitCode: number; stderr: string }> {
    return this.run(args, this.env(), this.root);
  }

  private async ensure(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.shadowDir, { recursive: true });
    const check = await this.git("rev-parse", "--git-dir");
    if (check.exitCode !== 0) {
      await this.git("init", "--quiet");
    }

    // The shadow repository must never snapshot itself. This matters whenever
    // it is placed inside the session root — otherwise every snapshot grows by
    // its own history, and the directory shows up as junk in the user's
    // `git status`.
    const inside = relative(this.root, this.shadowDir);
    if (inside.length > 0 && !inside.startsWith("..")) {
      await mkdir(join(this.shadowDir, "info"), { recursive: true });
      await writeFile(join(this.shadowDir, "info", "exclude"), `/${inside}/\n`, "utf8");
    }
    this.initialized = true;
  }

  async snapshot(label?: string): Promise<string | undefined> {
    await this.ensure();
    // -A stages deletions too, so a snapshot is a faithful picture.
    const add = await this.git("add", "-A");
    if (add.exitCode !== 0) return undefined;

    const commit = await this.git(
      "commit",
      "--quiet",
      "--allow-empty",
      "--no-verify",
      "-m",
      label ?? `checkpoint ${new Date().toISOString()}`,
    );
    if (commit.exitCode !== 0) return undefined;

    const head = await this.git("rev-parse", "HEAD");
    const ref = head.stdout.trim();
    return ref.length > 0 ? ref : undefined;
  }

  async restore(ref: string): Promise<void> {
    await this.ensure();

    // Two steps, both required. `checkout` restores the content of everything
    // the snapshot contained; it does NOT remove files created afterwards, so
    // `clean` takes those out. Together they make the tree match the snapshot
    // exactly — which is what "undo" has to mean to be trustworthy.
    const checkout = await this.git("checkout", "--force", ref, "--", ".");
    if (checkout.exitCode !== 0) {
      throw new Error(`Could not restore checkpoint ${ref}: ${checkout.stderr.trim()}`);
    }
    // Point the index at the snapshot so anything absent from it counts as
    // untracked, then remove exactly those.
    await this.git("reset", "--quiet", ref, "--", ".");
    // -d for directories; ignored files are deliberately left alone so build
    // outputs and dependencies are not destroyed by an undo.
    await this.git("clean", "--force", "-d", "--quiet");
  }

  async diff(fromRef: string, toRef?: string): Promise<CheckpointDiffFile[]> {
    await this.ensure();
    const args = toRef ? ["diff", "--numstat", fromRef, toRef] : ["diff", "--numstat", fromRef];
    const result = await this.git(...args);
    if (result.exitCode !== 0) return [];
    const files = parseNumstat(result.stdout);

    for (const file of files) {
      const patchArgs = toRef
        ? ["diff", "--unified=3", fromRef, toRef, "--", file.path]
        : ["diff", "--unified=3", fromRef, "--", file.path];
      const patch = await this.git(...patchArgs);
      if (patch.exitCode === 0) file.hunks = patch.stdout.split("\n");
    }
    return files;
  }
}
