import { accessSync, constants, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { errorResult, type ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { truncateOutput, withNotice } from "../truncate.ts";
import { resolveInRoot, type ToolDeps } from "./files.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".venv"]);
const MAX_MATCHES = 200;
const MAX_SCANNED_BYTES = 2_000_000;

export interface RipgrepRunResult {
  exitCode: number;
  stderr: string;
  stopped: boolean;
}

export type RipgrepRunner = (
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => boolean,
) => Promise<RipgrepRunResult | undefined>;

export interface SearchToolOptions {
  ripgrep?: RipgrepRunner | false;
}

function bundledRipgrepPath(execPath: string, platform: NodeJS.Platform): string | undefined {
  const name = platform === "win32" ? "rg.exe" : "rg";
  const path = resolve(dirname(execPath), "..", "mu-path", name);
  try {
    if (!statSync(path).isFile()) return undefined;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

const RIPGREP_PACKAGE_BY_PLATFORM: Partial<
  Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>
> = {
  darwin: { arm64: "@mu-agent/ripgrep-darwin-arm64" },
  linux: { x64: "@mu-agent/ripgrep-linux-x64" },
  win32: { x64: "@mu-agent/ripgrep-windows-x64" },
};

export function resolveNpmRipgrepExecutable(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
  from = process.argv[1] ? dirname(resolve(process.argv[1])) : process.cwd(),
  resolvePackage: (specifier: string, from: string) => string = (specifier, root) =>
    Bun.resolveSync(specifier, root),
): string | undefined {
  const packageName = RIPGREP_PACKAGE_BY_PLATFORM[platform]?.[architecture];
  if (!packageName) return undefined;
  try {
    const packageJson = resolvePackage(`${packageName}/package.json`, from);
    const name = platform === "win32" ? "rg.exe" : "rg";
    const path = resolve(dirname(packageJson), "vendor", name);
    if (!statSync(path).isFile()) return undefined;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

export function resolveRipgrepExecutable(
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
  which: (command: string) => string | null = (command) => Bun.which(command),
  resolveNpm: () => string | undefined = () => resolveNpmRipgrepExecutable(platform, process.arch),
): string | undefined {
  return bundledRipgrepPath(execPath, platform) ?? resolveNpm() ?? which("rg") ?? undefined;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => boolean,
  onStop: () => void,
): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (!onLine(line)) {
        onStop();
        await reader.cancel();
        return false;
      }
      newline = pending.indexOf("\n");
    }
  }

  pending += decoder.decode();
  const completed = pending.length === 0 || onLine(pending.replace(/\r$/, ""));
  if (!completed) onStop();
  return completed;
}

const defaultRipgrepRunner: RipgrepRunner = async (args, cwd, signal, onLine) => {
  signal.throwIfAborted();
  const executable = resolveRipgrepExecutable();
  if (!executable) return undefined;

  let process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    process = Bun.spawn([executable, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const stop = () => process.kill("SIGTERM");
  signal.addEventListener("abort", stop, { once: true });

  try {
    const [completed, stderr, exitCode] = await Promise.all([
      readLines(process.stdout, onLine, stop),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    signal.throwIfAborted();
    return { exitCode, stderr, stopped: !completed };
  } finally {
    signal.removeEventListener("abort", stop);
  }
};

function runner(options: SearchToolOptions): RipgrepRunner | undefined {
  return options.ripgrep === false ? undefined : (options.ripgrep ?? defaultRipgrepRunner);
}

function traversalArgs(): string[] {
  const args = ["--hidden", "--no-ignore", "--no-config", "--no-messages", "--sort", "path"];
  for (const name of SKIP_DIRS) {
    args.push(
      "--glob",
      `!${name}`,
      "--glob",
      `!${name}/**`,
      "--glob",
      `!**/${name}`,
      "--glob",
      `!**/${name}/**`,
    );
  }
  return args;
}

function isSkipped(path: string): boolean {
  return path.split(/[\\/]/).some((part) => SKIP_DIRS.has(part));
}

function displayPath(root: string, base: string, path: string): string {
  return relative(resolve(root), resolve(base, path.replace(/^\.[\\/]/, "")));
}

function usableRipgrepResult(result: RipgrepRunResult | undefined): boolean {
  return result !== undefined && (result.stopped || result.exitCode === 0 || result.exitCode === 1);
}

// Converts a glob to a RegExp. Supports **, * and ?.
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** crosses directory separators; **/ also matches zero directories.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
      // biome-ignore lint/suspicious/noTemplateCurlyInString: these are regex metacharacters to escape
    } else if (".+^${}()|[]\\".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

async function* walk(dir: string, signal: AbortSignal): AsyncGenerator<string> {
  signal.throwIfAborted();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    signal.throwIfAborted();
    if (SKIP_DIRS.has(name)) continue;
    const full = resolve(dir, name);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) yield* walk(full, signal);
    else yield full;
  }
}

async function ripgrepFiles(
  root: string,
  base: string,
  pattern: RegExp,
  signal: AbortSignal,
  run: RipgrepRunner | undefined,
): Promise<string[] | undefined> {
  if (!run) return undefined;
  const matches: string[] = [];
  const result = await run(["--files", ...traversalArgs()], base, signal, (line) => {
    if (!line || isSkipped(line)) return true;
    const normalized = line.replaceAll("\\", "/");
    if (pattern.test(normalized)) matches.push(displayPath(root, base, line));
    return matches.length < MAX_MATCHES;
  });
  return usableRipgrepResult(result) ? matches : undefined;
}

interface RipgrepMatch {
  type?: unknown;
  data?: {
    path?: { text?: unknown };
    lines?: { text?: unknown };
    line_number?: unknown;
  };
}

async function ripgrepMatches(
  root: string,
  base: string,
  pattern: string,
  include: RegExp | undefined,
  ignoreCase: boolean | undefined,
  signal: AbortSignal,
  run: RipgrepRunner | undefined,
): Promise<{ results: string[]; hitLimit: boolean } | undefined> {
  if (!run) return undefined;
  const results: string[] = [];
  const args = [
    "--json",
    "--engine",
    "auto",
    ...traversalArgs(),
    ...(ignoreCase ? ["--ignore-case"] : []),
    "--",
    pattern,
    ".",
  ];
  const result = await run(args, base, signal, (line) => {
    let event: RipgrepMatch;
    try {
      event = JSON.parse(line) as RipgrepMatch;
    } catch {
      return true;
    }
    if (event.type !== "match") return true;
    const path = event.data?.path?.text;
    const text = event.data?.lines?.text;
    const lineNumber = event.data?.line_number;
    if (typeof path !== "string" || typeof text !== "string" || typeof lineNumber !== "number") {
      return true;
    }
    const relativeToBase = path.replace(/^\.[\\/]/, "");
    if (isSkipped(relativeToBase)) return true;
    const normalized = relativeToBase.replaceAll("\\", "/");
    if (include && !include.test(normalized)) return true;
    results.push(`${displayPath(root, base, relativeToBase)}:${lineNumber}: ${text.trim()}`);
    return results.length < MAX_MATCHES;
  });
  if (!usableRipgrepResult(result)) return undefined;
  return { results, hitLimit: result?.stopped === true || results.length >= MAX_MATCHES };
}

export function globTool(deps: ToolDeps, options: SearchToolOptions = {}) {
  return tool({
    name: "glob",
    description:
      "Find files by glob pattern (e.g. 'src/**/*.ts'). Returns paths relative to the session root.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern, e.g. **/*.test.ts"),
      path: z.string().optional().describe("Directory to search; defaults to the session root"),
    }),
    isConcurrencySafe: () => true,
    execute: async ({ pattern, path }, { signal }): Promise<ToolResult | string> => {
      const base = resolveInRoot(deps.root, path ?? ".");
      const regex = globToRegExp(pattern);
      const accelerated = await ripgrepFiles(deps.root, base, regex, signal, runner(options));
      const matches: string[] = accelerated ?? [];

      if (!accelerated) {
        for await (const file of walk(base, signal)) {
          const rel = relative(base, file).replaceAll("\\", "/");
          if (regex.test(rel)) matches.push(relative(resolve(deps.root), file));
          if (matches.length >= MAX_MATCHES) break;
        }
      }

      if (matches.length === 0) return `No files matched ${pattern}`;
      return withNotice(
        truncateOutput(matches.join("\n")),
        `showing the first ${MAX_MATCHES} matches`,
      );
    },
  });
}

export function grepTool(deps: ToolDeps, options: SearchToolOptions = {}) {
  return tool({
    name: "grep",
    description:
      "Search file contents with a regular expression. Returns matching lines with file and line numbers for grounded path:line citations.",
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression to search for"),
      path: z.string().optional().describe("Directory to search; defaults to the session root"),
      include: z.string().optional().describe("Only search files matching this glob"),
      ignoreCase: z.boolean().optional(),
    }),
    isConcurrencySafe: () => true,
    execute: async (
      { pattern, path, include, ignoreCase },
      { signal },
    ): Promise<ToolResult | string> => {
      const base = resolveInRoot(deps.root, path ?? ".");
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, ignoreCase ? "i" : "");
      } catch (error) {
        return errorResult(
          `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const includeRegex = include ? globToRegExp(include) : undefined;
      const accelerated = await ripgrepMatches(
        deps.root,
        base,
        pattern,
        includeRegex,
        ignoreCase,
        signal,
        runner(options),
      );
      if (accelerated) return formatGrepResults(pattern, accelerated.results, accelerated.hitLimit);

      const results: string[] = [];
      let scanned = 0;
      let hitLimit = false;

      for await (const file of walk(base, signal)) {
        const rel = relative(base, file).replaceAll("\\", "/");
        if (includeRegex && !includeRegex.test(rel)) continue;

        let content: string;
        try {
          content = await readFile(file, "utf8");
        } catch {
          continue;
        }
        scanned += content.length;
        if (content.includes("\u0000")) continue;

        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          signal.throwIfAborted();
          const line = lines[i] as string;
          if (!regex.test(line)) continue;
          results.push(`${relative(resolve(deps.root), file)}:${i + 1}: ${line.trim()}`);
          if (results.length >= MAX_MATCHES) {
            hitLimit = true;
            break;
          }
        }
        if (hitLimit || scanned > MAX_SCANNED_BYTES) {
          hitLimit = hitLimit || scanned > MAX_SCANNED_BYTES;
          break;
        }
      }

      return formatGrepResults(pattern, results, hitLimit);
    },
  });
}

function formatGrepResults(pattern: string, results: string[], hitLimit: boolean): string {
  if (results.length === 0) return `No matches for ${pattern}`;
  const body = results.join("\n");
  return hitLimit
    ? `${body}\n\n[search stopped early — narrow the pattern or scope to see the rest]`
    : withNotice(truncateOutput(body), "many matches");
}
