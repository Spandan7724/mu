import type { ToolResultMessage } from "@mu/core";
import { type RenderContext, type ToolCellOptions, toolCell } from "./cells.ts";
import { truncateToWidth } from "./width.ts";

export interface ToolRenderInfo {
  toolName: string;
  args: unknown;
  result?: ToolResultMessage;
  running?: boolean;
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
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
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
    try {
      return renderer(info, ctx);
    } catch {
      // A broken renderer must never take the UI down with it.
      return genericRenderer(info, ctx);
    }
  }
}

// Renderers for the coding profile's tools, expressed as data so the TUI does
// not import the profile (dependency direction).
export const codingRenderers: Record<string, ToolRendererFn> = {
  read: (info, ctx) => {
    const details = info.result?.details as { lines?: number } | undefined;
    return toolCell(
      {
        name: "read",
        ...(firstString(info.args, ["path"])
          ? { primaryArg: firstString(info.args, ["path"]) as string }
          : {}),
        ...(info.result?.isError ? { isError: true } : {}),
        ...(details?.lines ? { summary: `${details.lines} lines` } : {}),
      },
      ctx,
    );
  },
  edit: (info, ctx) => {
    const details = info.result?.details as { occurrences?: number } | undefined;
    return toolCell(
      {
        name: "edit",
        ...(firstString(info.args, ["path"])
          ? { primaryArg: firstString(info.args, ["path"]) as string }
          : {}),
        ...(info.result?.isError ? { isError: true } : {}),
        ...(details?.occurrences
          ? { summary: `${details.occurrences} replacement${details.occurrences === 1 ? "" : "s"}` }
          : {}),
      },
      ctx,
    );
  },
  bash: (info, ctx) => {
    const details = info.result?.details as { exitCode?: number | null } | undefined;
    const ok = details?.exitCode === 0;
    return toolCell(
      {
        name: "bash",
        ...(firstString(info.args, ["command"])
          ? { primaryArg: firstString(info.args, ["command"]) as string }
          : {}),
        ...(info.result?.isError ? { isError: true } : {}),
        ...(info.result
          ? { summary: ok ? "✓" : `exit ${details?.exitCode ?? "?"}` }
          : { summary: "running" }),
      },
      ctx,
    );
  },
};
