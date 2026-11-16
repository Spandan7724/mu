import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AnyTool, ToolResult } from "@mu/core";
import {
  editTool,
  type FileReach,
  FileState,
  lsTool,
  readTool,
  resolveExisting,
  resolveReachable,
  truncateOutput,
  withNotice,
  writeTool,
} from "@mu/profile-coding";
import { sensitivePath } from "../actions/files.ts";
import { detectType } from "../actions/filetype.ts";

const PDF_TIMEOUT_MS = 30_000;

const refuse = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

// The file's real location relative to the workspace, so a rule like "progress/*" can
// not be reached through "progress/../other.md" or a link out of progress/. A file in
// another folder is named by its absolute path.
export function pathPattern(reach: FileReach, path: unknown): string {
  if (typeof path !== "string") return ".";
  try {
    const absolute = resolveReachable(reach, path);
    let existing = absolute;
    const rest: string[] = [];
    while (!existsSync(existing)) {
      rest.unshift(basename(existing));
      existing = dirname(existing);
    }
    const real = join(realpathSync(existing), ...rest);
    const rel = relative(realpathSync(reach.root), real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      return real.split(sep).join("/");
    return rel.split(sep).join("/") || ".";
  } catch {
    return `outside:${path}`;
  }
}

function blocked(reach: FileReach, path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  let absolute: string;
  try {
    absolute = resolveReachable(reach, path);
  } catch {
    // Outside the folders: the coding tool reports that itself.
    return undefined;
  }
  const real = existsSync(absolute) ? realpathSync(absolute) : absolute;
  if (sensitivePath(absolute) || sensitivePath(real))
    return `Refusing to access ${path}: credential, key and private-config files are off limits.`;
  return undefined;
}

// File contents can carry instructions as easily as pages can.
function fenced(result: ToolResult, path: unknown): ToolResult {
  if (result.isError) return result;
  return {
    ...result,
    content: result.content.map((block) =>
      block.type === "text"
        ? {
            ...block,
            text: `<local_data source="file ${String(path)}" untrusted="true">\n${block.text}\n</local_data>`,
          }
        : block,
    ),
  };
}

// A PDF inside the folders (after resolving links), or undefined.
async function pdfPath(reach: FileReach, path: unknown): Promise<string | undefined> {
  if (typeof path !== "string") return undefined;
  try {
    const real = await resolveExisting(reach, path);
    return detectType(real).mime === "application/pdf" ? real : undefined;
  } catch {
    return undefined;
  }
}

async function pdfText(path: string, signal: AbortSignal): Promise<ToolResult> {
  const pdftotext = Bun.which("pdftotext");
  if (!pdftotext)
    return refuse(
      "Reading PDFs needs pdftotext (poppler-utils), which is not installed; use delegate instead.",
    );
  const child = Bun.spawn([pdftotext, "-layout", path, "-"], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.any([signal, AbortSignal.timeout(PDF_TIMEOUT_MS)]),
  });
  const [text, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal.throwIfAborted();
  if (code !== 0) return refuse(`Could not read the PDF: ${error.trim() || `exit ${code}`}`);
  const output = truncateOutput(
    text
      .replace(/\f/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  return {
    content: [{ type: "text", text: withNotice(output, "PDF text is long") || "(no text in PDF)" }],
    details: { path, pdf: true, truncated: output.truncated },
  };
}

// The coding agent's file tools, rooted at the folder mu was started in: the
// browser agent lists, reads, writes and edits files in the session's folders (D92)
// and nowhere else.
export function fileTools(reach: FileReach): AnyTool[] {
  const deps = { ...reach, state: new FileState() };
  const guarded = (tool: AnyTool, fence: boolean): AnyTool => ({
    ...tool,
    permissionPattern: (args) => pathPattern(reach, (args as { path?: unknown } | undefined)?.path),
    execute: async (...call) => {
      const path = (call[1] as { path?: unknown } | undefined)?.path;
      const refusal = blocked(reach, path);
      if (refusal) return refuse(refusal);
      const pdf = tool.name === "read" ? await pdfPath(reach, path) : undefined;
      let result: ToolResult;
      try {
        result = pdf ? await pdfText(pdf, call[2]) : await tool.execute(...call);
      } catch (error) {
        if (call[2].aborted) throw error;
        return refuse(
          `${error instanceof Error ? error.message : String(error)}. Only files in ${reach.root}, folders the user added and skill folders are available.`,
        );
      }
      return fence ? fenced(result, path) : result;
    },
  });
  const read = readTool(deps) as AnyTool;
  return [
    guarded(lsTool(deps) as AnyTool, false),
    guarded({ ...read, description: `${read.description} A PDF is returned as its text.` }, true),
    guarded(writeTool(deps) as AnyTool, false),
    guarded(editTool(deps) as AnyTool, false),
  ];
}
