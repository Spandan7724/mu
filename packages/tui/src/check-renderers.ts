// Housekeeping calls (checking or stopping background work) read as quiet dim
// rows and fold with neighbouring checks, so polling never outweighs the work.
import type { RenderContext } from "./cells.ts";
import type { ToolRendererFn, ToolRenderInfo } from "./registry.ts";
import { sanitizeUntrusted } from "./sanitize.ts";
import { type ColorDepth, GLYPHS, MARGIN, styleText } from "./style.ts";
import { truncateToWidth } from "./width.ts";

const sep = ` ${GLYPHS.separator} `;

function arg(info: ToolRenderInfo, key: string): unknown {
  return typeof info.args === "object" && info.args !== null
    ? (info.args as Record<string, unknown>)[key]
    : undefined;
}

function text(info: ToolRenderInfo): string {
  return (info.result?.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

interface Check {
  target: string;
  state: string;
  failed?: boolean;
}

type Describe = (info: ToolRenderInfo) => Check;

const failure = (info: ToolRenderInfo, target: string): Check => ({
  target,
  state: text(info).split("\n")[0] ?? "failed",
  failed: true,
});

const describers: Record<string, Describe> = {
  task_output: (info) => {
    const target = String(arg(info, "taskId") ?? "task");
    if (!info.result) {
      // The wait is unknown until the arguments are complete; the default is not a guess to show.
      if (info.argsStreaming) return { target: `checking ${target}`, state: "" };
      const wait = arg(info, "timeoutMs");
      const ms = typeof wait === "number" ? wait : 10_000;
      return ms > 0
        ? { target: `waiting on ${target}`, state: `up to ${formatWait(ms)}` }
        : { target: `checking ${target}`, state: "" };
    }
    if (info.result.isError) return failure(info, target);
    const details = info.result.details as
      | { status?: string; exitCode?: number | null }
      | undefined;
    const state =
      details?.status === "exited"
        ? `exited ${details.exitCode ?? "?"}`
        : (details?.status ?? "running");
    const body = text(info).replace(/\n\n\[[^\]]*\]$/, "");
    const fresh = body === "(no new output)" ? 0 : body.split("\n").length;
    return {
      target,
      state: `${state}${sep}${fresh === 0 ? "no new output" : `${plural(fresh, "new line")}`}`,
    };
  },
  task_list: (info) => {
    if (!info.result) return { target: "listing tasks", state: "" };
    if (info.result.isError) return failure(info, "tasks");
    const rows = text(info).startsWith("No background tasks") ? [] : text(info).split("\n");
    const running = rows.filter((row) => row.includes(`${GLYPHS.separator} running`)).length;
    return {
      target: "tasks",
      state: rows.length === 0 ? "none" : `${plural(rows.length, "task")}, ${running} running`,
    };
  },
  task_kill: (info) => {
    const target = String(arg(info, "taskId") ?? "task");
    if (!info.result) return { target: `stopping ${target}`, state: "" };
    if (info.result.isError) return failure(info, target);
    return { target, state: text(info).startsWith("Killed") ? "stopped" : "already stopped" };
  },
  subagent_status: (info) => {
    const id = arg(info, "subagentId");
    const target = typeof id === "string" ? id : "subagents";
    if (!info.result) {
      const wait = arg(info, "waitSeconds");
      return !info.argsStreaming && typeof wait === "number" && wait > 0
        ? { target: `waiting on ${target}`, state: `up to ${formatWait(wait * 1000)}` }
        : { target: `checking ${target}`, state: "" };
    }
    if (info.result.isError) return failure(info, target);
    const status = (info.result.details as { status?: string } | undefined)?.status;
    if (status) return { target, state: status };
    const rows = text(info).startsWith("No background subagents") ? [] : text(info).split("\n");
    return { target, state: rows.length === 0 ? "none" : plural(rows.length, "subagent") };
  },
};

function formatWait(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function checkRow(check: Check, done: boolean, depth: ColorDepth, width: number): string {
  const head = done ? `checked ${check.target}` : check.target;
  const line = truncateToWidth(
    sanitizeUntrusted(check.state ? `${head}${sep}${check.state}` : head),
    width,
  );
  return styleText(line, check.failed ? { red: true } : { dim: true }, depth);
}

function makeCheckRenderer(describe: Describe): ToolRendererFn {
  const render: ToolRendererFn = (info, ctx: RenderContext) => [
    MARGIN +
      styleText(`${GLYPHS.rule} `, { dim: true }, ctx.depth) +
      checkRow(describe(info), info.result !== undefined, ctx.depth, Math.max(1, ctx.width - 4)),
  ];
  render.activityKind = "check";
  render.quiet = true;
  // Each target once, in first-check order, with how often and its latest state.
  render.summarizeActivity = (infos, depth, width) => {
    const latest = new Map<string, { check: Check; count: number }>();
    for (const info of infos) {
      const check = (describers[info.toolName] ?? describe)(info);
      const seen = latest.get(check.target);
      latest.set(check.target, { check, count: (seen?.count ?? 0) + 1 });
    }
    const parts = [...latest.values()].map(
      ({ check, count }) =>
        `${check.target}${count > 1 ? ` ×${count}` : ""}${check.state ? `${sep}${check.state}` : ""}`,
    );
    const failed = [...latest.values()].some(({ check }) => check.failed);
    const summary = truncateToWidth(
      sanitizeUntrusted(`checked ${parts.join(", ")}`),
      Math.max(1, width ?? 80),
    );
    return styleText(summary, failed ? { red: true } : { dim: true }, depth);
  };
  return render;
}

export const taskCheckRenderers: Record<string, ToolRendererFn> = Object.fromEntries(
  ["task_output", "task_list", "task_kill"].map((name) => [
    name,
    makeCheckRenderer(describers[name] as Describe),
  ]),
);

export const subagentCheckRenderers: Record<string, ToolRendererFn> = {
  subagent_status: makeCheckRenderer(describers.subagent_status as Describe),
};
