import { AGENT_LABEL, type ColorDepth, type Style, styleText } from "@mu/tui";
import type { ContextPart, CostReport, Usage, UsageLine } from "mu";

const SEP = " · ";
const APPROX = "≈ ";
const SOURCE_ORDER = ["main", "subagents", "tools", "compaction", "side", "other"];
const SOURCE_LABELS: Record<string, string> = {
  main: "main turns",
  subagents: "subagents",
  tools: "tools",
  compaction: "compaction",
  side: "side (/btw)",
  other: "other",
};
const MESSAGE_LABELS: Record<string, string> = {
  user: "you",
  assistant: AGENT_LABEL,
  thinking: "thinking",
  toolCalls: "tool calls",
};
const PART_STYLES: Record<Exclude<ContextPart["id"], "context">, Style> = {
  system: { accent: true },
  tools: { toolExec: true },
  summary: { toolMutate: true },
  messages: { green: true },
  toolResults: { toolRead: true },
};
// Profile and SDK context groups take these in order of appearance.
const CONTEXT_STYLES: Style[] = [{ counsel: true }, { task: true }, { path: true }, { red: true }];

const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});
const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
});
const n = (value: number) => Math.max(0, Math.trunc(value)).toLocaleString("en-US");
const usd = (value: number | undefined) => `$${(value ?? 0).toFixed(4)}`;
const pct = (value: number) => `${(Number.isFinite(value) ? value * 100 : 0).toFixed(1)}%`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const promptTokens = (u: Usage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

interface Group {
  label: string;
  usage: Usage;
  turns: number;
}

function group(lines: UsageLine[], key: (line: UsageLine) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const line of lines) {
    const label = key(line);
    const current = groups.get(label) ?? { label, usage: zeroUsage(), turns: 0 };
    current.usage = addUsage(current.usage, line.usage);
    current.turns += line.turns;
    groups.set(label, current);
  }
  return [...groups.values()];
}

function table(
  header: string[],
  rows: { cells: string[]; bold?: boolean }[],
  paint: (text: string, style: Style) => string,
): string[] {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row.cells[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join("   ")
      .trimEnd();
  return [
    `  ${paint(line(header), { dim: true })}`,
    ...rows.map(
      (row) => `  ${row.bold ? paint(line(row.cells), { bold: true }) : line(row.cells)}`,
    ),
  ];
}

function spendSection(report: CostReport, paint: (text: string, style: Style) => string) {
  const dim = (text: string) => paint(text, { dim: true });
  const all = report.totals;
  const live = report.lines.filter(
    (line) =>
      promptTokens(line.usage) + line.usage.outputTokens > 0 || (line.usage.costUsd ?? 0) > 0,
  );
  const sources = group(live, (line) => line.source).sort(
    (a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label),
  );
  const models = group(live, (line) => line.model).sort(
    (a, b) => (b.usage.costUsd ?? 0) - (a.usage.costUsd ?? 0) || b.turns - a.turns,
  );
  const cells = (u: Usage) => [
    n(u.inputTokens),
    n(u.cacheReadTokens),
    n(u.cacheWriteTokens),
    n(u.outputTokens),
    usd(u.costUsd),
  ];
  const rows = [
    { cells: ["total", ...cells(all)], bold: true },
    ...(sources.length > 1 || (sources.length === 1 && sources[0]?.label !== "main")
      ? sources.map((s) => ({
          cells: [`  ${SOURCE_LABELS[s.label] ?? s.label}`, ...cells(s.usage)],
        }))
      : []),
  ];
  const out = [
    `  ${paint("Session cost", { bold: true })}${dim(SEP)}${paint(usd(all.costUsd), { bold: true })}`,
    "",
    ...table(["tokens", "input", "cache read", "cache write", "output", "cost"], rows, paint),
  ];
  if (models.length > 1) {
    const labelWidth = Math.max(...models.map((m) => m.label.length));
    const costWidth = Math.max(...models.map((m) => usd(m.usage.costUsd).length));
    out.push("", `  ${dim("by model")}`);
    for (const m of models) {
      const turns = m.turns > 0 ? dim(SEP + plural(m.turns, "turn")) : "";
      out.push(
        `    ${m.label.padEnd(labelWidth)}   ${usd(m.usage.costUsd).padStart(costWidth)}${turns}`,
      );
    }
  }
  const prompt = promptTokens(all);
  if (prompt > 0) {
    out.push(
      "",
      `  ${dim("cache hit")}   ${pct(all.cacheReadTokens / prompt)}${dim(" of prompt tokens read from cache")}`,
    );
  }
  return out;
}

const rank = (source: string) => {
  const index = SOURCE_ORDER.indexOf(source);
  return index === -1 ? SOURCE_ORDER.length - 1 : index;
};

function partStyle(part: ContextPart, contextIndex: number): Style {
  if (part.id === "context") return CONTEXT_STYLES[contextIndex % CONTEXT_STYLES.length] as Style;
  return PART_STYLES[part.id];
}

function partDetail(part: ContextPart): string | undefined {
  if (part.id === "tools" && part.count !== undefined) return plural(part.count, "tool");
  if (part.id === "summary" && part.count) return `from ${plural(part.count, "compaction")}`;
  return undefined;
}

// Children inline, biggest tool results first; whole items drop into `+N more`.
function childDetail(part: ContextPart, room: number): string {
  const children = part.children ?? [];
  const items =
    part.id === "toolResults"
      ? [
          ...children.slice(0, 3).map((child) => `${child.id} ${n(child.tokens)}`),
          ...(children.length === 4
            ? [`${children[3]?.id} ${n(children[3]?.tokens ?? 0)}`]
            : children.length > 4
              ? [
                  `${children.length - 3} others ${n(children.slice(3).reduce((sum, c) => sum + c.tokens, 0))}`,
                ]
              : []),
        ]
      : children.map((child) => `${MESSAGE_LABELS[child.id] ?? child.id} ${n(child.tokens)}`);
  const fit = (count: number) =>
    [
      ...items.slice(0, count),
      ...(count < items.length ? [`+${items.length - count} more`] : []),
    ].join(SEP);
  let shown = items.length;
  while (shown > 0 && fit(shown).length > room) shown--;
  return shown > 0 ? fit(shown) : "";
}

function contextSection(
  report: CostReport,
  width: number,
  color: boolean,
  paint: (text: string, style: Style) => string,
): string[] {
  const dim = (text: string) => paint(text, { dim: true });
  const { context } = report;
  const used = context.tokens;
  const window = context.window;
  const approx = context.reported ? "" : APPROX;
  const threshold = Math.floor(window * context.autoCompactAt);
  const left = threshold - used;
  const headline = [
    `  ${paint("Context", { bold: true })}${dim(SEP)}${dim(approx)}${n(used)}`,
    window > 0 ? ` / ${n(window)} (${pct(used / window)})` : "",
    window > 0
      ? dim(
          SEP +
            (left > 0
              ? `${n(left)} until auto-compact at ${Math.round(context.autoCompactAt * 100)}%`
              : "auto-compact due"),
        )
      : "",
  ].join("");
  const out = [headline];
  const parts = context.parts.filter((part) => part.tokens > 0);
  if (parts.length === 0) return out;
  let contextIndex = 0;
  const styles = parts.map((part) => partStyle(part, part.id === "context" ? contextIndex++ : 0));

  if (color && window > 0) {
    const cells = Math.max(20, Math.min(60, width - 6));
    const mark = Math.round(cells * context.autoCompactAt);
    let filled = 0;
    let bar = "";
    parts.forEach((part, index) => {
      const count = Math.min(cells - filled, Math.round((part.tokens / window) * cells));
      if (count <= 0) return;
      bar += paint("━".repeat(count), styles[index] as Style);
      filled += count;
    });
    for (let i = filled; i < cells; i++) bar += dim(i === mark ? "┃" : "─");
    out.push("", `  ${bar}`);
  }
  out.push("");

  const free = Math.max(0, window - used);
  const labelWidth = Math.max(...parts.map((part) => part.label.length)) + 2;
  const tokenWidth = Math.max(n(free).length, ...parts.map((part) => n(part.tokens).length));
  const share = (tokens: number) => (window > 0 ? pct(tokens / window) : "").padStart(6);
  const swatch = color ? 2 : 0;
  parts.forEach((part, index) => {
    const head = `  ${color ? `${paint("■", styles[index] as Style)} ` : ""}${part.label.padEnd(labelWidth)}${dim(APPROX)}${n(part.tokens).padStart(tokenWidth)}  ${dim(share(part.tokens))}`;
    const room = width - (2 + swatch + labelWidth + APPROX.length + tokenWidth + 8 + SEP.length);
    const detail = part.children ? childDetail(part, room) : partDetail(part);
    out.push(head + (detail ? dim(SEP + detail) : ""));
  });
  if (window > 0) {
    out.push(
      `  ${" ".repeat(swatch)}${dim("free".padEnd(labelWidth))}  ${dim(n(free).padStart(tokenWidth))}  ${dim(share(free))}`,
    );
  }
  return out;
}

export function renderCostCommand(report: CostReport, width: number, depth: ColorDepth): string[] {
  const paint = (text: string, style: Style) => styleText(text, style, depth);
  const color = depth !== "none";
  return [
    "",
    ...spendSection(report, paint),
    "",
    ...contextSection(report, width, color, paint),
    "",
  ];
}

export function isCostReport(data: unknown): data is CostReport {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "cost" &&
    Array.isArray((data as { lines?: unknown }).lines)
  );
}
