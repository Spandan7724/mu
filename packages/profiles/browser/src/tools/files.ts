import { existsSync, realpathSync } from "node:fs";
import type { AnyTool, ToolResult } from "@mu/core";
import {
  editTool,
  FileState,
  lsTool,
  readTool,
  resolveInRoot,
  truncateOutput,
  withNotice,
  writeTool,
} from "@mu/profile-coding";
import { sensitivePath } from "../actions/files.ts";
import { detectType } from "../actions/filetype.ts";

const PDF_TIMEOUT_MS = 30_000;

const refuse = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function blocked(root: string, path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  let absolute: string;
  try {
    absolute = resolveInRoot(root, path);
  } catch {
    // Outside the folder: the coding tool reports that itself.
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

// A PDF inside the folder (after resolving links), or undefined.
function pdfPath(root: string, path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  try {
    const absolute = resolveInRoot(root, path);
    if (!existsSync(absolute)) return undefined;
    const real = realpathSync(absolute);
    resolveInRoot(realpathSync(root), real);
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
// browser agent lists, reads, writes and edits files there and nowhere else.
export function fileTools(root: string): AnyTool[] {
  const deps = { root, state: new FileState() };
  const guarded = (tool: AnyTool, fence: boolean): AnyTool => ({
    ...tool,
    execute: async (...call) => {
      const path = (call[1] as { path?: unknown } | undefined)?.path;
      const refusal = blocked(root, path);
      if (refusal) return refuse(refusal);
      const pdf = tool.name === "read" ? pdfPath(root, path) : undefined;
      let result: ToolResult;
      try {
        result = pdf ? await pdfText(pdf, call[2]) : await tool.execute(...call);
      } catch (error) {
        if (call[2].aborted) throw error;
        return refuse(
          `${error instanceof Error ? error.message : String(error)}. Only files in ${root} are available.`,
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
