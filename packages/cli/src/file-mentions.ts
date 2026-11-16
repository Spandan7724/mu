import { type Dirent, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface MentionItem {
  label: string;
}

export interface FileMentionOptions {
  root: string;
  // ripgrep executable; without one the index comes from a directory walk.
  ripgrep?: string | undefined;
  // Called when a rebuilt index lands, so an open popup can re-query.
  onReady?: () => void;
  limit?: number;
  maxFiles?: number;
}

// Never worth mentioning, and often present without an ignore file to say so.
const JUNK_DIRS = [
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "target",
];
const JUNK_EXTENSIONS = [".pyc", ".pyo", ".o", ".class"];
const JUNK_DIR_SET = new Set(JUNK_DIRS);

function isJunkFile(name: string): boolean {
  return JUNK_EXTENSIONS.some((extension) => name.endsWith(extension));
}

interface IndexedPath {
  path: string;
  lower: string;
  base: number;
}

function indexPaths(paths: string[]): IndexedPath[] {
  const depth = (path: string) => {
    let count = 0;
    for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) count++;
    return count;
  };
  return paths
    .map((path) => ({ path, depth: depth(path) }))
    .sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path }) => ({ path, lower: path.toLowerCase(), base: path.lastIndexOf("/") + 1 }));
}

export function ripgrepFileArgs(): string[] {
  return [
    "--files",
    "--no-config",
    "--no-require-git",
    "--path-separator",
    "/",
    ...JUNK_DIRS.map((name) => `--glob=!${name}/`),
    ...JUNK_EXTENSIONS.map((extension) => `--glob=!*${extension}`),
  ];
}

async function listWithRipgrep(ripgrep: string, root: string, maxFiles: number): Promise<string[]> {
  const proc = Bun.spawn([ripgrep, ...ripgrepFileArgs()], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const paths: string[] = [];
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of proc.stdout) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (line) paths.push(line);
    if (paths.length >= maxFiles) {
      proc.kill();
      break;
    }
  }
  if (rest && paths.length < maxFiles) paths.push(rest);
  await proc.exited;
  return paths.slice(0, maxFiles);
}

// Breadth-first so a capped walk still holds the shallow files.
async function listWithWalk(root: string, maxFiles: number): Promise<string[]> {
  const paths: string[] = [];
  let level = [""];
  while (level.length > 0 && paths.length < maxFiles) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: Dirent[];
      try {
        entries = await readdir(join(root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!JUNK_DIR_SET.has(entry.name)) next.push(path);
        } else if (!isJunkFile(entry.name)) {
          paths.push(path);
          if (paths.length >= maxFiles) break;
        }
      }
      if (paths.length >= maxFiles) break;
    }
    level = next;
  }
  return paths;
}

// Candidates for the `@` popup. A query with a `/` lists that folder as it is on
// disk (ignored files and dotfiles included); any other query searches a cached
// index of the files ignore rules allow, rebuilt in the background whenever the
// popup opens.
export class FileMentions {
  private readonly root: string;
  private readonly ripgrep: string | undefined;
  private readonly onReady: (() => void) | undefined;
  private readonly limit: number;
  private readonly maxFiles: number;
  private index: IndexedPath[] | undefined;
  private building: Promise<void> | undefined;
  private readonly folders = new Map<string, Dirent[] | undefined>();

  constructor(options: FileMentionOptions) {
    this.root = options.root;
    this.ripgrep = options.ripgrep;
    this.onReady = options.onReady;
    this.limit = options.limit ?? 50;
    this.maxFiles = options.maxFiles ?? 100_000;
  }

  query(query: string): MentionItem[] {
    if (query === "") this.refresh();
    const slash = query.lastIndexOf("/");
    if (slash >= 0) return this.folderItems(query.slice(0, slash + 1), query.slice(slash + 1));
    if (!this.index) return this.folderItems("", query, true);
    return this.search(query);
  }

  refresh(): Promise<void> {
    this.folders.clear();
    if (this.building) return this.building;
    const list = this.ripgrep
      ? listWithRipgrep(this.ripgrep, this.root, this.maxFiles).catch(() =>
          listWithWalk(this.root, this.maxFiles),
        )
      : listWithWalk(this.root, this.maxFiles);
    this.building = list
      .then((paths) => {
        this.index = indexPaths(paths);
        this.onReady?.();
      })
      .catch(() => {})
      .finally(() => {
        this.building = undefined;
      });
    return this.building;
  }

  private search(query: string): MentionItem[] {
    const index = this.index ?? [];
    if (query === "") return index.slice(0, this.limit).map(({ path }) => ({ label: path }));
    const needle = query.toLowerCase();
    const namePrefix: IndexedPath[] = [];
    const nameMatch: IndexedPath[] = [];
    const pathMatch: IndexedPath[] = [];
    for (const entry of index) {
      const at = entry.lower.indexOf(needle);
      if (at < 0) continue;
      if (at === entry.base) {
        namePrefix.push(entry);
        if (namePrefix.length >= this.limit) break;
      } else if (entry.lower.indexOf(needle, entry.base) >= 0) {
        if (nameMatch.length < this.limit) nameMatch.push(entry);
      } else if (pathMatch.length < this.limit) {
        pathMatch.push(entry);
      }
    }
    return [...namePrefix, ...nameMatch, ...pathMatch]
      .slice(0, this.limit)
      .map(({ path }) => ({ label: path }));
  }

  private folderItems(folder: string, partial: string, filtered = false): MentionItem[] {
    let entries = this.folders.get(folder);
    if (!this.folders.has(folder)) {
      const path = isAbsolute(folder) ? folder : resolve(this.root, folder || ".");
      try {
        entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
      } catch {
        entries = undefined;
      }
      this.folders.set(folder, entries);
    }
    if (!entries) return [];
    const needle = partial.toLowerCase();
    const prefix: MentionItem[] = [];
    const contains: MentionItem[] = [];
    for (const entry of entries) {
      const directory = entry.isDirectory();
      if (filtered) {
        if (entry.name.startsWith(".")) continue;
        if (directory ? JUNK_DIR_SET.has(entry.name) : isJunkFile(entry.name)) continue;
      }
      const name = entry.name.toLowerCase();
      const at = needle ? name.indexOf(needle) : 0;
      if (at < 0) continue;
      const item = { label: `${folder}${entry.name}${directory ? "/" : ""}` };
      (at === 0 ? prefix : contains).push(item);
      if (prefix.length >= this.limit) break;
    }
    return [...prefix, ...contains].slice(0, this.limit);
  }
}
