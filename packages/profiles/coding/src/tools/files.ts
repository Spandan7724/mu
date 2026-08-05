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
  instructions?: {
    instructionsForPath: (path: string) => Promise<{ text: string; sources: string[] }>;
  };
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
      const instructions = await deps.instructions?.instructionsForPath(absolute);
      const text = [body || "(empty file)", instructions?.text].filter(Boolean).join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: {
          path: absolute,
          lines: allLines.length,
          ...(instructions && instructions.sources.length > 0
            ? { loadedInstructions: instructions.sources }
            : {}),
        },
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

const editItemSchema = z.object({
  oldString: z.string().describe("Exact text to replace, including indentation"),
  newString: z.string().describe("Replacement text"),
  replaceAll: z.boolean().optional().describe("Replace every occurrence of this oldString"),
});

type EditItem = z.infer<typeof editItemSchema>;

interface EditRange {
  start: number;
  end: number;
  newString: string;
  index: number;
}

type ApplyResult =
  | { ok: true; updated: string; replacements: number }
  | { ok: false; message: string };

// A UTF-8 read keeps the BOM as the first character, where it is invisible in tool
// output and so never appears in an oldString anchored at the start of the file.
const BOM = "\uFEFF";

function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith(BOM)
    ? { bom: BOM, text: content.slice(1) }
    : { bom: "", text: content };
}

const toCRLF = (text: string) => text.replace(/\r?\n/g, "\r\n");
const toLF = (text: string) => text.replace(/\r\n/g, "\n");

// Tool output carries a file's line endings verbatim, but models reproduce them
// inconsistently — a CRLF file read back as oldString usually returns with bare LF.
// Rewriting the file to one convention would touch every line, so adapt the edit to
// whichever convention actually matches instead, leaving unchanged bytes alone.
function adaptLineEndings(content: string, oldString: string, newString: string): EditItem {
  if (oldString.includes("\n") && !content.includes(oldString)) {
    for (const convert of [toCRLF, toLF]) {
      const converted = convert(oldString);
      if (converted !== oldString && content.includes(converted)) {
        return { oldString: converted, newString: convert(newString) };
      }
    }
    return { oldString, newString };
  }
  // Matched as written. Inserted lines still follow the file's convention, so a
  // replacement never leaves LF endings behind in a CRLF file.
  return { oldString, newString: content.includes("\r\n") ? toCRLF(newString) : newString };
}

// Every edit is matched against the file as it was read, never against the result of an
// earlier edit in the same call, so the model can describe all of them from one read.
// Splicing by offset rather than String.replace is also what keeps $&, $`, $', $$ and $n
// in newString literal — those are expanded even when the search argument is a plain string.
function applyEdits(content: string, edits: EditItem[], label: string): ApplyResult {
  const at = (index: number) => (edits.length > 1 ? `edits[${index}]: ` : "");
  const ranges: EditRange[] = [];

  for (const [index, edit] of edits.entries()) {
    const { replaceAll } = edit;
    const { oldString, newString } = adaptLineEndings(content, edit.oldString, edit.newString);
    if (oldString === "") {
      return { ok: false, message: `${at(index)}oldString is empty — nothing to match.` };
    }
    if (oldString === newString) {
      return {
        ok: false,
        message: `${at(index)}oldString and newString are identical — nothing to do.`,
      };
    }

    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) {
      return {
        ok: false,
        message: `${at(index)}oldString was not found in ${label}. The text must match exactly, including whitespace and indentation.`,
      };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        message: `${at(index)}oldString appears ${occurrences} times in ${label}. Include more surrounding context to make it unique, or set replaceAll.`,
      };
    }

    let from = 0;
    for (;;) {
      const start = content.indexOf(oldString, from);
      if (start === -1) break;
      ranges.push({ start, end: start + oldString.length, newString, index });
      if (!replaceAll) break;
      from = start + oldString.length;
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  let previous: EditRange | undefined;
  for (const range of ranges) {
    if (previous && previous.end > range.start) {
      const same = previous.start === range.start && previous.end === range.end;
      return {
        ok: false,
        message: same
          ? `edits[${previous.index}] and edits[${range.index}] match the same text in ${label}. Drop the duplicate, or give each edit different text to match.`
          : `edits[${previous.index}] and edits[${range.index}] overlap in ${label}. Merge them into one edit, or target text that does not overlap.`,
      };
    }
    previous = range;
  }

  let updated = "";
  let cursor = 0;
  for (const range of ranges) {
    updated += content.slice(cursor, range.start) + range.newString;
    cursor = range.end;
  }
  updated += content.slice(cursor);
  return { ok: true, updated, replacements: ranges.length };
}

// Models trained on single-replacement editors routinely send one flat edit, and some
// send `edits` as a JSON string. Both are unambiguous, so accept them rather than spend
// a turn on a validation error the model can only fix by guessing.
export function coerceEditInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const args = { ...(raw as Record<string, unknown>) };

  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      // Leave it for the schema to reject.
    }
  }

  // Only a complete flat pair is unambiguous. Anything less is left alone so the schema
  // reports the shape it actually wants, rather than a path inside an array the model
  // never sent. A flat pair alongside `edits` is an extra edit, not a replacement for
  // the array — dropping it would apply part of the call and report success.
  if (typeof args.oldString === "string" && typeof args.newString === "string") {
    const { oldString, newString, replaceAll, ...rest } = args;
    const existing = Array.isArray(args.edits) ? args.edits : [];
    return {
      ...rest,
      edits: [
        ...existing,
        { oldString, newString, ...(replaceAll === undefined ? {} : { replaceAll }) },
      ],
    };
  }

  return args;
}

export function editTool(deps: ToolDeps) {
  return tool({
    name: "edit",
    changesState: true,
    description:
      "Replace exact strings in a file. Each oldString must appear exactly once unless that edit sets replaceAll. Pass several edits to change one file in a single call. Read the file first.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file"),
      edits: z
        .array(editItemSchema)
        .min(1)
        .describe(
          "One or more replacements applied in a single write. Each is matched against the file as you read it, not against the result of earlier edits in this call, and they must not overlap — merge changes that touch the same text into one edit.",
        ),
    }),
    coerceInput: coerceEditInput,
    permissionDetails: async ({ path, edits }) => {
      const absolute = resolveInRoot(deps.root, path);
      const relativePath = display(deps.root, absolute);
      let content: string;
      try {
        content = await readFile(absolute, "utf8");
      } catch {
        return { description: `Edit ${relativePath}` };
      }
      const { text } = splitBom(content);
      const applied = applyEdits(text, edits, relativePath);
      if (!applied.ok) return { description: `Edit ${relativePath}` };
      return {
        description: `Edit ${relativePath}`,
        preview: {
          kind: "diff",
          file: filePermissionDiff(relativePath, text, applied.updated),
        },
      };
    },
    execute: async ({ path, edits }): Promise<ToolResult | string> => {
      const absolute = resolveInRoot(deps.root, path);

      if (!deps.state.hasRead(absolute)) {
        return errorResult(
          `Read ${display(deps.root, absolute)} before editing it, so you can see what you are changing.`,
        );
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

      const { bom, text } = splitBom(content);
      const applied = applyEdits(text, edits, display(deps.root, absolute));
      if (!applied.ok) return errorResult(applied.message);

      const { updated, replacements: occurrences } = applied;
      await writeFile(absolute, bom + updated, "utf8");
      deps.state.markWritten(absolute);

      return {
        content: [
          {
            type: "text",
            text: `Edited ${display(deps.root, absolute)} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`,
          },
        ],
        details: { path: absolute, occurrences, edits: edits.length },
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
