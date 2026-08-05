import type { ToolResultMessage } from "@mu/core";
import {
  type DiffLine,
  diffCell,
  type RenderContext,
  type ToolCellOptions,
  toolCell,
  toolOutputCell,
} from "./cells.ts";
import { truncateToWidth } from "./width.ts";

const COMPACT_OUTPUT_LINES = 5;
const COMPACT_DIFF_LINES = 9;

export interface ToolRenderInfo {
  toolName: string;
  args: unknown;
  result?: ToolResultMessage;
  running?: boolean;
  expanded?: boolean;
  // Arguments are still arriving from the model, so anything rendered from them
  // is a fragment of itself.
  argsStreaming?: boolean;
}

export type ToolRendererFn = (info: ToolRenderInfo, ctx: RenderContext) => string[];

function firstString(args: unknown, keys: string[]): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function resultText(result: ToolResultMessage | undefined): string {
  if (!result) return "";
  return result.content
    .map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType}]`))
    .join("\n");
}

function compactLines(text: string, maxLines = COMPACT_OUTPUT_LINES): string[] {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return lines;
  const contentLines = Math.max(2, maxLines - 1);
  const head = Math.ceil(contentLines / 2);
  const tail = Math.floor(contentLines / 2);
  return [
    ...lines.slice(0, head),
    `… ${lines.length - head - tail} lines omitted · ctrl+o to expand`,
    ...lines.slice(-tail),
  ];
}

function resultPreview(info: ToolRenderInfo, ctx: RenderContext, maxLines?: number): string[] {
  if (info.running || info.expanded || !info.result) return [];
  const text = resultText(info.result);
  if (!text) return [];
  return compactLines(text, maxLines).flatMap((line) =>
    toolOutputCell(truncateToWidth(line, Math.max(20, ctx.width - 6)), ctx),
  );
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function stringArg(args: unknown, key: string): string {
  return firstString(args, [key]) ?? "";
}

// Arguments arrive raw from the model and stream in partially, so both the edits array
// and the flat single-edit shape the coding profile accepts have to render here.
function editArgs(args: unknown): { oldString: string; newString: string }[] {
  if (typeof args !== "object" || args === null) return [];
  const { edits, oldString, newString } = args as Record<string, unknown>;
  if (Array.isArray(edits)) {
    return edits
      .filter((edit): edit is Record<string, unknown> => typeof edit === "object" && edit !== null)
      .map((edit) => ({
        oldString: typeof edit.oldString === "string" ? edit.oldString : "",
        newString: typeof edit.newString === "string" ? edit.newString : "",
      }))
      .filter((edit) => edit.oldString !== "" || edit.newString !== "");
  }
  if (typeof oldString === "string" || typeof newString === "string") {
    return [
      {
        oldString: typeof oldString === "string" ? oldString : "",
        newString: typeof newString === "string" ? newString : "",
      },
    ];
  }
  return [];
}

function booleanArg(args: unknown, key: string): boolean {
  return (
    typeof args === "object" && args !== null && (args as Record<string, unknown>)[key] === true
  );
}

function boundedDiffLines(lines: DiffLine[], expanded: boolean | undefined): DiffLine[] {
  if (expanded || lines.length <= COMPACT_DIFF_LINES) return lines;
  const visible = COMPACT_DIFF_LINES - 1;
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  return [
    ...lines.slice(0, head),
    {
      kind: "context",
      text: `… ${lines.length - head - tail} lines omitted · ctrl+o to expand`,
    },
    ...lines.slice(-tail),
  ];
}

function displayedDiffLines(
  lines: DiffLine[],
  info: ToolRenderInfo,
  ctx: RenderContext,
): DiffLine[] {
  const bounded = boundedDiffLines(lines, info.expanded);
  if (info.expanded) return bounded;
  const width = Math.max(20, ctx.width - 14);
  return bounded.map((line) => ({ ...line, text: truncateToWidth(line.text, width) }));
}

// A diff is only meaningful whole. Rendered per token it shows deletions with
// no replacement yet, half-typed lines, and counts that climb — a change the
// user cannot read and that never existed on disk. The path is enough to say
// what is coming; the diff lands in one piece once the arguments are complete.
function argumentDiff(info: ToolRenderInfo, ctx: RenderContext): string[] {
  if (info.argsStreaming) return [];
  const path = stringArg(info.args, "path");
  if (!path) return [];

  if (info.toolName === "write") {
    const content = stringArg(info.args, "content");
    if (!content) return [];
    const sourceLines = content.split("\n");
    const lines = sourceLines.map(
      (text, index): DiffLine => ({ kind: "add", lineNumber: index + 1, text }),
    );
    return diffCell(
      {
        path,
        added: sourceLines.length,
        removed: 0,
        lines: displayedDiffLines(lines, info, ctx),
      },
      ctx,
    );
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const edit of editArgs(info.args)) {
    const oldLines = edit.oldString ? edit.oldString.split("\n") : [];
    const newLines = edit.newString ? edit.newString.split("\n") : [];
    lines.push(
      ...oldLines.map((text): DiffLine => ({ kind: "del", text })),
      ...newLines.map((text): DiffLine => ({ kind: "add", text })),
    );
    removed += oldLines.length;
    added += newLines.length;
  }
  if (lines.length === 0) return [];
  return diffCell({ path, added, removed, lines: displayedDiffLines(lines, info, ctx) }, ctx);
}

// The generic fallback: name, primary argument, truncated result. This is what
// makes the TUI domain-swappable — an unknown tool still renders sensibly.
export const genericRenderer: ToolRendererFn = (info, ctx) => {
  const primary = firstString(info.args, ["path", "command", "pattern", "query", "url", "name"]);
  const text = resultText(info.result);
  const firstLine = text.split("\n")[0] ?? "";

  const options: ToolCellOptions = {
    name: info.toolName,
    ...(primary ? { primaryArg: primary } : {}),
    ...(info.result?.isError ? { isError: true } : {}),
    ...(info.running
      ? { summary: "running" }
      : text
        ? { summary: truncateToWidth(firstLine, 40) }
        : {}),
  };
  return toolCell(options, ctx);
};

export class RendererRegistry {
  private renderers = new Map<string, ToolRendererFn>();

  register(toolName: string, renderer: ToolRendererFn): void {
    this.renderers.set(toolName, renderer);
  }

  registerAll(renderers: Record<string, ToolRendererFn>): void {
    for (const [name, renderer] of Object.entries(renderers)) this.register(name, renderer);
  }

  has(toolName: string): boolean {
    return this.renderers.has(toolName);
  }

  render(info: ToolRenderInfo, ctx: RenderContext): string[] {
    const renderer = this.renderers.get(info.toolName) ?? genericRenderer;
    let lines: string[];
    try {
      lines = renderer(info, ctx);
    } catch {
      // A broken renderer must never take the UI down with it.
      lines = genericRenderer(info, ctx);
    }
    return info.expanded && info.result
      ? [...lines, ...toolOutputCell(resultText(info.result), ctx)]
      : lines;
  }
}

// Renderers for the coding profile's tools, expressed as data so the TUI does
// not import the profile (dependency direction).
export const codingRenderers: Record<string, ToolRendererFn> = {
  read: (info, ctx) => {
    const details = info.result?.details as { lines?: number } | undefined;
    return [
      ...toolCell(
        {
          name: "read",
          ...(firstString(info.args, ["path"])
            ? { primaryArg: firstString(info.args, ["path"]) as string }
            : {}),
          ...(info.result?.isError ? { isError: true } : {}),
          ...(details?.lines ? { summary: `${details.lines} lines` } : {}),
        },
        ctx,
      ),
      ...resultPreview(info, ctx),
    ];
  },
  write: (info, ctx) => {
    const details = info.result?.details as { created?: boolean } | undefined;
    return [
      ...toolCell(
        {
          name:
            info.result && !info.result.isError
              ? details?.created
                ? "created"
                : "updated"
              : "write",
          ...(stringArg(info.args, "path") ? { primaryArg: stringArg(info.args, "path") } : {}),
          ...(info.result?.isError ? { isError: true } : {}),
        },
        ctx,
      ),
      ...argumentDiff(info, ctx),
      ...(info.result?.isError ? resultPreview(info, ctx) : []),
    ];
  },
  edit: (info, ctx) => {
    const details = info.result?.details as { occurrences?: number } | undefined;
    return [
      ...toolCell(
        {
          name: info.result && !info.result.isError ? "edited" : "edit",
          ...(firstString(info.args, ["path"])
            ? { primaryArg: firstString(info.args, ["path"]) as string }
            : {}),
          ...(info.result?.isError ? { isError: true } : {}),
          ...(details?.occurrences
            ? {
                summary: `${details.occurrences} replacement${details.occurrences === 1 ? "" : "s"}`,
              }
            : {}),
        },
        ctx,
      ),
      ...argumentDiff(info, ctx),
      ...(info.result?.isError ? resultPreview(info, ctx) : []),
    ];
  },
  bash: (info, ctx) => {
    const details = info.result?.details as
      | {
          exitCode?: number | null;
          background?: boolean;
          taskId?: string;
          durationMs?: number;
        }
      | undefined;
    const ok = details?.exitCode === 0;
    const duration = formatDuration(details?.durationMs);
    const userShell = booleanArg(info.args, "userShell");
    return [
      ...toolCell(
        {
          name: userShell ? "$" : info.running ? "running" : info.result ? "ran" : "bash",
          ...(firstString(info.args, ["command"])
            ? {
                primaryArg: firstString(info.args, ["command"]) as string,
                primaryAccent: true,
              }
            : {}),
          ...(info.result?.isError ? { isError: true } : {}),
          ...(info.result
            ? details?.background
              ? { summary: `${details.taskId ?? "task"} bg` }
              : ok
                ? { isSuccess: true, ...(duration ? { summary: duration } : {}) }
                : {
                    summary: [`exit ${details?.exitCode ?? "?"}`, duration]
                      .filter(Boolean)
                      .join(" · "),
                  }
            : {}),
        },
        ctx,
      ),
      ...resultPreview(info, ctx),
    ];
  },
  ls: (info, ctx) => [
    ...toolCell(
      {
        name: "ls",
        ...(firstString(info.args, ["path"])
          ? { primaryArg: firstString(info.args, ["path"]) as string }
          : {}),
        ...(info.result?.isError ? { isError: true } : {}),
      },
      ctx,
    ),
    ...resultPreview(info, ctx),
  ],
  glob: (info, ctx) => [
    ...toolCell(
      {
        name: "glob",
        ...(firstString(info.args, ["pattern"])
          ? { primaryArg: firstString(info.args, ["pattern"]) as string }
          : {}),
        ...(info.result?.isError ? { isError: true } : {}),
      },
      ctx,
    ),
    ...resultPreview(info, ctx),
  ],
  grep: (info, ctx) => [
    ...toolCell(
      {
        name: "grep",
        ...(firstString(info.args, ["pattern"])
          ? { primaryArg: firstString(info.args, ["pattern"]) as string }
          : {}),
        ...(info.result?.isError ? { isError: true } : {}),
      },
      ctx,
    ),
    ...resultPreview(info, ctx),
  ],
};
