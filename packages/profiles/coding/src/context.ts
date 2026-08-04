import { createHash } from "node:crypto";
import { type Dirent, realpathSync } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type AgentMessage, customMessage } from "@mu/core";

export const DEFAULT_INSTRUCTION_MAX_BYTES = 32 * 1024;
export const DEFAULT_PROJECT_ROOT_MARKERS = [".git"];
export const DEFAULT_INSTRUCTION_FALLBACKS = [
  ".mu/AGENTS.md",
  "CLAUDE.local.md",
  "CLAUDE.md",
  "CLAUDE.MD",
  ".claude/CLAUDE.md",
];
export const INSTRUCTION_PRIMARY_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD"];

const SNAPSHOT_TYPE_PREFIX = "project-instructions-";
const MAX_IMPORT_DEPTH = 5;
const TEXT_EXTENSIONS = new Set([
  "",
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".html",
  ".css",
  ".scss",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".sql",
  ".graphql",
  ".proto",
  ".vue",
  ".svelte",
  ".astro",
  ".php",
  ".lua",
  ".r",
  ".R",
  ".dart",
  ".ex",
  ".exs",
  ".erl",
  ".clj",
  ".hs",
  ".ml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".lock",
  ".rst",
  ".adoc",
  ".org",
  ".tex",
  ".diff",
  ".patch",
]);

export interface InstructionSettings {
  enabled?: boolean;
  maxBytes?: number;
  fallbackFilenames?: string[];
  projectRootMarkers?: string[];
  imports?: boolean;
  claudeRules?: boolean;
}

export interface InstructionLoaderOptions extends InstructionSettings {
  root: string;
  home?: string;
  managedPaths?: string[];
}

export type InstructionScope = "managed" | "global" | "project" | "local" | "rule" | "import";

export interface InstructionSource {
  path: string;
  content: string;
  scope: InstructionScope;
  parent?: string;
  truncated?: boolean;
}

export interface InstructionDiagnostic {
  level: "warning";
  path?: string;
  message: string;
}

export interface InstructionSnapshot {
  enabled: boolean;
  projectRoot: string;
  sources: InstructionSource[];
  diagnostics: InstructionDiagnostic[];
  bytes: number;
  maxBytes: number;
  truncated: boolean;
  signature: string;
}

interface RuleCandidate {
  path: string;
  base: string;
  patterns?: string[];
}

interface LoadBudget {
  remaining: number;
  truncated: boolean;
}

interface LoadPass {
  budget: LoadBudget;
  processed: Set<string>;
  diagnostics: InstructionDiagnostic[];
  sources: InstructionSource[];
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function canonicalExisting(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function validRelativeFilename(name: string): boolean {
  if (!name || isAbsolute(name)) return false;
  const normalized = name.replaceAll("\\", "/");
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../");
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter(validRelativeFilename))];
}

function snapshotSignature(sources: InstructionSource[], enabled: boolean): string {
  const hash = createHash("sha256");
  hash.update(enabled ? "enabled\0" : "disabled\0");
  for (const source of sources) {
    hash.update(source.path);
    hash.update("\0");
    hash.update(source.scope);
    hash.update("\0");
    hash.update(source.parent ?? "");
    hash.update("\0");
    hash.update(source.content);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function readUtf8Prefix(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes) + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

function latestSnapshotSignature(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "custom" || !message.customType.startsWith(SNAPSHOT_TYPE_PREFIX)) {
      continue;
    }
    return message.customType.slice(SNAPSHOT_TYPE_PREFIX.length);
  }
  return undefined;
}

function renderSourcePath(source: InstructionSource, root: string): string {
  if (pathInside(root, source.path)) {
    const rel = relative(root, source.path);
    return rel || basename(source.path);
  }
  return source.path;
}

function snapshotMessage(snapshot: InstructionSnapshot, replacing: boolean): AgentMessage {
  const preamble = replacing
    ? "This is the complete current instruction snapshot. It supersedes every earlier project-instructions message in this conversation."
    : "Codebase and user instructions are shown below. Follow them carefully. Sources are ordered from lower to higher precedence; later instructions override conflicting earlier instructions.";
  const body =
    snapshot.sources.length === 0
      ? "No instruction files are currently active."
      : snapshot.sources
          .map((source) => {
            const qualifier =
              source.scope === "import" && source.parent
                ? `imported by ${renderSourcePath(
                    {
                      ...source,
                      path: source.parent,
                    },
                    snapshot.projectRoot,
                  )}`
                : `${source.scope} instructions`;
            return `Contents of ${renderSourcePath(source, snapshot.projectRoot)} (${qualifier}):\n\n${source.content.trim()}`;
          })
          .join("\n\n");
  return customMessage(`${SNAPSHOT_TYPE_PREFIX}${snapshot.signature}`, `${preamble}\n\n${body}`);
}

function stripFrontmatter(raw: string): { content: string; patterns?: string[] } {
  const normalized = raw.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { content: raw };
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return { content: raw };
  const header = normalized.slice(4, end);
  const content = normalized.slice(end + 5);
  const lines = header.split("\n");
  const patterns: string[] = [];
  let collecting = false;

  for (const line of lines) {
    const direct = line.match(/^paths?\s*:\s*(.*)$/i);
    if (direct) {
      collecting = true;
      const value = direct[1]?.trim() ?? "";
      if (value) {
        const unwrapped = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
        patterns.push(
          ...unwrapped
            .split(",")
            .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
            .filter(Boolean),
        );
      }
      continue;
    }
    if (!collecting) continue;
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item?.[1]) {
      patterns.push(item[1].replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (line.trim()) collecting = false;
  }

  return { content, ...(patterns.length > 0 ? { patterns } : {}) };
}

function globPattern(pattern: string): RegExp | undefined {
  let source = "";
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("!")) return undefined;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
    }
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return undefined;
  }
}

function ruleMatches(rule: RuleCandidate, target: string): boolean {
  if (!rule.patterns || rule.patterns.length === 0) return true;
  const rel = relative(rule.base, target).replaceAll("\\", "/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
  let matched = false;
  for (const raw of rule.patterns) {
    const negated = raw.startsWith("!");
    const regex = globPattern(negated ? raw.slice(1) : raw);
    if (regex?.test(rel)) matched = !negated;
  }
  return matched;
}

function extractImports(content: string): string[] {
  const paths = new Set<string>();
  let fence: "`" | "~" | undefined;
  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch?.[1]) {
      const kind = fenceMatch[1][0] as "`" | "~";
      fence = fence === kind ? undefined : (fence ?? kind);
      continue;
    }
    if (fence) continue;
    const prose = line
      .split(/(`[^`]*`)/g)
      .filter((part) => !part.startsWith("`"))
      .join(" ");
    const regex = /(?:^|\s)@((?:\\ |[^\s`])+)/g;
    for (const match of prose.matchAll(regex)) {
      let candidate = match[1]?.replace(/\\ /g, " ");
      if (!candidate) continue;
      candidate = candidate.replace(/[),.;:!?]+$/, "");
      const hash = candidate.indexOf("#");
      if (hash >= 0) candidate = candidate.slice(0, hash);
      if (candidate && !candidate.startsWith("@")) paths.add(candidate);
    }
  }
  return [...paths];
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

export class InstructionLoader {
  readonly root: string;
  readonly home: string;
  readonly settings: Required<InstructionSettings>;
  private readonly managedPaths: string[];
  private readonly settingDiagnostics: InstructionDiagnostic[];
  private current: InstructionSnapshot;
  private nestedSources = new Map<string, InstructionSource>();
  private nestedSerial: Promise<void> = Promise.resolve();
  private activeSessionId: string | undefined;

  constructor(options: InstructionLoaderOptions) {
    this.root = canonicalExisting(options.root);
    this.home = canonicalExisting(options.home ?? homedir());
    const settingDiagnostics: InstructionDiagnostic[] = [];
    const booleanSetting = (value: unknown, fallback: boolean, name: string): boolean => {
      if (value === undefined) return fallback;
      if (typeof value === "boolean") return value;
      settingDiagnostics.push({
        level: "warning",
        message: `instructions.${name} must be a boolean; using ${fallback}`,
      });
      return fallback;
    };
    const filenameSetting = (value: unknown, fallback: string[], name: string): string[] => {
      if (value === undefined) return fallback;
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        settingDiagnostics.push({
          level: "warning",
          message: `instructions.${name} must be an array of relative filenames; using defaults`,
        });
        return fallback;
      }
      const valid = uniqueNames(value);
      if (valid.length !== value.length) {
        settingDiagnostics.push({
          level: "warning",
          message: `instructions.${name} ignored unsafe or duplicate entries`,
        });
      }
      return valid;
    };
    const validMaxBytes = Number.isSafeInteger(options.maxBytes) && (options.maxBytes ?? 0) >= 0;
    const maxBytes = validMaxBytes ? (options.maxBytes as number) : DEFAULT_INSTRUCTION_MAX_BYTES;
    if (options.maxBytes !== undefined && !validMaxBytes) {
      settingDiagnostics.push({
        level: "warning",
        message: `instructions.maxBytes must be a non-negative safe integer; using ${DEFAULT_INSTRUCTION_MAX_BYTES}`,
      });
    }
    this.settings = {
      enabled: booleanSetting(options.enabled, true, "enabled"),
      maxBytes,
      fallbackFilenames: filenameSetting(
        options.fallbackFilenames,
        DEFAULT_INSTRUCTION_FALLBACKS,
        "fallbackFilenames",
      ),
      projectRootMarkers: filenameSetting(
        options.projectRootMarkers,
        DEFAULT_PROJECT_ROOT_MARKERS,
        "projectRootMarkers",
      ),
      imports: booleanSetting(options.imports, true, "imports"),
      claudeRules: booleanSetting(options.claudeRules, true, "claudeRules"),
    };
    this.settingDiagnostics = settingDiagnostics;
    const defaultManaged =
      process.platform === "win32"
        ? process.env.PROGRAMDATA
          ? [join(process.env.PROGRAMDATA, "mu", "AGENTS.md")]
          : []
        : ["/etc/mu/AGENTS.md"];
    this.managedPaths = (options.managedPaths ?? defaultManaged).map((path) => resolve(path));
    this.current = {
      enabled: this.settings.enabled,
      projectRoot: this.root,
      sources: [],
      diagnostics: [],
      bytes: 0,
      maxBytes: this.settings.maxBytes,
      truncated: false,
      signature: snapshotSignature([], this.settings.enabled),
    };
  }

  get snapshot(): InstructionSnapshot {
    return {
      ...this.current,
      sources: this.current.sources.map((source) => ({ ...source })),
      diagnostics: this.current.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
  }

  async reload(options: { resetNested?: boolean } = {}): Promise<InstructionSnapshot> {
    if (options.resetNested) this.nestedSources.clear();
    const diagnostics: InstructionDiagnostic[] = this.settingDiagnostics.map((item) => ({
      ...item,
    }));
    const projectRoot = await this.findProjectRoot(diagnostics);
    if (!this.settings.enabled || this.settings.maxBytes === 0) {
      this.current = {
        enabled: false,
        projectRoot,
        sources: [],
        diagnostics,
        bytes: 0,
        maxBytes: this.settings.maxBytes,
        truncated: false,
        signature: snapshotSignature([], false),
      };
      return this.snapshot;
    }

    const pass: LoadPass = {
      budget: { remaining: this.settings.maxBytes, truncated: false },
      processed: new Set(),
      diagnostics,
      sources: [],
    };

    for (const path of this.managedPaths) {
      await this.loadSource(path, "managed", pass, undefined, dirname(path), 0);
    }

    const global = await this.firstReadableCandidate(
      [
        join(this.home, ".mu", "AGENTS.override.md"),
        join(this.home, ".mu", "AGENTS.md"),
        join(this.home, ".mu", "AGENTS.MD"),
        join(this.home, ".claude", "CLAUDE.md"),
      ],
      diagnostics,
    );
    if (global) await this.loadSource(global, "global", pass, undefined, this.home, 0);

    const dirs = this.dirsBetween(projectRoot, this.root);
    for (const dir of dirs) {
      for (const rule of await this.rulesForDirectory(dir, diagnostics)) {
        if (!rule.patterns) {
          await this.loadSource(rule.path, "rule", pass, undefined, projectRoot, 0);
        }
      }
      const primary = await this.primaryForDirectory(dir, diagnostics);
      if (primary) {
        const scope: InstructionScope =
          basename(primary) === "CLAUDE.local.md" ? "local" : "project";
        await this.loadSource(primary, scope, pass, undefined, projectRoot, 0);
      }
    }

    const bytes = this.settings.maxBytes - pass.budget.remaining;
    this.current = {
      enabled: true,
      projectRoot,
      sources: pass.sources,
      diagnostics,
      bytes,
      maxBytes: this.settings.maxBytes,
      truncated: pass.budget.truncated,
      signature: snapshotSignature(pass.sources, true),
    };
    return this.snapshot;
  }

  async refreshedMessages(existing: AgentMessage[], sessionId?: string): Promise<AgentMessage[]> {
    const previous = latestSnapshotSignature(existing);
    if (sessionId !== undefined && sessionId !== this.activeSessionId) {
      this.activeSessionId = sessionId;
      this.nestedSources.clear();
    } else if (sessionId === undefined && existing.length === 0) {
      this.nestedSources.clear();
    }
    const snapshot = await this.reload();
    if (snapshot.sources.length === 0 && previous === undefined) return [];
    if (previous === snapshot.signature) return [];
    return [snapshotMessage(snapshot, previous !== undefined)];
  }

  async instructionsForPath(targetPath: string): Promise<{
    text: string;
    sources: string[];
  }> {
    let result = { text: "", sources: [] as string[] };
    const previous = this.nestedSerial;
    let release: (() => void) | undefined;
    this.nestedSerial = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      result = await this.loadNested(targetPath);
    } finally {
      release?.();
    }
    return result;
  }

  formatStatus(prefix = "instructions"): string {
    if (!this.current.enabled) {
      return `${prefix} disabled\n  Use project/user config or remove --no-instructions to enable loading.`;
    }
    const sources = [...this.current.sources, ...this.nestedSources.values()];
    const truncated = this.current.truncated || sources.some((source) => source.truncated);
    const bytes =
      this.current.bytes +
      [...this.nestedSources.values()].reduce(
        (sum, source) => sum + Buffer.byteLength(source.content),
        0,
      );
    const lines = [
      `${prefix} · ${sources.length} file${sources.length === 1 ? "" : "s"} · ${formatBytes(
        bytes,
      )}/${formatBytes(this.current.maxBytes)}${truncated ? " · truncated" : ""}`,
      ...sources.map((source) => {
        const suffix = source.truncated ? " · truncated" : "";
        return `  ${source.scope.padEnd(7)} ${renderSourcePath(source, this.current.projectRoot)}${suffix}`;
      }),
    ];
    if (sources.length === 0) lines.push("  no instruction files found");
    if (this.current.diagnostics.length > 0) {
      lines.push(
        "warnings:",
        ...this.current.diagnostics.map(
          (diagnostic) => `  ${diagnostic.path ? `${diagnostic.path}: ` : ""}${diagnostic.message}`,
        ),
      );
    }
    lines.push(
      "precedence: managed < global < outer project < inner project; AGENTS.override.md wins within one directory",
    );
    return lines.join("\n");
  }

  async discoverPrimaryFiles(stopAt?: string): Promise<string[]> {
    const diagnostics: InstructionDiagnostic[] = [];
    const outer = stopAt ? resolve(stopAt) : await this.findProjectRoot(diagnostics);
    const files: string[] = [];
    for (const dir of this.dirsBetween(outer, this.root)) {
      const found = await this.primaryForDirectory(dir, diagnostics);
      if (found) files.push(found);
    }
    return files;
  }

  private async findProjectRoot(diagnostics: InstructionDiagnostic[]): Promise<string> {
    if (this.settings.projectRootMarkers.length === 0) return this.root;
    let current = this.root;
    for (;;) {
      for (const marker of this.settings.projectRootMarkers) {
        const candidate = join(current, marker);
        try {
          await stat(candidate);
          return current;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") {
            diagnostics.push({
              level: "warning",
              path: candidate,
              message: `could not inspect project-root marker: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
        }
      }
      const parent = dirname(current);
      if (parent === current) return this.root;
      current = parent;
    }
  }

  private dirsBetween(outer: string, inner: string): string[] {
    if (!pathInside(outer, inner)) return [inner];
    const dirs: string[] = [];
    let current = inner;
    for (;;) {
      dirs.push(current);
      if (current === outer) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return dirs.reverse();
  }

  private async primaryForDirectory(
    dir: string,
    diagnostics: InstructionDiagnostic[],
  ): Promise<string | undefined> {
    return this.firstReadableCandidate(
      [
        ...INSTRUCTION_PRIMARY_NAMES.map((name) => join(dir, name)),
        ...this.settings.fallbackFilenames.map((name) => join(dir, name)),
      ],
      diagnostics,
    );
  }

  private async firstReadableCandidate(
    candidates: string[],
    diagnostics: InstructionDiagnostic[],
  ): Promise<string | undefined> {
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (info.isFile()) return candidate;
        diagnostics.push({
          level: "warning",
          path: candidate,
          message: "instruction candidate is not a file",
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        diagnostics.push({
          level: "warning",
          path: candidate,
          message: `could not inspect instruction file: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    return undefined;
  }

  private async ruleFiles(dir: string, diagnostics: InstructionDiagnostic[]): Promise<string[]> {
    const files: string[] = [];
    const visit = async (current: string, seen: Set<string>): Promise<void> => {
      let canonical: string;
      try {
        canonical = await realpath(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return;
        diagnostics.push({
          level: "warning",
          path: current,
          message: `could not read rules directory: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return;
      }
      if (seen.has(canonical)) return;
      seen.add(canonical);
      let entries: Dirent<string>[];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        diagnostics.push({
          level: "warning",
          path: current,
          message: `could not list rules directory: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(current, entry.name);
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const target = await stat(path);
            isDirectory = target.isDirectory();
            isFile = target.isFile();
          } catch (error) {
            diagnostics.push({
              level: "warning",
              path,
              message: `could not inspect rule symlink: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
            continue;
          }
        }
        if (isDirectory) await visit(path, seen);
        else if (isFile && entry.name.toLowerCase().endsWith(".md")) files.push(path);
      }
    };
    await visit(dir, new Set());
    return files;
  }

  private async rulesForDirectory(
    dir: string,
    diagnostics: InstructionDiagnostic[],
  ): Promise<RuleCandidate[]> {
    const roots = [join(dir, ".mu", "rules")];
    if (this.settings.claudeRules) roots.push(join(dir, ".claude", "rules"));
    const rules: RuleCandidate[] = [];
    for (const root of roots) {
      for (const path of await this.ruleFiles(root, diagnostics)) {
        try {
          const parsed = stripFrontmatter(
            await readUtf8Prefix(path, DEFAULT_INSTRUCTION_MAX_BYTES),
          );
          rules.push({
            path,
            base: dir,
            ...(parsed.patterns ? { patterns: parsed.patterns } : {}),
          });
        } catch (error) {
          diagnostics.push({
            level: "warning",
            path,
            message: `could not read rule frontmatter: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }
    }
    return rules;
  }

  private async loadSource(
    path: string,
    scope: InstructionScope,
    pass: LoadPass,
    parent: string | undefined,
    allowedRoot: string,
    depth: number,
  ): Promise<void> {
    if (pass.budget.remaining <= 0) {
      pass.budget.truncated = true;
      return;
    }
    if (depth > MAX_IMPORT_DEPTH) {
      pass.diagnostics.push({
        level: "warning",
        path,
        message: `import depth exceeds ${MAX_IMPORT_DEPTH}`,
      });
      return;
    }
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (parent || (code !== "ENOENT" && code !== "ENOTDIR")) {
        pass.diagnostics.push({
          level: "warning",
          path,
          message:
            code === "ENOENT"
              ? `import referenced by ${parent} does not exist`
              : `could not resolve instruction file: ${
                  error instanceof Error ? error.message : String(error)
                }`,
        });
      }
      return;
    }
    if (pass.processed.has(canonical)) return;
    if (!pathInside(allowedRoot, canonical)) {
      pass.diagnostics.push({
        level: "warning",
        path,
        message: `external import is outside the allowed instruction root ${allowedRoot}`,
      });
      return;
    }
    if (!TEXT_EXTENSIONS.has(extname(canonical))) {
      pass.diagnostics.push({
        level: "warning",
        path,
        message: "skipped non-text instruction import",
      });
      return;
    }
    pass.processed.add(canonical);

    let raw: string;
    try {
      raw = await readUtf8Prefix(canonical, pass.budget.remaining);
    } catch (error) {
      pass.diagnostics.push({
        level: "warning",
        path,
        message: `could not read instruction file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }
    if (raw.includes("\0")) {
      pass.diagnostics.push({ level: "warning", path, message: "skipped binary instruction file" });
      return;
    }
    const parsed = stripFrontmatter(raw);
    const trimmed = parsed.content.trim();
    let source: InstructionSource | undefined;
    if (trimmed && pass.budget.remaining > 0) {
      const data = Buffer.from(trimmed);
      const taken = Math.min(data.byteLength, pass.budget.remaining);
      const content = data
        .subarray(0, taken)
        .toString("utf8")
        .replace(/\uFFFD$/, "");
      const truncated = taken < data.byteLength;
      source = {
        path: canonical,
        content,
        scope,
        ...(parent ? { parent } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
      pass.budget.remaining -= taken;
      if (truncated) {
        pass.budget.truncated = true;
        pass.diagnostics.push({
          level: "warning",
          path: canonical,
          message: `instruction content was truncated at the ${formatBytes(
            this.settings.maxBytes,
          )} total budget`,
        });
      }
    }

    if (this.settings.imports) {
      for (const imported of extractImports(parsed.content)) {
        const expanded = imported.startsWith("~/")
          ? join(this.home, imported.slice(2))
          : isAbsolute(imported)
            ? imported
            : resolve(dirname(canonical), imported);
        await this.loadSource(
          expanded,
          "import",
          pass,
          canonical,
          scope === "global" ? this.home : allowedRoot,
          depth + 1,
        );
      }
    }
    if (source) pass.sources.push(source);
  }

  private async loadNested(targetPath: string): Promise<{ text: string; sources: string[] }> {
    if (!this.settings.enabled) return { text: "", sources: [] };
    const absolute = resolve(targetPath);
    if (!pathInside(this.root, absolute)) return { text: "", sources: [] };
    const targetDir = dirname(absolute);
    const projectRoot = this.current.projectRoot;
    const diagnostics = this.current.diagnostics;
    const candidates: { path: string; scope: InstructionScope; allowedRoot: string }[] = [];

    for (const dir of this.dirsBetween(projectRoot, targetDir)) {
      for (const rule of await this.rulesForDirectory(dir, diagnostics)) {
        if (resolve(rule.path) !== absolute && ruleMatches(rule, absolute)) {
          candidates.push({ path: rule.path, scope: "rule", allowedRoot: projectRoot });
        }
      }
      if (pathInside(this.root, dir) && dir !== this.root) {
        const primary = await this.primaryForDirectory(dir, diagnostics);
        if (primary && resolve(primary) !== absolute) {
          candidates.push({
            path: primary,
            scope: basename(primary) === "CLAUDE.local.md" ? "local" : "project",
            allowedRoot: projectRoot,
          });
        }
      }
    }

    const remaining =
      this.settings.maxBytes -
      this.current.bytes -
      [...this.nestedSources.values()].reduce(
        (sum, source) => sum + Buffer.byteLength(source.content),
        0,
      );
    const known = new Set([
      ...this.current.sources.map((source) => canonicalExisting(source.path)),
      ...this.nestedSources.keys(),
    ]);
    const firstUnseen = candidates.find(
      (candidate) => !known.has(canonicalExisting(candidate.path)),
    );
    if (remaining <= 0 && firstUnseen) {
      this.current.truncated = true;
      if (
        !diagnostics.some(
          (item) =>
            item.path === firstUnseen.path &&
            item.message ===
              "nested instruction omitted because the total byte budget is exhausted",
        )
      ) {
        diagnostics.push({
          level: "warning",
          path: firstUnseen.path,
          message: "nested instruction omitted because the total byte budget is exhausted",
        });
      }
      return { text: "", sources: [] };
    }
    const pass: LoadPass = {
      budget: { remaining: Math.max(0, remaining), truncated: false },
      processed: known,
      diagnostics,
      sources: [],
    };
    for (const candidate of candidates) {
      await this.loadSource(
        candidate.path,
        candidate.scope,
        pass,
        undefined,
        candidate.allowedRoot,
        0,
      );
    }
    for (const source of pass.sources) {
      this.nestedSources.set(resolve(source.path), source);
    }
    if (pass.sources.length === 0) return { text: "", sources: [] };
    const text = [
      "<system-reminder>",
      "Additional instructions apply to the file just read. Later sources have higher precedence:",
      "",
      ...pass.sources.flatMap((source) => [
        `Contents of ${renderSourcePath(source, projectRoot)}:`,
        source.content.trim(),
        "",
      ]),
      "</system-reminder>",
    ].join("\n");
    return { text, sources: pass.sources.map((source) => source.path) };
  }
}

// Compatibility helper retained for SDK users. It now follows filename
// precedence and stops at the supplied ceiling.
export async function discoverContextFiles(root: string, stopAt?: string): Promise<string[]> {
  return new InstructionLoader({ root }).discoverPrimaryFiles(stopAt);
}

export async function contextMessages(root: string): Promise<AgentMessage[]> {
  const loader = new InstructionLoader({ root });
  return loader.refreshedMessages([]);
}

async function gitOutput(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
    const text = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export async function codingEnvironment(root: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    directory: resolve(root),
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
  };

  const branchOutput = await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const branch = branchOutput?.trim().split(/\r?\n/)[0];
  if (branch) {
    env.branch = branch;
    const status = await gitOutput(["status", "--porcelain"], root);
    if (status !== undefined) {
      env.uncommittedFiles = String(status.split(/\r?\n/).filter(Boolean).length);
    }
  }

  try {
    const entries = await readdir(root);
    env.topLevelEntries = entries
      .filter((name) => !name.startsWith("."))
      .sort()
      .slice(0, 40)
      .join(", ");
  } catch {
    // Environment facts are best-effort; instruction reads report diagnostics.
  }

  return env;
}

export function environmentMessage(env: Record<string, string>): AgentMessage {
  const lines = Object.entries(env).map(([key, value]) => `${key}: ${value}`);
  return customMessage("environment", `Session environment:\n${lines.join("\n")}`);
}
