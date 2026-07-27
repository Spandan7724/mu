import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type CheckpointDiffFile, errorResult, type ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import type { FileState } from "../state.ts";
import { truncateOutput, withNotice } from "../truncate.ts";

export interface ToolDeps {
  root: string;
  state: FileState;
}

// Every path is resolved against the session root and must stay inside it.
export function resolveInRoot(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (rel.startsWith("..")) {
    throw new Error(`Path escapes the session root: ${path}`);
  }
  return absolute;
}

function display(root: string, path: string): string {
  const rel = relative(resolve(root), path);
  return rel === "" ? "." : rel;
}

function previewLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function filePermissionDiff(
  path: string,
  before: string | undefined,
  after: string,
): CheckpointDiffFile {
  const oldLines = before === undefined ? [] : previewLines(before);
  const newLines = previewLines(after);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = oldLines.length - prefix - suffix;
  const added = newLines.length - prefix - suffix;
  if (added === 0 && removed === 0) return { path, added, removed, hunks: [] };

  const contextBefore = Math.min(3, prefix);
  const contextAfter = Math.min(3, suffix);
  const oldStart = prefix - contextBefore;
  const newStart = prefix - contextBefore;
  const oldCount = contextBefore + removed + contextAfter;
  const newCount = contextBefore + added + contextAfter;
  const hunks = [
    `@@ -${oldLines.length === 0 ? 0 : oldStart + 1},${oldCount} +${newLines.length === 0 ? 0 : newStart + 1},${newCount} @@`,
    ...oldLines.slice(oldStart, prefix).map((line) => ` ${line}`),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`),
    ...newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`),
    ...newLines
      .slice(newLines.length - suffix, newLines.length - suffix + contextAfter)
      .map((line) => ` ${line}`),
  ];
  return { path, added, removed, hunks };
}

export function readTool(deps: ToolDeps) {
  return tool({
    name: "read",
    description:
      "Read a file from the filesystem. Returns contents with line numbers for grounded path:line citations. Read a file before editing it.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file, absolute or relative to the session root"),
      offset: z.number().int().min(1).optional().describe("First line to read (1-based)"),
      limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
    }),
    isConcurrencySafe: () => true,
    execute: async ({ path, offset, limit }): Promise<ToolResult | string> => {
      const absolute = resolveInRoot(deps.root, path);
      let content: string;
      try {
        content = await readFile(absolute, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT")
          return errorResult(`File not found: ${display(deps.root, absolute)}`);
        if (code === "EISDIR") {
          return errorResult(`${display(deps.root, absolute)} is a directory — use ls instead.`);
        }
        throw error;
      }

      deps.state.markRead(absolute);
      const allLines = content.split("\n");
      const start = (offset ?? 1) - 1;
      const slice = allLines.slice(start, limit ? start + limit : undefined);
      const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(5)}  ${line}`);
      const body = withNotice(truncateOutput(numbered.join("\n")), "file is large");

      return {
        content: [{ type: "text", text: body || "(empty file)" }],
        details: { path: absolute, lines: allLines.length },
      };
    },
  });
}

export function writeTool(deps: ToolDeps) {
  return tool({
    name: "write",
    changesState: true,
    description:
      "Write a complete file, creating it or replacing its contents. To change part of an existing file, prefer edit.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file"),
      content: z.string().describe("The complete file contents"),
    }),
    permissionDetails: async ({ path, content }) => {
      const absolute = resolveInRoot(deps.root, path);
      let before: string | undefined;
      try {
        before = await readFile(absolute, "utf8");
      } catch {
        before = undefined;
      }
      const relativePath = display(deps.root, absolute);
      return {
        description: `${before === undefined ? "Create" : "Overwrite"} ${relativePath}`,
        preview: {
          kind: "diff",
          file: filePermissionDiff(relativePath, before, content),
        },
      };
    },
    execute: async ({ path, content }): Promise<ToolResult | string> => {
      const absolute = resolveInRoot(deps.root, path);
      let exists = true;
      try {
        await stat(absolute);
      } catch {
        exists = false;
      }

      // Read-before-write: overwriting a file the agent has not looked at is
      // how unrelated work gets silently destroyed.
      if (exists && !deps.state.hasRead(absolute)) {
        return errorResult(
          `Refusing to overwrite ${display(deps.root, absolute)} because it has not been read in this session. Read it first, then write.`,
        );
      }
      if (exists && deps.state.isStale(absolute)) {
        return errorResult(
          `${display(deps.root, absolute)} changed on disk since you read it. Read it again before writing.`,
        );
      }

      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
      deps.state.markWritten(absolute);

      const lines = content.split("\n").length;
      return {
        content: [
          {
            type: "text",
            text: `${exists ? "Updated" : "Created"} ${display(deps.root, absolute)} (${lines} lines)`,
          },
        ],
        details: { path: absolute, created: !exists },
      };
    },
  });
}

export function editTool(deps: ToolDeps) {
  return tool({
    name: "edit",
    changesState: true,
    description:
      "Replace an exact string in a file. The old string must appear exactly once unless replaceAll is set. Read the file first.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file"),
      oldString: z.string().describe("Exact text to replace, including indentation"),
      newString: z.string().describe("Replacement text"),
      replaceAll: z.boolean().optional().describe("Replace every occurrence"),
    }),
    permissionDetails: async ({ path, oldString, newString, replaceAll }) => {
      const absolute = resolveInRoot(deps.root, path);
      const relativePath = display(deps.root, absolute);
      let content: string;
      try {
        content = await readFile(absolute, "utf8");
      } catch {
        return { description: `Edit ${relativePath}` };
      }
      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);
      return {
        description: `Edit ${relativePath}`,
        preview: {
          kind: "diff",
          file: filePermissionDiff(relativePath, content, updated),
        },
      };
    },
    execute: async ({ path, oldString, newString, replaceAll }): Promise<ToolResult | string> => {
      const absolute = resolveInRoot(deps.root, path);

      if (!deps.state.hasRead(absolute)) {
        return errorResult(
          `Read ${display(deps.root, absolute)} before editing it, so you can see what you are changing.`,
        );
      }
      if (oldString === newString) {
        return errorResult("oldString and newString are identical — nothing to do.");
      }

      let content: string;
      try {
        content = await readFile(absolute, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return errorResult(`File not found: ${display(deps.root, absolute)}`);
        }
        throw error;
      }

      if (deps.state.isStale(absolute)) {
        return errorResult(
          `${display(deps.root, absolute)} changed on disk since you read it. Read it again before editing.`,
        );
      }

      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        return errorResult(
          `oldString was not found in ${display(deps.root, absolute)}. The text must match exactly, including whitespace and indentation.`,
        );
      }
      if (occurrences > 1 && !replaceAll) {
        return errorResult(
          `oldString appears ${occurrences} times in ${display(deps.root, absolute)}. Include more surrounding context to make it unique, or set replaceAll.`,
        );
      }

      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);
      await writeFile(absolute, updated, "utf8");
      deps.state.markWritten(absolute);

      return {
        content: [
          {
            type: "text",
            text: `Edited ${display(deps.root, absolute)} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`,
          },
        ],
        details: { path: absolute, occurrences, oldString, newString },
      };
    },
  });
}

export function lsTool(deps: ToolDeps) {
  return tool({
    name: "ls",
    description: "List the entries of a directory.",
    inputSchema: z.object({
      path: z.string().optional().describe("Directory to list; defaults to the session root"),
    }),
    isConcurrencySafe: () => true,
    execute: async ({ path }): Promise<ToolResult | string> => {
      const absolute = resolveInRoot(deps.root, path ?? ".");
      let entries: string[];
      try {
        entries = await readdir(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return errorResult(`Directory not found: ${display(deps.root, absolute)}`);
        }
        throw error;
      }

      const described = await Promise.all(
        entries.sort().map(async (name) => {
          try {
            const info = await stat(resolve(absolute, name));
            return info.isDirectory() ? `${name}/` : name;
          } catch {
            return name;
          }
        }),
      );

      return withNotice(
        truncateOutput(described.join("\n") || "(empty directory)"),
        "directory has many entries",
      );
    },
  });
}
