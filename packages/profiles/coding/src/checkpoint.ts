// Shadow-repository checkpoints. The user's own repository is never touched:
// we point a separate --git-dir at a directory under ~/.mu and use the session
// root as the work tree, so no commits, refs, index entries or hooks of theirs
// are involved.
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { CheckpointDiffFile, CheckpointProvider } from "@mu/core";

export interface ShadowCheckpointOptions {
  root: string;
  // Where the shadow repository lives. Default: <home>/.mu/checkpoints/<scope>
  shadowDir?: string;
  home?: string;
  scope?: string;
  run?: GitRunner;
  // Workspace-relative paths recorded even when ignored or large.
  include?: string[];
  // "declared" records only the files tools name, with no repository needed.
  coverage?: "full" | "declared";
}

export interface GitRunOptions {
  signal?: AbortSignal;
  stdin?: string;
  // Output is discarded, and the process neither keeps mu alive nor outlives it.
  background?: boolean;
}

export type GitRunner = (
  args: string[],
  env: Record<string, string>,
  cwd: string,
  options?: GitRunOptions,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export function gitConfigNullDevice(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

const defaultRun: GitRunner = async (args, env, cwd, options = {}) => {
  if (options.background) {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const kill = () => proc.kill();
    process.once("exit", kill);
    proc.unref();
    try {
      return { stdout: "", stderr: "", exitCode: await proc.exited };
    } finally {
      process.off("exit", kill);
    }
  }
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    windowsHide: true,
    ...(options.signal ? { signal: options.signal } : {}),
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

const PARTIAL_SUFFIX = "changes made by shell commands or subagents cannot";

// A full snapshot costs a walk of everything Git does not ignore under the
// root, so full checkpoints run only where a repository's ignore rules bound
// that walk, and never over a home directory or filesystem root even when one
// is a repository. Elsewhere checkpoints record only the files mu's own tools
// name, and this says so.
export async function partialCheckpointNotice(
  root: string,
  home: string = homedir(),
  run: GitRunner = defaultRun,
): Promise<string | undefined> {
  const workspace = canonicalRoot(root);
  const homeFromRoot = relative(workspace, canonicalRoot(home));
  if (parse(workspace).root === workspace) {
    return `Only edits and writes can be undone at the filesystem root; ${PARTIAL_SUFFIX}.`;
  }
  if (homeFromRoot === "" || (!homeFromRoot.startsWith("..") && !isAbsolute(homeFromRoot))) {
    return `Only edits and writes can be undone in the home directory; ${PARTIAL_SUFFIX}.`;
  }
  const inside = await run(["rev-parse", "--is-inside-work-tree"], {}, workspace).catch(
    () => undefined,
  );
  if (inside?.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return `Only edits and writes can be undone outside a git repository; ${PARTIAL_SUFFIX} (git init makes them undoable).`;
  }
  return undefined;
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

// Bumped only when existing checkpoints can no longer be read: a rebuild deletes
// every saved checkpoint, and older releases rebuild any version they do not know.
// What gets staged may change without a bump. "3" was written by unreleased
// builds with the same format.
const SHADOW_STORE_VERSION = "2";
const SAME_FORMAT_VERSIONS = new Set([SHADOW_STORE_VERSION, "3"]);
const LOCK_WAIT_MS = 30_000;
const INCOMPLETE_LOCK_GRACE_MS = 1_000;
// Mu's own project state. A permission grant ("always allow") or a model
// choice is written here mid-turn, so snapshotting it would make undo revoke
// decisions the user made deliberately — state the turn did not author.
const STATE_DIRECTORY = ".mu";
// Repacking merges loose objects (one file of at least a disk block each) into
// delta-compressed packs. Thresholds follow opencode's snapshot store.
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
const LOOSE_OBJECT_LIMIT = 2048;
const PACK_LIMIT = 16;
// Untracked files above this size are left out, like ignored files.
const MAXIMUM_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
const GITLINK_MODE = "160000";
const TEMPORARY_INDEX_PREFIX = "index.mu-";

function nulSeparated(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

export class ShadowCheckpointProvider implements CheckpointProvider {
  readonly coverage: "full" | "declared";
  private readonly root: string;
  private readonly shadowDir: string;
  private readonly run: GitRunner;
  private readonly lockDir: string;
  private readonly excludedPrefixes: string[];
  private included: string[];
  private initialized = false;
  private lastMaintenance = Number.NEGATIVE_INFINITY;
  private maintenance: Promise<void> | undefined;

  constructor(options: ShadowCheckpointOptions) {
    this.root = canonicalRoot(options.root);
    const scope = workspaceKey(this.root, options.scope);
    this.shadowDir =
      options.shadowDir ?? join(options.home ?? homedir(), ".mu", "checkpoints", scope);
    // The lock deliberately lives beside the repository: an old store may be
    // removed and rebuilt while locked, and that must not remove the lock too.
    this.lockDir = `${this.shadowDir}.lock`;
    this.run = options.run ?? defaultRun;
    this.coverage = options.coverage ?? "full";
    this.excludedPrefixes = [".git", STATE_DIRECTORY, this.shadowDir, this.lockDir]
      .map((path) => relative(this.root, resolve(this.root, path)).replaceAll("\\", "/"))
      .filter((path) => path.length > 0 && !path.startsWith("..") && !isAbsolute(path));
    this.included = [];
    this.setIncludedPaths(options.include ?? []);
  }

  get directory(): string {
    return this.shadowDir;
  }

  get includedPaths(): string[] {
    return [...this.included];
  }

  // Takes effect at the next snapshot, so callers change it only between turns:
  // a path added mid-turn would read as created by that turn and undo would delete it.
  setIncludedPaths(paths: string[]): void {
    this.included = [...new Set(paths.map((path) => this.workspacePath(path)))].sort();
  }

  // Normalizes a user-supplied path to the workspace-relative form checkpoints use.
  workspacePath(path: string): string {
    const relativePath = relative(this.root, resolve(this.root, path))
      .replaceAll("\\", "/")
      .replace(/\/+$/, "");
    if (relativePath.length === 0) throw new Error("The workspace itself is always checkpointed.");
    if (relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
      throw new Error(`${path} is outside the workspace.`);
    }
    if (this.isExcluded(relativePath)) {
      throw new Error(`${relativePath} is never checkpointed.`);
    }
    return relativePath;
  }

  private isIncluded(path: string): boolean {
    return this.included.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
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

  private async cancellableGit(
    signal: AbortSignal | undefined,
    ...args: string[]
  ): Promise<{ stdout: string; exitCode: number; stderr: string }> {
    return this.run(args, this.env(), this.root, signal ? { signal } : {});
  }

  // Runs against the user's repository, read-only, so its own ignore rules
  // (ancestor .gitignore files, info/exclude, global excludes) apply.
  private async workspaceGit(
    signal: AbortSignal | undefined,
    ...args: string[]
  ): Promise<{ stdout: string; exitCode: number; stderr: string }> {
    return this.run(args, {}, this.root, signal ? { signal } : {});
  }

  private isExcluded(path: string): boolean {
    return this.excludedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  }

  private async acquireLock(signal?: AbortSignal): Promise<() => Promise<void>> {
    await mkdir(dirname(this.lockDir), { recursive: true });
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      signal?.throwIfAborted();
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

  private async locked<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquireLock(signal);
    try {
      // Every Git call on this store runs under the lock, so an index lock
      // seen now was left by a Git process killed mid-write.
      await rm(join(this.shadowDir, "index.lock"), { force: true });
      const leftovers = await readdir(this.shadowDir).catch(() => []);
      await Promise.all(
        leftovers
          .filter((name) => name.startsWith(TEMPORARY_INDEX_PREFIX))
          .map((name) => rm(join(this.shadowDir, name), { force: true })),
      );
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
      if (!SAME_FORMAT_VERSIONS.has(version?.trim() ?? "")) {
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

    this.initialized = true;
  }

  // Everything the user's repository tracks or would show as untracked, minus
  // large untracked files, plus explicitly included paths even when ignored.
  // Undefined when aborted.
  private async workspacePaths(signal?: AbortSignal): Promise<Set<string> | undefined> {
    const included = this.included.map((path) => `:(literal)${path}`);
    const [tracked, untracked, ignored] = await Promise.all([
      this.workspaceGit(signal, "ls-files", "-z", "--cached", "--stage", "--", "."),
      this.workspaceGit(signal, "ls-files", "-z", "--others", "--exclude-standard", "--", "."),
      included.length > 0
        ? this.workspaceGit(
            signal,
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--",
            ...included,
          )
        : Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    ]);
    if (signal?.aborted) return undefined;
    for (const result of [tracked, untracked, ignored]) {
      if (result.exitCode !== 0) {
        throw new Error(`Could not list checkpoint paths: ${result.stderr.trim()}`);
      }
    }

    const paths = new Set<string>();
    for (const record of nulSeparated(tracked.stdout)) {
      const tab = record.indexOf("\t");
      const path = record.slice(tab + 1);
      if (tab === -1 || record.startsWith(GITLINK_MODE) || this.isExcluded(path)) continue;
      paths.add(path);
    }
    // A trailing slash marks an embedded repository, which is not ours to record.
    const candidates = [...nulSeparated(untracked.stdout), ...nulSeparated(ignored.stdout)].filter(
      (path) => !path.endsWith("/") && !this.isExcluded(path) && !paths.has(path),
    );
    const sizes = await Promise.all(
      candidates.map((path) =>
        lstat(join(this.root, path)).then(
          (info) => info.size,
          () => 0,
        ),
      ),
    );
    candidates.forEach((path, index) => {
      if ((sizes[index] ?? 0) <= MAXIMUM_UNTRACKED_FILE_BYTES || this.isIncluded(path)) {
        paths.add(path);
      }
    });
    return paths;
  }

  private async updateIndex(flags: string[], paths: string[], signal?: AbortSignal): Promise<void> {
    if (paths.length === 0) return;
    // update-index takes literal paths, so a long list avoids add's pathspec matching.
    const result = await this.run(
      ["update-index", ...flags, "-z", "--stdin"],
      this.env(),
      this.root,
      {
        stdin: `${paths.join("\0")}\0`,
        ...(signal ? { signal } : {}),
      },
    );
    if (result.exitCode !== 0 && !signal?.aborted) {
      throw new Error(`Could not stage checkpoint: ${result.stderr.trim()}`);
    }
  }

  // Makes the shadow index match the workspace, rehashing only paths that are
  // new or whose stat data changed. Returns false when aborted.
  private async stage(signal?: AbortSignal): Promise<boolean> {
    const wanted = await this.workspacePaths(signal);
    if (!wanted) return false;
    const [indexed, modified] = await Promise.all([
      this.cancellableGit(signal, "ls-files", "-z"),
      this.cancellableGit(signal, "diff-files", "--name-only", "-z"),
    ]);
    if (signal?.aborted) return false;
    for (const result of [indexed, modified]) {
      if (result.exitCode !== 0) {
        throw new Error(`Could not compare checkpoint index: ${result.stderr.trim()}`);
      }
    }
    const current = new Set(nulSeparated(indexed.stdout));
    const changed = new Set(nulSeparated(modified.stdout));
    await this.updateIndex(
      ["--force-remove"],
      [...current].filter((path) => !wanted.has(path)),
      signal,
    );
    if (signal?.aborted) return false;
    await this.updateIndex(
      ["--add", "--remove", "--replace"],
      [...wanted].filter((path) => !current.has(path) || changed.has(path)),
      signal,
    );
    return !signal?.aborted;
  }

  async snapshot(label?: string, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return undefined;
    try {
      const ref = await this.locked(async () => {
        if (this.coverage === "full") return this.capture(label, signal);
        await this.ensure();
        const head = await this.head();
        return this.captureResources(head, head ? await this.recordedPaths(head) : [], label);
      }, signal);
      if (ref) this.startMaintenance();
      return ref;
    } catch (error) {
      if (signal?.aborted) return undefined;
      throw error;
    }
  }

  // Resolves once background store maintenance, if any, has finished.
  async settled(): Promise<void> {
    await this.maintenance;
  }

  // Only object-store maintenance, never `git gc`: its reflog expiry and ref
  // packing lock refs, which would make a concurrent capture's update-ref fail.
  // Repacking and pruning lock nothing a capture uses, prune only removes
  // unreachable objects older than two weeks, and every checkpoint is reachable
  // from HEAD. So this needs neither the store lock nor to stop for a snapshot,
  // and killing it when mu exits is safe.
  private startMaintenance(): void {
    if (this.maintenance || Date.now() - this.lastMaintenance < MAINTENANCE_INTERVAL_MS) return;
    this.maintenance = this.maintain()
      .catch(() => {})
      .finally(() => {
        this.maintenance = undefined;
      });
  }

  private async maintain(): Promise<void> {
    const stats = await this.git("count-objects", "-v");
    if (stats.exitCode !== 0) return;
    const count = (key: string) =>
      Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(stats.stdout)?.[1] ?? 0);
    const loose = count("count");
    const packs = count("packs");
    const background = (...args: string[]) =>
      this.run(args, this.env(), this.root, { background: true });
    if (packs >= PACK_LIMIT) await background("repack", "-a", "-d", "-q");
    else if (loose >= LOOSE_OBJECT_LIMIT) await background("repack", "-d", "-q");
    if (loose >= LOOSE_OBJECT_LIMIT) await background("prune", "--expire=2.weeks.ago");
    this.lastMaintenance = Date.now();
  }

  // Plumbing rather than `git commit`, which would collect status by walking
  // the work tree without the user's ignore rules.
  private async capture(label?: string, signal?: AbortSignal): Promise<string | undefined> {
    await this.ensure();
    if (!(await this.stage(signal))) return undefined;

    const tree = await this.git("write-tree");
    if (tree.exitCode !== 0) return undefined;
    return this.commit(tree.stdout.trim(), label);
  }

  // Every checkpoint is a descendant of the previous HEAD, which keeps all of
  // them reachable for maintenance pruning.
  // `head` is HEAD when the caller already read it under the lock (null: none).
  private async commit(
    tree: string,
    label?: string,
    head?: string | null,
  ): Promise<string | undefined> {
    const parent = head === undefined ? await this.head() : head;
    const commit = await this.git(
      "commit-tree",
      tree,
      ...(parent ? ["-p", parent] : []),
      "-m",
      label ?? `checkpoint ${new Date().toISOString()}`,
    );
    const ref = commit.stdout.trim();
    if (commit.exitCode !== 0 || ref.length === 0) return undefined;
    const update = await this.git("update-ref", "HEAD", ref);
    return update.exitCode === 0 ? ref : undefined;
  }

  async snapshotResources(
    baseRef: string | undefined,
    resources: string[],
    label?: string,
  ): Promise<string | undefined> {
    const ref = await this.locked(() => this.captureResources(baseRef, resources, label));
    if (ref) this.startMaintenance();
    return ref;
  }

  private async captureResources(
    baseRef: string | undefined,
    resources: string[],
    label?: string,
  ): Promise<string | undefined> {
    await this.ensure();
    if (resources.length === 0 || baseRef === undefined) {
      const base = await this.git(
        "rev-parse",
        "--verify",
        "--quiet",
        `${baseRef ?? "HEAD"}^{commit}`,
      );
      if (base.exitCode !== 0 && baseRef !== undefined) return undefined;
      const baseCommit = base.exitCode === 0 ? base.stdout.trim() : undefined;
      if (baseCommit && resources.length === 0) return baseCommit;
      const tree = await this.buildTree(baseCommit, resources);
      return tree ? this.commit(tree, label, baseCommit ?? null) : undefined;
    }
    // Spawns dominate this path, so independent Git calls run together.
    const [tree, head] = await Promise.all([this.buildTree(baseRef, resources), this.head()]);
    return tree ? this.commit(tree, label, head ?? null) : undefined;
  }

  // Builds on the base tree (or an empty one) in a private index, so the cost
  // follows the named paths rather than the workspace and the main index is
  // left for the next full stage() to reconcile.
  private async buildTree(
    baseCommit: string | undefined,
    resources: string[],
  ): Promise<string | undefined> {
    const paths = new Set<string>();
    for (const resource of resources) {
      const path = relative(this.root, resolve(this.root, resource)).replaceAll("\\", "/");
      if (path.length === 0 || path === ".." || path.startsWith("../") || isAbsolute(path))
        continue;
      if (!this.isExcluded(path)) paths.add(path);
    }
    const index = join(this.shadowDir, `${TEMPORARY_INDEX_PREFIX}${randomUUID()}`);
    const env = { ...this.env(), GIT_INDEX_FILE: index };
    const indexGit = (args: string[], stdin?: string) =>
      this.run(args, env, this.root, stdin === undefined ? {} : { stdin });
    try {
      const [scope, read] = await Promise.all([
        this.resourceScope([...paths]),
        indexGit(baseCommit ? ["read-tree", baseCommit] : ["read-tree", "--empty"]),
      ]);
      if (!scope || read.exitCode !== 0) return undefined;
      for (const [flags, list] of [
        [["--force-remove"], scope.dropped],
        [["--add", "--remove", "--replace"], scope.recorded],
      ] as const) {
        if (list.length === 0) continue;
        const update = await indexGit(
          ["update-index", ...flags, "-z", "--stdin"],
          `${list.join("\0")}\0`,
        );
        if (update.exitCode !== 0) {
          throw new Error(`Could not stage checkpoint: ${update.stderr.trim()}`);
        }
      }
      const tree = await indexGit(["write-tree"]);
      return tree.exitCode === 0 ? tree.stdout.trim() : undefined;
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }

  // Paths recorded in the given checkpoints; declared coverage knows no others.
  private async recordedPaths(...refs: string[]): Promise<string[]> {
    const paths = new Set<string>();
    for (const ref of refs) {
      const tree = await this.git("ls-tree", "-r", "-z", "--name-only", ref);
      if (tree.exitCode !== 0) {
        throw new Error(`Could not inspect checkpoint ${ref}: ${tree.stderr.trim()}`);
      }
      for (const path of nulSeparated(tree.stdout)) paths.add(path);
    }
    return [...paths];
  }

  private async head(): Promise<string | undefined> {
    const head = await this.git("rev-parse", "--verify", "--quiet", "HEAD");
    return head.exitCode === 0 ? head.stdout.trim() : undefined;
  }

  // Splits paths into those a full snapshot would record now and those it
  // would leave out, asking the user's repository about only these paths.
  // Undefined when a path cannot be classified (a directory, or Git refuses).
  private async resourceScope(
    paths: string[],
  ): Promise<{ recorded: string[]; dropped: string[] } | undefined> {
    const recorded: string[] = [];
    const dropped: string[] = [];
    const present: { path: string; size: number }[] = [];
    for (const path of paths) {
      const info = await lstat(join(this.root, path)).catch(() => undefined);
      if (!info) dropped.push(path);
      else if (info.isDirectory()) return undefined;
      else present.push({ path, size: info.size });
    }
    // Without a repository there are no ignore rules: whatever a tool names
    // inside the root is recorded, whatever its size.
    if (present.length === 0 || this.coverage === "declared") {
      return { recorded: [...recorded, ...present.map(({ path }) => path)], dropped };
    }

    const pathspecs = (list: { path: string }[]) => list.map(({ path }) => `:(literal)${path}`);
    const included = present.filter(({ path }) => this.isIncluded(path));
    const [tracked, untracked, ignored] = await Promise.all([
      this.workspaceGit(
        undefined,
        "ls-files",
        "-z",
        "--cached",
        "--stage",
        "--",
        ...pathspecs(present),
      ),
      this.workspaceGit(
        undefined,
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
        "--",
        ...pathspecs(present),
      ),
      included.length > 0
        ? this.workspaceGit(
            undefined,
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--",
            ...pathspecs(included),
          )
        : Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    ]);
    if ([tracked, untracked, ignored].some((result) => result.exitCode !== 0)) return undefined;
    const trackedPaths = new Map<string, boolean>();
    for (const record of nulSeparated(tracked.stdout)) {
      const tab = record.indexOf("\t");
      if (tab !== -1) trackedPaths.set(record.slice(tab + 1), record.startsWith(GITLINK_MODE));
    }
    const untrackedPaths = new Set(nulSeparated(untracked.stdout));
    const ignoredPaths = new Set(nulSeparated(ignored.stdout));
    for (const { path, size } of present) {
      const gitlink = trackedPaths.get(path);
      const keep =
        gitlink === false ||
        (gitlink === undefined &&
          ((untrackedPaths.has(path) &&
            (size <= MAXIMUM_UNTRACKED_FILE_BYTES || this.isIncluded(path))) ||
            ignoredPaths.has(path)));
      (keep ? recorded : dropped).push(path);
    }
    return { recorded, dropped };
  }

  // Files the workspace repository ignores, and large untracked files, are
  // outside checkpoints: restore neither brings them back nor removes them.
  // Checkpoints vanish when the store is deleted or rebuilt; say so instead of
  // surfacing Git's "bad object".
  private async requireCheckpoints(...refs: string[]): Promise<void> {
    for (const ref of refs) {
      const found = await this.git("cat-file", "-e", `${ref}^{commit}`);
      if (found.exitCode !== 0) {
        throw new Error(
          `checkpoint ${ref.slice(0, 12)} is no longer in ${this.shadowDir}; the store was deleted or rebuilt.`,
        );
      }
    }
  }

  async restore(ref: string): Promise<void> {
    if (this.coverage === "declared") {
      const paths = await this.locked(async () => {
        await this.ensure();
        await this.requireCheckpoints(ref);
        const head = await this.head();
        return this.recordedPaths(ref, ...(head ? [head] : []));
      });
      await this.restoreResources(ref, paths);
      return;
    }
    await this.locked(async () => {
      await this.ensure();
      await this.requireCheckpoints(ref);

      const readTree = await this.git("read-tree", "--reset", "-u", ref);
      if (readTree.exitCode !== 0) {
        throw new Error(`Could not restore checkpoint ${ref}: ${readTree.stderr.trim()}`);
      }
      const tree = await this.git("ls-tree", "-r", "-z", "--name-only", ref);
      if (tree.exitCode !== 0) {
        throw new Error(`Could not inspect checkpoint ${ref}: ${tree.stderr.trim()}`);
      }
      const kept = new Set(nulSeparated(tree.stdout));
      const created = [...((await this.workspacePaths()) ?? [])].filter((path) => !kept.has(path));
      await Promise.all(created.map((path) => rm(join(this.root, path), { force: true })));
      await this.removeEmptyParents(created);
    });
  }

  private async removeEmptyParents(paths: string[]): Promise<void> {
    const directories = new Set<string>();
    for (const path of paths) {
      for (let directory = dirname(path); directory !== "." && directory !== ""; ) {
        directories.add(directory);
        directory = dirname(directory);
      }
    }
    // Deepest first, so a parent is tried only after its children.
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      await rmdir(join(this.root, directory)).catch(() => {});
    }
  }

  async restoreResources(ref: string, resources: string[]): Promise<void> {
    await this.locked(async () => {
      await this.ensure();
      await this.requireCheckpoints(ref);
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
      await this.removeEmptyParents(missing);
    });
  }

  async diff(fromRef: string, toRef?: string): Promise<CheckpointDiffFile[]> {
    return this.locked(async () => {
      await this.ensure();
      await this.requireCheckpoints(fromRef, ...(toRef ? [toRef] : []));
      let target = toRef;
      if (!target && this.coverage === "declared") {
        const head = await this.head();
        target = await this.buildTree(
          fromRef,
          await this.recordedPaths(fromRef, ...(head ? [head] : [])),
        );
        if (!target) throw new Error("Could not record the current state for the diff.");
      }
      if (!target) await this.stage();
      const args = target
        ? ["diff", "--no-renames", "--numstat", "-z", fromRef, target]
        : ["diff", "--no-renames", "--cached", "--numstat", "-z", fromRef];
      const result = await this.git(...args);
      if (result.exitCode !== 0) {
        throw new Error(`Could not calculate checkpoint diff: ${result.stderr.trim()}`);
      }
      const files = parseNumstat(result.stdout);

      for (const file of files) {
        const patchArgs = target
          ? ["diff", "--no-renames", "--unified=3", fromRef, target, "--", file.path]
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
