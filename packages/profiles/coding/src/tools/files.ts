import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { type CheckpointDiffFile, errorResult, type ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import type { FileState } from "../state.ts";
import { truncateOutput, withNotice } from "../truncate.ts";
import { fileDiff, replacementDiff } from "./diff.ts";

const MAX_READ_SOURCE_BYTES = 16 * 1024 * 1024;

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
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes the session root: ${path}`);
  }
  return absolute;
}

function assertCanonicalInRoot(root: string, target: string, original: string): void {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes the session root through a symbolic link: ${original}`);
  }
}

export async function resolveExistingInRoot(root: string, path: string): Promise<string> {
  const lexical = resolveInRoot(root, path);
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(lexical);
  assertCanonicalInRoot(canonicalRoot, canonicalTarget, path);
  return canonicalTarget;
}

export async function resolveForWriteInRoot(root: string, path: string): Promise<string> {
  const lexical = resolveInRoot(root, path);
  const canonicalRoot = await realpath(root);
  try {
    const canonicalTarget = await realpath(lexical);
    assertCanonicalInRoot(canonicalRoot, canonicalTarget, path);
    return canonicalTarget;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const missing: string[] = [];
  let cursor = lexical;
  for (;;) {
    try {
      const canonicalParent = await realpath(cursor);
      assertCanonicalInRoot(canonicalRoot, canonicalParent, path);
      return resolve(canonicalParent, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(relative(parent, cursor));
      cursor = parent;
    }
  }
}

// The file a write to `path` lands in, relative to the canonical root with
// forward slashes, which is how checkpoints name it. Symbolic links are
// followed, so the named resource is the file that actually changes.
export function checkpointResource(root: string, path: string): string {
  const canonicalRoot = realpathSync.native(resolve(root));
  const missing: string[] = [];
  let cursor = resolveInRoot(root, path);
  let target: string;
  for (;;) {
    try {
      target = resolve(realpathSync.native(cursor), ...missing.toReversed());
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
  assertCanonicalInRoot(canonicalRoot, target, path);
  return relative(canonicalRoot, target).split(sep).join("/");
}

function display(root: string, path: string): string {
  const rel = relative(resolve(root), path);
  return rel === "" ? "." : rel;
}

// Root-relative with forward slashes, so a rule like `src/*` reads the same on
// every platform. Execution still enforces the root.
function permissionPath(root: string, path: string): string {
  try {
    return display(root, resolveInRoot(root, path)).split(sep).join("/");
  } catch {
    return resolve(root, path);
  }
}

// A trailing newline ends the last line rather than starting another.
function fileLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function filePermissionDiff(
  path: string,
  before: string | undefined,
  after: string,
): CheckpointDiffFile {
  return fileDiff(path, before, after);
}

export function readTool(deps: ToolDeps) {
  return tool({
    name: "read",
    changesState: false,
    description:
      "Read a file from the filesystem. Returns contents with line numbers for grounded path:line citations. Read a file before editing it.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file, absolute or relative to the session root"),
      offset: z.number().int().min(1).optional().describe("First line to read (1-based)"),
      limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
    }),
    isConcurrencySafe: () => true,
    execute: async ({ path, offset, limit }): Promise<ToolResult | string> => {
      let absolute = resolveInRoot(deps.root, path);
      let content: string;
      try {
        absolute = await resolveExistingInRoot(deps.root, path);
        const info = await stat(absolute);
        if (info.size > MAX_READ_SOURCE_BYTES) {
          return errorResult(
            `${display(deps.root, absolute)} is ${info.size.toLocaleString()} bytes; read refuses files larger than ${MAX_READ_SOURCE_BYTES.toLocaleString()} bytes. Use rg through the bounded bash tool to inspect it.`,
          );
        }
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

      deps.state.markRead(absolute, content);
      const allLines = fileLines(content);
      const start = (offset ?? 1) - 1;
      const slice = allLines.slice(start, limit ? start + limit : undefined);
      const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(5)}  ${line}`);
      const output = truncateOutput(numbered.join("\n"));
      const body = withNotice(output, "file is large");
      const instructions = await deps.instructions?.instructionsForPath(absolute);
      const text = [body || "(empty file)", instructions?.text].filter(Boolean).join("\n\n");
      const ranged = offset !== undefined || limit !== undefined;

      return {
        content: [{ type: "text", text }],
        details: {
          path: absolute,
          lines: allLines.length,
          ...(ranged
            ? {
                returnedLines: slice.length,
                ...(slice.length > 0
                  ? { startLine: start + 1, endLine: start + slice.length }
                  : {}),
              }
            : {}),
          truncated: output.truncated,
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
    changedResources: ({ path }) => [checkpointResource(deps.root, path)],
    permissionPattern: ({ path }) => permissionPath(deps.root, path),
    description:
      "Write a complete file, creating it or replacing its contents. To change part of an existing file, prefer edit.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file"),
      content: z.string().describe("The complete file contents"),
    }),
    permissionDetails: async ({ path, content }) => {
      const absolute = await resolveForWriteInRoot(deps.root, path);
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
      const absolute = await resolveForWriteInRoot(deps.root, path);
      let exists = true;
      let currentContent: string | undefined;
      try {
        currentContent = await readFile(absolute, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
        else throw error;
      }

      // Read-before-write: overwriting a file the agent has not looked at is
      // how unrelated work gets silently destroyed.
      if (exists && !deps.state.hasRead(absolute)) {
        return errorResult(
          `Refusing to overwrite ${display(deps.root, absolute)} because it has not been read in this session. Read it first, then write.`,
        );
      }
      if (deps.state.hasRead(absolute) && deps.state.isStale(absolute, currentContent)) {
        return errorResult(
          `${display(deps.root, absolute)} changed on disk since you read it. Read it again before writing.`,
        );
      }

      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
      deps.state.markWritten(absolute);

      const lines = fileLines(content).length;
      return {
        content: [
          {
            type: "text",
            text: `${exists ? "Updated" : "Created"} ${display(deps.root, absolute)} (${lines} lines)`,
          },
        ],
        details: {
          path: absolute,
          created: !exists,
          diff: filePermissionDiff(display(deps.root, absolute), currentContent, content),
        },
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

// Where one replacement landed, in both versions of the file. Only the tool can
// say this — the arguments alone carry no position — and a renderer that wants
// to number the diff has no other source for it.
interface EditHunk {
  edit: number;
  oldLine: number;
  newLine: number;
}

type ApplyResult =
  | {
      ok: true;
      updated: string;
      replacements: number;
      hunks: EditHunk[];
      ranges: EditRange[];
    }
  | { ok: false; message: string };

const lineCount = (text: string) => text.split("\n").length - 1;

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

const MAX_HINT_CANDIDATES = 2;
const HINT_SNIPPET_CHARS = 80;

const squash = (line: string) => line.trim().replace(/\s+/g, " ");

function describeIndent(line: string): string {
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  if (indent === "") return "no indentation";
  const tabs = indent.split("\t").length - 1;
  const spaces = indent.length - tabs;
  return [
    tabs > 0 ? `${tabs} tab${tabs === 1 ? "" : "s"}` : "",
    spaces > 0 ? `${spaces} space${spaces === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
}

const snippet = (line: string) => {
  const trimmed = line.trim();
  return JSON.stringify(
    trimmed.length > HINT_SNIPPET_CHARS ? `${trimmed.slice(0, HINT_SNIPPET_CHARS)}…` : trimmed,
  );
};

// Points the model at where its oldString almost matched: the file lines whose
// whitespace-normalised text equals oldString's first non-blank line, and the
// first line at each that differs. Matching itself stays exact.
function nearestMatch(content: string, oldString: string): string | undefined {
  const wanted = oldString.split("\n").map((line) => line.replace(/\r$/, ""));
  const anchor = wanted.findIndex((line) => line.trim() !== "");
  if (anchor === -1) return undefined;
  const key = squash(wanted[anchor] as string);
  const file = fileLines(content).map((line) => line.replace(/\r$/, ""));
  const hints: string[] = [];
  for (let line = 0; line < file.length && hints.length < MAX_HINT_CANDIDATES; line++) {
    if (squash(file[line] as string) !== key) continue;
    const start = line - anchor;
    if (start < 0) continue;
    const before = hints.length;
    for (let offset = 0; offset < wanted.length; offset++) {
      const have = file[start + offset];
      const want = wanted[offset] as string;
      const number = start + offset + 1;
      if (have === undefined) {
        hints.push(`At line ${start + 1} the file ends before oldString does.`);
        break;
      }
      if (have === want) continue;
      if (squash(have) !== squash(want)) {
        hints.push(
          `At line ${start + 1} it matches until line ${number}, where the file has ${snippet(have)}.`,
        );
      } else if (describeIndent(have) !== describeIndent(want)) {
        hints.push(
          `Line ${number} matches except for indentation (${describeIndent(have)} in the file, ${describeIndent(want)} in oldString).`,
        );
      } else {
        hints.push(`Line ${number} matches except for spacing within the line.`);
      }
      break;
    }
    if (hints.length === before) {
      hints.push(`At line ${start + 1} it matches except for line endings.`);
    }
  }
  if (hints.length > 0) return hints.join(" ");
  return `Its first line, ${snippet(wanted[anchor] as string)}, does not appear in the file even ignoring whitespace.`;
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
      const hint = nearestMatch(content, oldString);
      return {
        ok: false,
        message: `${at(index)}oldString was not found in ${label}. The text must match exactly, including whitespace and indentation.${hint ? ` ${hint}` : ""}`,
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
  let oldLine = 1;
  let newLine = 1;
  const hunks: EditHunk[] = [];
  for (const range of ranges) {
    const between = content.slice(cursor, range.start);
    const skipped = lineCount(between);
    oldLine += skipped;
    newLine += skipped;
    hunks.push({ edit: range.index, oldLine, newLine });
    updated += between + range.newString;
    oldLine += lineCount(content.slice(range.start, range.end));
    newLine += lineCount(range.newString);
    cursor = range.end;
  }
  updated += content.slice(cursor);
  return { ok: true, updated, replacements: ranges.length, hunks, ranges };
}

const MAX_PROBE_BYTES = 4 * 1024 * 1024;
const PROBE_CACHE_ENTRIES = 64;
const PROBE_TEXT_FILES = 4;

const countIn = (content: string, text: string) => content.split(text).length - 1;

// Lets a running edit row count its lines without the UI reading files. Matching
// mirrors applyEdits, line-ending adaptation included. Answers are cached per file
// version, and each file is read once per version however many edits a call makes.
export function editPreviewProbe(root: string): {
  occurrences(path: string, text: string): number | undefined;
  exists(path: string): boolean | undefined;
} {
  const cache = new Map<string, number>();
  // The latest text of each probed file, so a call's later edits count without a read.
  const texts = new Map<string, { version: string; content: string }>();
  return {
    exists(path) {
      try {
        statSync(resolveInRoot(root, path));
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
      }
    },
    occurrences(path, text) {
      try {
        const absolute = resolveInRoot(root, path);
        const stats = statSync(absolute);
        if (!stats.isFile() || stats.size > MAX_PROBE_BYTES) return undefined;
        const version = `${stats.mtimeMs}\u0000${stats.size}`;
        const key = `${absolute}\u0000${version}\u0000${text}`;
        const cached = cache.get(key);
        if (cached !== undefined) return cached;
        const known = texts.get(absolute);
        let content = known?.version === version ? known.content : undefined;
        if (content === undefined) {
          content = readFileSync(absolute, "utf8");
          if (texts.size >= PROBE_TEXT_FILES) texts.clear();
          texts.set(absolute, { version, content });
        }
        let count = countIn(content, text);
        if (count === 0 && text.includes("\n")) {
          for (const convert of [toCRLF, toLF]) {
            const converted = convert(text);
            if (converted !== text) count = countIn(content, converted);
            if (count > 0) break;
          }
        }
        if (cache.size >= PROBE_CACHE_ENTRIES) cache.clear();
        cache.set(key, count);
        return count;
      } catch {
        return undefined;
      }
    },
  };
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
    changedResources: ({ path }) => [checkpointResource(deps.root, path)],
    permissionPattern: ({ path }) => permissionPath(deps.root, path),
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
      const absolute = await resolveExistingInRoot(deps.root, path);
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
          file: replacementDiff(relativePath, text, applied.ranges),
        },
      };
    },
    execute: async ({ path, edits }): Promise<ToolResult | string> => {
      let absolute = resolveInRoot(deps.root, path);
      try {
        absolute = await resolveExistingInRoot(deps.root, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return errorResult(`File not found: ${display(deps.root, absolute)}`);
        }
        throw error;
      }

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

      if (deps.state.isStale(absolute, content)) {
        return errorResult(
          `${display(deps.root, absolute)} changed on disk since you read it. Read it again before editing.`,
        );
      }

      const { bom, text } = splitBom(content);
      const applied = applyEdits(text, edits, display(deps.root, absolute));
      if (!applied.ok) return errorResult(applied.message);

      const { updated, replacements: occurrences, hunks, ranges } = applied;
      await writeFile(absolute, bom + updated, "utf8");
      deps.state.markWritten(absolute);

      return {
        content: [
          {
            type: "text",
            text: `Edited ${display(deps.root, absolute)} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`,
          },
        ],
        details: {
          path: absolute,
          occurrences,
          edits: edits.length,
          hunks,
          diff: replacementDiff(display(deps.root, absolute), text, ranges),
        },
      };
    },
  });
}

export function lsTool(deps: ToolDeps) {
  return tool({
    name: "ls",
    changesState: false,
    description: "List the entries of a directory.",
    inputSchema: z.object({
      path: z.string().optional().describe("Directory to list; defaults to the session root"),
    }),
    isConcurrencySafe: () => true,
    execute: async ({ path }): Promise<ToolResult | string> => {
      const requested = path ?? ".";
      let absolute = resolveInRoot(deps.root, requested);
      let entries: string[];
      try {
        absolute = await resolveExistingInRoot(deps.root, requested);
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
