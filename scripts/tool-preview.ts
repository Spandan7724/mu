#!/usr/bin/env bun
// Disposable design spike for the tool-cell gutter. Renders one realistic
// transcript in every candidate treatment, using mu's real palette. The plan
// block is deliberately unchanged in all of them — it is settled, and the point
// is to see what each treatment looks like sitting next to it.
//
// No style rules are respected here on purpose. Delete once the design settles.
//
//   bun scripts/tool-preview.ts
//   NO_COLOR=1 bun scripts/tool-preview.ts
//   MU_FORCE_COLOR=ansi16 bun scripts/tool-preview.ts

import { agentCell, planCell, userCell } from "../packages/tui/src/cells.ts";
import {
  detectColorDepth,
  GLYPHS,
  MARGIN,
  RESET,
  type Style,
  styleText,
} from "../packages/tui/src/style.ts";
import { stringWidth } from "../packages/tui/src/width.ts";

const depth = detectColorDepth();
const width = Math.max(60, Math.min(process.stdout.columns ?? 80, 92));
const ctx = { width, depth };

const s = (text: string, style: Style) => styleText(text, style, depth);
const dim = (text: string) => s(text, { dim: true });

type Tone = "read" | "mutate" | "exec";
const TONE: Record<Tone, Style> = {
  read: { toolRead: true },
  mutate: { toolMutate: true },
  exec: { toolExec: true },
};

interface Cell {
  verb: string;
  tone: Tone;
  arg: string;
  argRole: "path" | "code";
  meta?: string;
  ok?: boolean;
  fail?: string;
  output?: string[];
}

const BEFORE: Cell[] = [
  {
    verb: "read",
    tone: "read",
    arg: "packages/tui/src/registry.ts",
    argRole: "path",
    meta: "464 lines",
    output: [
      '    1  import type { ToolResultMessage } from "@mu/core";',
      "  … 460 lines omitted · ctrl+o to expand",
      "  464",
    ],
  },
  {
    verb: "ran",
    tone: "exec",
    arg: "rg -n --sort path '^export ' packages/tui/src",
    argRole: "code",
    meta: "3ms",
    ok: true,
    output: [
      "cells.ts:19:export interface RenderContext {",
      "cells.ts:30:export type ToolTone = read | mutate | exec | state",
      "… 27 lines omitted · ctrl+o to expand",
    ],
  },
];

const AFTER: Cell[] = [
  {
    verb: "edited",
    tone: "mutate",
    arg: "packages/tui/src/cells.ts",
    argRole: "path",
    meta: "+48 −0",
  },
  { verb: "ls", tone: "read", arg: "packages/tui/src", argRole: "path" },
  {
    verb: "ran",
    tone: "exec",
    arg: "bun test packages/tui",
    argRole: "code",
    meta: "427ms",
    ok: true,
    output: ["270 pass", "0 fail"],
  },
  {
    verb: "ran",
    tone: "exec",
    arg: "bun run typecheck",
    argRole: "code",
    fail: "exit 2",
    output: ["app.ts(513,11): error TS2741: Property 'superseded' is missing"],
  },
];

const ALL = [...BEFORE, ...AFTER];
const VERB_WIDTH = Math.max(...ALL.map((cell) => cell.verb.length));

const PLAN = [
  { content: "read the renderer registry", status: "completed" as const },
  { content: "add the plan cell", status: "completed" as const },
  { content: "wire the coding renderer", status: "completed" as const },
  { content: "update the docs", status: "in_progress" as const },
  { content: "add golden-line tests", status: "pending" as const },
  { content: "run the full ci pass", status: "pending" as const },
];

const OPENING = "Reading the registry first, then the plan cell.";
const CLOSING = "Typecheck is failing — fixing the cache key now.";

// ── pieces ──────────────────────────────────────────────────────────────────
const verbOf = (cell: Cell) => s(cell.verb, { bold: true, ...TONE[cell.tone] });
const argOf = (cell: Cell) =>
  s(cell.arg, cell.argRole === "path" ? { path: true } : { code: true });
// `statusInGutter` drops the ✓/✗ from the row when the gutter already carries it.
const metaOf = (cell: Cell, statusInGutter = false) => {
  const marks: string[] = [];
  if (cell.ok && !statusInGutter) marks.push(s(GLYPHS.ok, { green: true }));
  if (cell.fail) {
    if (!statusInGutter) marks.push(s(GLYPHS.error, { red: true }));
    marks.push(s(cell.fail, { red: true }));
  }
  if (cell.meta) marks.push(dim(cell.meta));
  return marks.length > 0 ? dim(` ${GLYPHS.separator} `) + marks.join(" ") : "";
};
const headText = (cell: Cell, statusInGutter = false) =>
  `${verbOf(cell)} ${argOf(cell)}${metaOf(cell, statusInGutter)}`;
const outputOf = (cell: Cell) => cell.output ?? [];
const isMulti = (cell: Cell) => outputOf(cell).length > 0;

const BAND = depth === "truecolor" ? "[48;2;30;32;38m" : depth === "ansi256" ? "[48;5;236m" : "";
// Nested styles close with a full reset, which would drop the band for the rest
// of the row, so the band is reopened after every one.
const banded = (text: string) => {
  if (BAND === "") return text;
  const body = text.replaceAll(RESET, RESET + BAND);
  const pad = " ".repeat(Math.max(0, width - MARGIN.length - stringWidth(text)));
  return BAND + body + pad + RESET;
};

// ── frame ───────────────────────────────────────────────────────────────────
type Draw = (cell: Cell) => string[];
type Gap = "always" | "multirow" | "none";

function frame(draw: Draw, gap: Gap, planRows = planCell({ items: PLAN }, ctx)): string[] {
  const out: string[] = [...userCell("add a renderer for the todo tool", ctx), ""];
  out.push(...agentCell(OPENING, ctx), "");
  const emit = (cell: Cell) => {
    out.push(...draw(cell));
    if (gap === "always" || (gap === "multirow" && isMulti(cell))) out.push("");
  };
  for (const cell of BEFORE) emit(cell);
  out.push(...planRows);
  if (gap !== "none") out.push("");
  for (const cell of AFTER) emit(cell);
  if (gap === "none") out.push("");
  out.push(...agentCell(CLOSING, ctx));
  return out;
}

const g = (glyph: string) => dim(`${glyph} `);
const ruled: Draw = (cell) => [
  MARGIN + g(GLYPHS.rule) + headText(cell),
  ...outputOf(cell).map((line) => MARGIN + g(GLYPHS.rule) + dim(line)),
];

// ── variants ────────────────────────────────────────────────────────────────
interface Variant {
  title: string;
  note: string;
  render(): string[];
}

const variants: Variant[] = [
  {
    title: "blank line after every cell",
    note: "kept — uniform rule, maximum air",
    render: () => frame(ruled, "always"),
  },
  {
    title: "bracket + blank lines",
    note: "kept — the plan treatment on any cell that spans rows",
    render: () =>
      frame((cell) => {
        const rows = [headText(cell), ...outputOf(cell).map(dim)];
        return rows.map(
          (text, i) =>
            MARGIN +
            g(
              rows.length === 1
                ? GLYPHS.rule
                : i === 0
                  ? GLYPHS.ruleOpen
                  : i === rows.length - 1
                    ? GLYPHS.ruleClose
                    : GLYPHS.rule,
            ) +
            text,
        );
      }, "multirow"),
  },
  {
    title: "no rule + blank lines",
    note: "kept — verb at the margin, output indented, nothing else",
    render: () =>
      frame(
        (cell) => [
          MARGIN + headText(cell),
          ...outputOf(cell).map((line) => `${MARGIN}    ${dim(line)}`),
        ],
        "multirow",
      ),
  },
  {
    title: "outcome gutter",
    note: "the left column is the result — ✓ ✗ · — so failures are findable by scan",
    render: () =>
      frame(
        (cell) => [
          MARGIN +
            (cell.fail
              ? s(GLYPHS.error, { red: true })
              : cell.ok
                ? s(GLYPHS.ok, { green: true })
                : dim(GLYPHS.separator)) +
            ` ${headText(cell, true)}`,
          ...outputOf(cell).map((line) => `${MARGIN}  ${dim(line)}`),
        ],
        "multirow",
      ),
  },
  {
    title: "shape gutter",
    note: "a glyph per action class — ◇ inspect, ◆ mutate, ▷ execute — colour optional",
    render: () =>
      frame(
        (cell) => [
          MARGIN +
            s(cell.tone === "read" ? "◇" : cell.tone === "mutate" ? "◆" : "▷", TONE[cell.tone]) +
            ` ${headText(cell)}`,
          ...outputOf(cell).map((line) => `${MARGIN}  ${dim(line)}`),
        ],
        "multirow",
      ),
  },
  {
    title: "right-aligned verb column",
    note: "verbs form a clean right edge; every argument starts at the same column",
    render: () =>
      frame((cell) => {
        const pad = " ".repeat(VERB_WIDTH - cell.verb.length);
        return [
          `${MARGIN}${pad}${verbOf(cell)}  ${argOf(cell)}${metaOf(cell)}`,
          ...outputOf(cell).map((line) => `${MARGIN}${" ".repeat(VERB_WIDTH + 2)}${dim(line)}`),
        ];
      }, "multirow"),
  },
  {
    title: "tinted header band",
    note: "the verb row gets a faint background to the edge; output sits plain beneath",
    render: () =>
      frame(
        (cell) => [
          MARGIN + banded(headText(cell)),
          ...outputOf(cell).map((line) => `${MARGIN}  ${dim(line)}`),
        ],
        "multirow",
      ),
  },
  {
    title: "timeline rail",
    note: "the turn is one thread; each call is a node hanging off it, git-graph style",
    render: () => {
      const out: string[] = [...userCell("add a renderer for the todo tool", ctx), ""];
      out.push(...agentCell(OPENING, ctx));
      const rail = dim(GLYPHS.rule);
      const node = (cell: Cell, last: boolean) => [
        MARGIN + dim(last ? "╰─" : "├─") + ` ${headText(cell)}`,
        ...outputOf(cell).map((line) => `${MARGIN}${last ? "  " : rail} ${dim(`  ${line}`)}`),
      ];
      out.push(MARGIN + rail);
      for (const cell of BEFORE) {
        out.push(...node(cell, false), MARGIN + rail);
      }
      out.push(...planCell({ items: PLAN }, ctx), MARGIN + rail);
      AFTER.forEach((cell, i) => {
        out.push(...node(cell, i === AFTER.length - 1));
        if (i < AFTER.length - 1) out.push(MARGIN + rail);
      });
      out.push("", ...agentCell(CLOSING, ctx));
      return out;
    },
  },
  {
    title: "nested under mu",
    note: "tools indent into the agent's own text column — machinery as a child of speech",
    render: () =>
      frame(
        (cell) => [
          `${MARGIN}    ${headText(cell)}`,
          ...outputOf(cell).map((line) => `${MARGIN}      ${dim(line)}`),
        ],
        "multirow",
      ),
  },
  {
    title: "hairline separator",
    note: "a faint full-width rule closes each call instead of empty space",
    render: () => {
      const hair = MARGIN + dim("─".repeat(Math.max(0, width - MARGIN.length * 2)));
      const out: string[] = [...userCell("add a renderer for the todo tool", ctx), ""];
      out.push(...agentCell(OPENING, ctx), "");
      const emit = (cell: Cell) => {
        out.push(
          MARGIN + headText(cell),
          ...outputOf(cell).map((line) => `${MARGIN}  ${dim(line)}`),
          hair,
        );
      };
      for (const cell of BEFORE) emit(cell);
      out.push(...planCell({ items: PLAN }, ctx), hair);
      for (const cell of AFTER) emit(cell);
      out.push("", ...agentCell(CLOSING, ctx));
      return out;
    },
  },
  {
    title: "collapsed by default",
    note: "output never shows until ctrl+o — the transcript becomes a list of actions",
    render: () =>
      frame(
        (cell) => [
          MARGIN +
            g(GLYPHS.rule) +
            headText(cell) +
            (isMulti(cell) ? dim(` ${GLYPHS.separator} +${outputOf(cell).length} lines`) : ""),
        ],
        "none",
      ),
  },
  {
    title: "numbered calls",
    note: "each call is addressable — useful when you want to say 'undo step 3'",
    render: () => {
      let n = 0;
      return frame((cell) => {
        n += 1;
        const index = dim(String(n).padStart(2));
        return [
          `${MARGIN + index} ${headText(cell)}`,
          ...outputOf(cell).map((line) => `${MARGIN}   ${dim(line)}`),
        ];
      }, "multirow");
    },
  },
];

const lines: string[] = [""];
lines.push(MARGIN + dim(`tool cell candidates · ${depth} · ${width} cols`));
variants.forEach((variant, i) => {
  const label = `${String(i).padStart(2)} ${variant.title}`;
  lines.push("");
  lines.push(MARGIN + dim(`── ${label} ${"─".repeat(Math.max(0, width - 8 - label.length))}`));
  lines.push(MARGIN + dim(`   ${variant.note}`));
  lines.push("");
  lines.push(...variant.render());
  lines.push("");
});

process.stdout.write(`${lines.join("\n")}\n`);
