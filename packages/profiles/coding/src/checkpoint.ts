// Shadow-repository checkpoints. The user's own repository is never touched:
// we point a separate --git-dir at a directory under ~/.mu and use the session
// root as the work tree, so no commits, refs, index entries or hooks of theirs
// are involved.
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
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

export function gitConfigNullDevice(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

const defaultRun: GitRunner = async (args, env, cwd) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
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

const DISPOSABLE_IGNORED_DIRECTORIES = new Set([
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
]);
const SHADOW_STORE_VERSION = "2";
const LOCK_WAIT_MS = 30_000;
const INCOMPLETE_LOCK_GRACE_MS = 1_000;
// Mu's own project state. A permission grant ("always allow") or a model
// choice is written here mid-turn, so snapshotting it would make undo revoke
// decisions the user made deliberately — state the turn did not author.
const STATE_DIRECTORY = ".mu";

function disposableDirectoryFor(path: string): string | undefined {
  const parts = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  const disposableIndex = parts.findIndex((part) => DISPOSABLE_IGNORED_DIRECTORIES.has(part));
  if (disposableIndex === -1) return undefined;
  return parts.slice(0, disposableIndex + 1).join("/");
}

function cleanExcludePattern(path: string): string {
  return `/${path.replaceAll("\\", "\\\\").replace(/[?*[#]/g, "\\$&")}/`;
}

export class ShadowCheckpointProvider implements CheckpointProvider {
  private readonly root: string;
  private readonly shadowDir: string;
  private readonly run: GitRunner;
  private readonly lockDir: string;
  private readonly excludedPathspecs: string[];
  private initialized = false;

  constructor(options: ShadowCheckpointOptions) {
    this.root = canonicalRoot(options.root);
    const scope = workspaceKey(this.root, options.scope);
    this.shadowDir = options.shadowDir ?? join(homedir(), ".mu", "checkpoints", scope);
    // The lock deliberately lives beside the repository: an old store may be
    // removed and rebuilt while locked, and that must not remove the lock too.
    this.lockDir = `${this.shadowDir}.lock`;
    this.run = options.run ?? defaultRun;
    const inside = relative(this.root, this.shadowDir).replaceAll("\\", "/");
    const lockInside = relative(this.root, this.lockDir).replaceAll("\\", "/");
    this.excludedPathspecs = [
      ":(exclude,literal).git",
      ":(exclude,glob).git/**",
      `:(exclude,literal)${STATE_DIRECTORY}`,
      `:(exclude,glob)${STATE_DIRECTORY}/**`,
      ...(inside.length > 0 && !inside.startsWith("..")
        ? [`:(exclude,literal)${inside}`, `:(exclude,glob)${inside}/**`]
        : []),
      ...(lockInside.length > 0 && !lockInside.startsWith("..")
        ? [`:(exclude,literal)${lockInside}`, `:(exclude,glob)${lockInside}/**`]
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
      GIT_CONFIG_GLOBAL: gitConfigNullDevice(),
      GIT_CONFIG_NOSYSTEM: "1",
    };
  }

  private async git(
    ...args: string[]
  ): Promise<{ stdout: string; exitCode: number; stderr: string }> {
    return this.run(args, this.env(), this.root);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.lockDir), { recursive: true });
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        await mkdir(this.lockDir, { mode: 0o700 });
        const ownerFile = join(this.lockDir, "owner.json");
        const temporaryOwner = join(this.lockDir, `owner.${token}.tmp`);
        try {
          await writeFile(
            temporaryOwner,
            `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`,
            { encoding: "utf8", mode: 0o600, flag: "wx" },
          );
          await rename(temporaryOwner, ownerFile);
        } catch (error) {
          await rm(this.lockDir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        return async () => {
          const owner = await readFile(ownerFile, "utf8").catch(() => undefined);
          if (!owner) return;
          try {
            if ((JSON.parse(owner) as { token?: unknown }).token === token) {
              await rm(this.lockDir, { recursive: true, force: true });
            }
          } catch {
            // Never remove a lock whose ownership can no longer be proven.
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const ownerFile = join(this.lockDir, "owner.json");
      const owner = await readFile(ownerFile, "utf8").catch(() => undefined);
      let stale = false;
      let observedToken: string | undefined;
      if (owner) {
        try {
          const parsed = JSON.parse(owner) as { pid?: unknown; token?: unknown };
          observedToken = typeof parsed.token === "string" ? parsed.token : undefined;
          if (typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid)) {
            try {
              process.kill(parsed.pid, 0);
            } catch (error) {
              stale = (error as NodeJS.ErrnoException).code === "ESRCH";
            }
          } else stale = true;
        } catch {
          stale = true;
        }
      } else {
        const age = await stat(this.lockDir)
          .then((value) => Date.now() - value.mtimeMs)
          .catch(() => 0);
        stale = age >= INCOMPLETE_LOCK_GRACE_MS;
      }

      if (stale) {
        const current = await readFile(ownerFile, "utf8").catch(() => undefined);
        let currentToken: string | undefined;
        try {
          currentToken = current
            ? ((JSON.parse(current) as { token?: string }).token ?? undefined)
            : undefined;
        } catch {}
        if (currentToken === observedToken) {
          await rm(this.lockDir, { recursive: true, force: true });
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for checkpoint lock ${this.lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async ensure(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.shadowDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.shadowDir, 0o700);
    const ownerFile = join(this.shadowDir, "mu-worktree");
    let existingStore = false;
    try {
      const owner = (await readFile(ownerFile, "utf8")).trim();
      if (owner !== this.root) {
        throw new Error(`Checkpoint store belongs to ${owner}, not ${this.root}`);
      }
      existingStore = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const versionFile = join(this.shadowDir, "mu-checkpoint-version");
    if (existingStore) {
      const version = await readFile(versionFile, "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (version?.trim() !== SHADOW_STORE_VERSION) {
        // Version 1 force-tracked ignored dependency trees. Rebuild only Mu's
        // shadow repository; the user's worktree is outside this directory.
        await rm(this.shadowDir, { recursive: true, force: true });
        await mkdir(this.shadowDir, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") await chmod(this.shadowDir, 0o700);
      }
    }
    await writeFile(ownerFile, `${this.root}\n`, "utf8");

    const check = await this.git("rev-parse", "--git-dir");
    if (check.exitCode !== 0) {
      await this.git("init", "--quiet");
    }
    await writeFile(versionFile, `${SHADOW_STORE_VERSION}\n`, "utf8");

    // The shadow repository must never snapshot itself. This matters whenever
    // it is placed inside the session root — otherwise every snapshot grows by
    // its own history, and the directory shows up as junk in the user's
    // `git status`.
    const inside = relative(this.root, this.shadowDir).replaceAll("\\", "/");
    if (inside.length > 0 && !inside.startsWith("..")) {
      const lockInside = relative(this.root, this.lockDir).replaceAll("\\", "/");
      await mkdir(join(this.shadowDir, "info"), { recursive: true });
      await writeFile(
        join(this.shadowDir, "info", "exclude"),
        `/${inside}/\n${lockInside.length > 0 && !lockInside.startsWith("..") ? `/${lockInside}/\n` : ""}`,
        "utf8",
      );
    }
    this.initialized = true;
  }

  private async ignoredDisposableDirectories(): Promise<string[]> {
    // Include cached paths so a directory that became ignored after an older
    // checkpoint is still recognized. --directory lets Git collapse ignored,
    // untracked trees instead of enumerating dependencies and cache contents.
    const ignored = await this.git(
      "ls-files",
      "--cached",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    );
    if (ignored.exitCode !== 0) {
      throw new Error(`Could not enumerate ignored checkpoint paths: ${ignored.stderr.trim()}`);
    }

    const directories = new Set<string>();
    for (const path of ignored.stdout.split("\0")) {
      if (path.length === 0) continue;
      const directory = disposableDirectoryFor(path);
      if (directory) directories.add(directory);
    }
    return [...directories].sort();
  }

  private checkpointPathspecs(directories: string[]): string[] {
    return [
      ...this.excludedPathspecs,
      ...directories.map((directory) => `:(exclude,literal)${directory}`),
    ];
  }

  async snapshot(label?: string): Promise<string | undefined> {
    return this.locked(async () => {
      await this.ensure();
      const disposable = await this.ignoredDisposableDirectories();
      const add = await this.git(
        "add",
        "-A",
        "--force",
        "--",
        ".",
        ...this.checkpointPathspecs(disposable),
      );
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
    });
  }

  async restore(ref: string): Promise<void> {
    await this.locked(async () => {
      await this.ensure();

      const readTree = await this.git("read-tree", "--reset", "-u", ref);
      if (readTree.exitCode !== 0) {
        throw new Error(`Could not restore checkpoint ${ref}: ${readTree.stderr.trim()}`);
      }
      const disposable = await this.ignoredDisposableDirectories();
      const clean = await this.git(
        "clean",
        "--force",
        "-d",
        "-x",
        "--quiet",
        "-e",
        ".git",
        "-e",
        cleanExcludePattern(STATE_DIRECTORY),
        ...(relative(this.root, this.shadowDir).startsWith("..")
          ? []
          : ["-e", relative(this.root, this.shadowDir).replaceAll("\\", "/")]),
        ...(relative(this.root, this.lockDir).startsWith("..")
          ? []
          : ["-e", relative(this.root, this.lockDir).replaceAll("\\", "/")]),
        ...disposable.flatMap((directory) => ["-e", cleanExcludePattern(directory)]),
      );
      if (clean.exitCode !== 0) {
        throw new Error(`Could not clean checkpoint ${ref}: ${clean.stderr.trim()}`);
      }
    });
  }

  async restoreResources(ref: string, resources: string[]): Promise<void> {
    await this.locked(async () => {
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
    });
  }

  async diff(fromRef: string, toRef?: string): Promise<CheckpointDiffFile[]> {
    return this.locked(async () => {
      await this.ensure();
      if (!toRef) {
        const disposable = await this.ignoredDisposableDirectories();
        const add = await this.git(
          "add",
          "-A",
          "--force",
          "--",
          ".",
          ...this.checkpointPathspecs(disposable),
        );
        if (add.exitCode !== 0) {
          throw new Error(`Could not stage workspace for checkpoint diff: ${add.stderr.trim()}`);
        }
      }
      const args = toRef
        ? ["diff", "--no-renames", "--numstat", "-z", fromRef, toRef]
        : ["diff", "--no-renames", "--cached", "--numstat", "-z", fromRef];
      const result = await this.git(...args);
      if (result.exitCode !== 0) {
        throw new Error(`Could not calculate checkpoint diff: ${result.stderr.trim()}`);
      }
      const files = parseNumstat(result.stdout);

      for (const file of files) {
        const patchArgs = toRef
          ? ["diff", "--no-renames", "--unified=3", fromRef, toRef, "--", file.path]
          : ["diff", "--no-renames", "--cached", "--unified=3", fromRef, "--", file.path];
        const patch = await this.git(...patchArgs);
        if (patch.exitCode !== 0) {
          throw new Error(
            `Could not calculate checkpoint patch for ${file.path}: ${patch.stderr.trim()}`,
          );
        }
        file.hunks = patch.stdout.split("\n");
      }
      return files;
    });
  }
}
