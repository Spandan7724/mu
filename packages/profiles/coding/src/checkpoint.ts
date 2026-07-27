// Shadow-repository checkpoints. The user's own repository is never touched:
// we point a separate --git-dir at a directory under ~/.mu and use the session
// root as the work tree, so no commits, refs, index entries or hooks of theirs
// are involved.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
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
  for (const record of output.split("\0")) {
    if (record.length === 0) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const added = record.slice(0, firstTab);
    const removed = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    files.push({
      path,
      added: added === "-" ? 0 : Number(added),
      removed: removed === "-" ? 0 : Number(removed),
      hunks: [],
    });
  }
  return files;
}

function canonicalRoot(root: string): string {
  const resolved = resolve(root);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function workspaceKey(root: string, scope?: string): string {
  const readable = (scope ?? basename(root)).replace(/[^A-Za-z0-9._-]+/g, "-") || "workspace";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return `${readable}-${hash}`;
}

export class ShadowCheckpointProvider implements CheckpointProvider {
  private readonly root: string;
  private readonly shadowDir: string;
  private readonly run: GitRunner;
  private readonly excludedPathspecs: string[];
  private initialized = false;

  constructor(options: ShadowCheckpointOptions) {
    this.root = canonicalRoot(options.root);
    const scope = workspaceKey(this.root, options.scope);
    this.shadowDir = options.shadowDir ?? join(homedir(), ".mu", "checkpoints", scope);
    this.run = options.run ?? defaultRun;
    const inside = relative(this.root, this.shadowDir).replaceAll("\\", "/");
    this.excludedPathspecs = [
      ":(exclude,literal).git",
      ":(exclude,glob).git/**",
      ...(inside.length > 0 && !inside.startsWith("..")
        ? [`:(exclude,literal)${inside}`, `:(exclude,glob)${inside}/**`]
        : []),
    ];
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
    const ownerFile = join(this.shadowDir, "mu-worktree");
    try {
      const owner = (await readFile(ownerFile, "utf8")).trim();
      if (owner !== this.root) {
        throw new Error(`Checkpoint store belongs to ${owner}, not ${this.root}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(ownerFile, `${this.root}\n`, "utf8");
    }

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
    const add = await this.git("add", "-A", "--force", "--", ".", ...this.excludedPathspecs);
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

    const readTree = await this.git("read-tree", "--reset", "-u", ref);
    if (readTree.exitCode !== 0) {
      throw new Error(`Could not restore checkpoint ${ref}: ${readTree.stderr.trim()}`);
    }
    const clean = await this.git(
      "clean",
      "--force",
      "-d",
      "-x",
      "--quiet",
      "-e",
      ".git",
      ...(relative(this.root, this.shadowDir).startsWith("..")
        ? []
        : ["-e", relative(this.root, this.shadowDir).replaceAll("\\", "/")]),
    );
    if (clean.exitCode !== 0) {
      throw new Error(`Could not clean checkpoint ${ref}: ${clean.stderr.trim()}`);
    }
  }

  async restoreResources(ref: string, resources: string[]): Promise<void> {
    await this.ensure();
    const paths = [
      ...new Set(
        resources.map((resource) => {
          const absolute = resolve(this.root, resource);
          const path = relative(this.root, absolute).replaceAll("\\", "/");
          if (path.length === 0 || path === ".." || path.startsWith("../")) {
            throw new Error(`Checkpoint resource escapes the workspace: ${resource}`);
          }
          return path;
        }),
      ),
    ];
    if (paths.length === 0) return;

    const pathspecs = paths.map((path) => `:(literal)${path}`);
    const reset = await this.git("reset", "--quiet", ref, "--", ...pathspecs);
    if (reset.exitCode !== 0) {
      throw new Error(`Could not reset checkpoint ${ref}: ${reset.stderr.trim()}`);
    }

    const existing: string[] = [];
    const missing: string[] = [];
    for (const path of paths) {
      const tree = await this.git("ls-tree", "-z", ref, "--", `:(literal)${path}`);
      if (tree.exitCode !== 0) {
        throw new Error(`Could not inspect checkpoint ${ref}: ${tree.stderr.trim()}`);
      }
      (tree.stdout.length > 0 ? existing : missing).push(path);
    }

    if (existing.length > 0) {
      const checkout = await this.git(
        "checkout",
        "--force",
        ref,
        "--",
        ...existing.map((path) => `:(literal)${path}`),
      );
      if (checkout.exitCode !== 0) {
        throw new Error(`Could not restore checkpoint ${ref}: ${checkout.stderr.trim()}`);
      }
    }
    await Promise.all(
      missing.map((path) => rm(resolve(this.root, path), { recursive: true, force: true })),
    );
  }

  async diff(fromRef: string, toRef?: string): Promise<CheckpointDiffFile[]> {
    await this.ensure();
    if (!toRef) {
      const add = await this.git("add", "-A", "--force", "--", ".", ...this.excludedPathspecs);
      if (add.exitCode !== 0) return [];
    }
    const args = toRef
      ? ["diff", "--no-renames", "--numstat", "-z", fromRef, toRef]
      : ["diff", "--no-renames", "--cached", "--numstat", "-z", fromRef];
    const result = await this.git(...args);
    if (result.exitCode !== 0) return [];
    const files = parseNumstat(result.stdout);

    for (const file of files) {
      const patchArgs = toRef
        ? ["diff", "--no-renames", "--unified=3", fromRef, toRef, "--", file.path]
        : ["diff", "--no-renames", "--cached", "--unified=3", fromRef, "--", file.path];
      const patch = await this.git(...patchArgs);
      if (patch.exitCode === 0) file.hunks = patch.stdout.split("\n");
    }
    return files;
  }
}
