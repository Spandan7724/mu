import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { errorResult, type ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { truncateOutput, withNotice } from "../truncate.ts";
import { resolveInRoot, type ToolDeps } from "./files.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".venv"]);
const MAX_MATCHES = 200;
const MAX_SCANNED_BYTES = 2_000_000;

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

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = resolve(dir, name);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) yield* walk(full, root);
    else yield full;
  }
}

export function globTool(deps: ToolDeps) {
  return tool({
    name: "glob",
    description:
      "Find files by glob pattern (e.g. 'src/**/*.ts'). Returns paths relative to the session root.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern, e.g. **/*.test.ts"),
      path: z.string().optional().describe("Directory to search; defaults to the session root"),
    }),
    isConcurrencySafe: () => true,
    execute: async ({ pattern, path }): Promise<ToolResult | string> => {
      const base = resolveInRoot(deps.root, path ?? ".");
      const regex = globToRegExp(pattern);
      const matches: string[] = [];

      for await (const file of walk(base, base)) {
        const rel = relative(base, file);
        if (regex.test(rel)) matches.push(relative(resolve(deps.root), file));
        if (matches.length >= MAX_MATCHES) break;
      }

      if (matches.length === 0) return `No files matched ${pattern}`;
      return withNotice(
        truncateOutput(matches.join("\n")),
        `showing the first ${MAX_MATCHES} matches`,
      );
    },
  });
}

export function grepTool(deps: ToolDeps) {
  return tool({
    name: "grep",
    description:
      "Search file contents with a regular expression. Returns matching lines with their file and line number.",
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression to search for"),
      path: z.string().optional().describe("Directory to search; defaults to the session root"),
      include: z.string().optional().describe("Only search files matching this glob"),
      ignoreCase: z.boolean().optional(),
    }),
    isConcurrencySafe: () => true,
    execute: async ({ pattern, path, include, ignoreCase }): Promise<ToolResult | string> => {
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

      const results: string[] = [];
      let scanned = 0;
      let hitLimit = false;

      for await (const file of walk(base, base)) {
        const rel = relative(base, file);
        if (includeRegex && !includeRegex.test(rel)) continue;

        let content: string;
        try {
          content = await readFile(file, "utf8");
        } catch {
          continue; // binary or unreadable
        }
        scanned += content.length;
        if (content.includes("\u0000")) continue; // binary file

        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
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

      if (results.length === 0) return `No matches for ${pattern}`;
      const body = results.join("\n");
      return hitLimit
        ? `${body}\n\n[search stopped early — narrow the pattern or scope to see the rest]`
        : withNotice(truncateOutput(body), "many matches");
    },
  });
}
