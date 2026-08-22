#!/usr/bin/env bun
// Disposable design spike for the todo/plan renderer. Prints every candidate
// form with mu's real palette so they can be compared in an actual terminal.
// Delete once the design is settled.
//
//   bun scripts/plan-preview.ts
//   NO_COLOR=1 bun scripts/plan-preview.ts
//   MU_FORCE_COLOR=ansi16 bun scripts/plan-preview.ts

import {
  detectColorDepth,
  GLYPHS,
  MARGIN,
  type Style,
  styleText,
} from "../packages/tui/src/style.ts";
import { stringWidth } from "../packages/tui/src/width.ts";

const depth = detectColorDepth();
const width = Math.max(60, Math.min(process.stdout.columns ?? 80, 96));

const s = (text: string, style: Style) => styleText(text, style, depth);
const dim = (text: string) => s(text, { dim: true });
const accent = (text: string) => s(text, { accent: true });
const green = (text: string) => s(text, { green: true });
const mutate = (text: string) => s(text, { toolMutate: true, bold: true });
const read = (text: string) => s(text, { toolRead: true, bold: true });
const path = (text: string) => s(text, { path: true });

type Status = "completed" | "in_progress" | "pending";
interface Task {
  content: string;
  status: Status;
}

const PLAN: Task[] = [
  { content: "read the renderer registry", status: "completed" },
  { content: "add the plan cell", status: "completed" },
  { content: "wire the coding renderer", status: "completed" },
  { content: "update the docs", status: "in_progress" },
  { content: "add golden-line tests", status: "pending" },
  { content: "run the full ci pass", status: "pending" },
];

const LONG_PLAN: Task[] = [
  ...Array.from({ length: 8 }, (_, i) => ({
    content: `finished step ${i + 1}`,
    status: "completed" as Status,
  })),
  { content: "update the docs", status: "in_progress" as Status },
  ...Array.from({ length: 5 }, (_, i) => ({
    content: `remaining step ${i + 1}`,
    status: "pending" as Status,
  })),
];

const done = (plan: Task[]) => plan.filter((t) => t.status === "completed").length;
const active = (plan: Task[]) => plan.find((t) => t.status === "in_progress")?.content ?? "";

// ── glyph vocabulary ────────────────────────────────────────────────────────
// ▸ and ▹ are mu's own spinner alphabet (▸▹▹ → ▹▸▹ → ▹▹▸) held still.
const PENDING = "▹";
const MARK: Record<Status, string> = {
  completed: GLYPHS.ok,
  in_progress: GLYPHS.userMarker,
  pending: PENDING,
};
const paintMark = (status: Status) =>
  status === "completed"
    ? green(MARK.completed)
    : status === "in_progress"
      ? accent(MARK.in_progress)
      : dim(MARK.pending);
// Finished work recedes, the live task is the brightest thing in the cell,
// what is not started yet is quiet.
const paintText = (task: Task) =>
  task.status === "completed"
    ? dim(task.content)
    : task.status === "in_progress"
      ? task.content
      : dim(task.content);

const meter = (plan: Task[]) => plan.map((t) => paintMark(t.status)).join("");
const bar = (plan: Task[]) =>
  green("▰".repeat(done(plan))) + dim("▱".repeat(plan.length - done(plan)));
const counts = (plan: Task[]) => `${done(plan)}/${plan.length}`;

// ── chrome used to show a variant in situ ───────────────────────────────────
const RULE = () => dim(`${GLYPHS.rule} `);
const row = (gutter: string, body: string) => MARGIN + gutter + body;
const composerRule = () => MARGIN + dim("─".repeat(Math.max(0, width - MARGIN.length * 2)));

const contextBefore = () => [
  row(RULE(), `${read("read")} ${path("packages/tui/src/registry.ts")}${dim(" · 409 lines")}`),
];
const contextAfter = () => [
  row(RULE(), `${mutate("edited")} ${path("packages/tui/src/cells.ts")}${dim(" · +48 −0")}`),
];

const footer = () => [
  MARGIN + dim("~/code/mu"),
  MARGIN + dim("claude-x · 0.4%/272k · ") + accent("↑1.1k ↓11") + dim(" · $0.14"),
];

// Wraps pinned rows in the composer bracket + footer, so a managed-region
// variant reads where it would actually live.
const frame = (pinned: string[], spinnerRow?: string) => [
  ...contextBefore(),
  ...contextAfter(),
  "",
  composerRule(),
  ...pinned,
  ...(pinned.length > 0 ? [composerRule()] : []),
  `${MARGIN + accent(GLYPHS.userMarker)} ${dim("_")}`,
  composerRule(),
  ...(spinnerRow ? [spinnerRow] : []),
  ...footer(),
];

// ── variants ────────────────────────────────────────────────────────────────
interface Variant {
  title: string;
  note: string;
  render(): string[];
}

const header = (plan: Task[], summary = `${counts(plan)} done`) =>
  row(RULE(), mutate("plan") + dim(` ${GLYPHS.separator} ${summary}`));

const variants: Variant[] = [
  {
    title: "what ships today",
    note: "no renderer registered, so genericRenderer truncates the plan to one line",
    render: () => [
      ...contextBefore(),
      row(RULE(), s("todo", { bold: true }) + dim(` ${GLYPHS.separator} [ ] read the rende…`)),
      ...contextAfter(),
    ],
  },

  // ── group A: transcript, block forms ──────────────────────────────────────
  {
    title: "solid rule",
    note: "the original proposal — mu's ordinary tool rule, glyph column, dim completed",
    render: () => [
      header(PLAN),
      ...PLAN.map((t) => row(RULE(), `${paintMark(t.status)} ${paintText(t)}`)),
    ],
  },
  {
    title: "progress-fill rule",
    note: "the gutter is the progress bar: solid behind, heavy at the cursor, dotted ahead",
    render: () => {
      const gutter = (status: Status) =>
        dim(status === "completed" ? "│ " : status === "in_progress" ? "┃ " : "┆ ");
      return [
        header(PLAN),
        ...PLAN.map((t) => row(gutter(t.status), `${paintMark(t.status)} ${paintText(t)}`)),
      ];
    },
  },
  {
    title: "dotted rule",
    note: "one character swap — the whole cell reads as intent rather than event",
    render: () => [
      row(dim("┆ "), mutate("plan") + dim(` ${GLYPHS.separator} ${counts(PLAN)} done`)),
      ...PLAN.map((t) => row(dim("┆ "), `${paintMark(t.status)} ${paintText(t)}`)),
    ],
  },
  {
    title: "block stripe",
    note: "▏ leaves no gaps between rows, so the plan reads as one object",
    render: () => [
      row(dim("▏ "), mutate("plan") + dim(` ${GLYPHS.separator} ${counts(PLAN)} done`)),
      ...PLAN.map((t) => row(dim("▏ "), `${paintMark(t.status)} ${paintText(t)}`)),
    ],
  },
  {
    title: "bracket",
    note: "closes the block explicitly — STYLES.md bans boxes, this is the edge of that",
    render: () => [
      row(dim("┌ "), mutate("plan") + dim(` ${GLYPHS.separator} ${counts(PLAN)} done`)),
      ...PLAN.map((t, i) =>
        row(dim(i === PLAN.length - 1 ? "└ " : "│ "), `${paintMark(t.status)} ${paintText(t)}`),
      ),
    ],
  },
  {
    title: "tree",
    note: "the tasks branch off the header rather than sitting beside it",
    render: () => [
      header(PLAN),
      ...PLAN.map((t, i) =>
        row(dim(i === PLAN.length - 1 ? "└ " : "├ "), `${paintMark(t.status)} ${paintText(t)}`),
      ),
    ],
  },
  {
    title: "no gutter — glyph column is the structure",
    note: "the purest reading of 'structure comes from glyphs, indentation, dim, whitespace'",
    render: () => [
      header(PLAN),
      ...PLAN.map((t) => `${MARGIN}  ${paintMark(t.status)} ${paintText(t)}`),
    ],
  },
  {
    title: "numbered steps",
    note: "the gutter carries step numbers, the way diff rows carry line numbers",
    render: () => [
      header(PLAN),
      ...PLAN.map((t, i) =>
        row(RULE(), `${dim(String(i + 1).padStart(2))} ${paintMark(t.status)} ${paintText(t)}`),
      ),
    ],
  },
  {
    title: "strikethrough completed",
    note: "finished work is struck out, so the eye lands on what is left",
    render: () => [
      header(PLAN),
      ...PLAN.map((t) =>
        row(
          RULE(),
          `${paintMark(t.status)} ${
            t.status === "completed"
              ? s(t.content, { dim: true, strikethrough: true })
              : paintText(t)
          }`,
        ),
      ),
    ],
  },
  {
    title: "only the future",
    note: "completed tasks never reprint — the header counts them, the cell shows what remains",
    render: () => [
      header(PLAN, `${done(PLAN)} done ${GLYPHS.separator} ${PLAN.length - done(PLAN)} left`),
      ...PLAN.filter((t) => t.status !== "completed").map((t) =>
        row(RULE(), `${paintMark(t.status)} ${paintText(t)}`),
      ),
    ],
  },
  {
    title: "bounded (long plan)",
    note: "leading completed run collapses, tail truncates — how a 14-task plan stays quiet",
    render: () => {
      const leading = LONG_PLAN.findIndex((t) => t.status !== "completed");
      const rest = LONG_PLAN.slice(leading);
      const shown = rest.slice(0, 4);
      const hidden = rest.length - shown.length;
      return [
        header(LONG_PLAN),
        row(RULE(), dim(`… ${leading} done`)),
        ...shown.map((t) => row(RULE(), `${paintMark(t.status)} ${paintText(t)}`)),
        row(RULE(), dim(`… ${hidden} more ${GLYPHS.separator} ctrl+o to expand`)),
      ];
    },
  },
  {
    title: "meter in the header",
    note: "the whole plan compressed into one glyph per task, list underneath",
    render: () => [
      row(RULE(), `${mutate("plan")} ${meter(PLAN)}${dim(` ${GLYPHS.separator} ${counts(PLAN)}`)}`),
      ...PLAN.map((t) => row(RULE(), `${paintMark(t.status)} ${paintText(t)}`)),
    ],
  },
  {
    title: "right-aligned status",
    note: "task text left, state word right — no glyph column at all",
    render: () => {
      const label: Record<Status, string> = {
        completed: "done",
        in_progress: "now",
        pending: "next",
      };
      return [
        header(PLAN, counts(PLAN)),
        ...PLAN.map((t) => {
          const body = t.status === "in_progress" ? t.content : dim(t.content);
          const tag = t.status === "in_progress" ? accent(label[t.status]) : dim(label[t.status]);
          const pad = Math.max(
            1,
            width - MARGIN.length - 2 - stringWidth(t.content) - stringWidth(label[t.status]),
          );
          return row(RULE(), body + " ".repeat(pad) + tag);
        }),
      ];
    },
  },

  // ── group B: transcript, one-line forms ───────────────────────────────────
  {
    title: "delta line",
    note: "the transcript records the change, not the document — one line per update",
    render: () => [
      ...contextBefore(),
      row(
        RULE(),
        mutate("plan") +
          dim(` ${GLYPHS.separator} `) +
          green(GLYPHS.ok) +
          dim(" wire the coding renderer") +
          dim(` ${GLYPHS.separator} `) +
          accent(GLYPHS.userMarker) +
          " update the docs" +
          dim(` ${GLYPHS.separator} ${counts(PLAN)}`),
      ),
      ...contextAfter(),
    ],
  },
  {
    title: "meter line",
    note: "one row: how many tasks, how far in, what is live",
    render: () => [
      ...contextBefore(),
      row(RULE(), `${mutate("plan")} ${meter(PLAN)}  ${active(PLAN)}`),
      ...contextAfter(),
    ],
  },
  {
    title: "bar line",
    note: "same idea with a filled bar instead of per-task glyphs",
    render: () => [
      ...contextBefore(),
      row(
        RULE(),
        mutate("plan") +
          " " +
          bar(PLAN) +
          dim(` ${counts(PLAN)} ${GLYPHS.separator} `) +
          active(PLAN),
      ),
      ...contextAfter(),
    ],
  },

  // ── group C: managed region, pinned ───────────────────────────────────────
  {
    title: "pinned meter strip",
    note: "not a transcript cell at all — one always-current row above the composer",
    render: () => frame([`${MARGIN + mutate("plan")}  ${meter(PLAN)}  ${active(PLAN)}`]),
  },
  {
    title: "pinned two rows",
    note: "meter and counts on top, the live task hanging under it",
    render: () =>
      frame([
        `${MARGIN + mutate("plan")}  ${meter(PLAN)}${dim(`  ${counts(PLAN)}`)}`,
        `${MARGIN}      ${accent(GLYPHS.userMarker)} ${active(PLAN)}`,
      ]),
  },
  {
    title: "pinned checklist",
    note: "the full plan pinned — most readable, most expensive in screen rows",
    render: () =>
      frame([
        MARGIN + mutate("plan") + dim(`  ${counts(PLAN)} done`),
        ...PLAN.map((t) => `${MARGIN}${paintMark(t.status)} ${paintText(t)}`),
      ]),
  },
  {
    title: "spinner row",
    note: "costs zero layout — the active-run row already exists, it just says more",
    render: () =>
      frame(
        [],
        MARGIN +
          accent(GLYPHS.spinner[0] as string) +
          " " +
          dim("update the docs") +
          dim(` ${GLYPHS.separator} ${counts(PLAN)} ${GLYPHS.separator} esc to interrupt`),
      ),
  },
  {
    title: "folded into the footer",
    note: "cheapest possible — no new region, no new row, plan lives in the stats line",
    render: () => [
      ...contextBefore(),
      ...contextAfter(),
      "",
      composerRule(),
      `${MARGIN + accent(GLYPHS.userMarker)} ${dim("_")}`,
      composerRule(),
      MARGIN + dim("~/code/mu"),
      MARGIN +
        dim("claude-x · 0.4%/272k · ") +
        meter(PLAN) +
        dim(` ${counts(PLAN)} · `) +
        accent("↑1.1k ↓11") +
        dim(" · $0.14"),
    ],
  },
];

// ── output ──────────────────────────────────────────────────────────────────
const out: string[] = [""];
out.push(
  MARGIN + dim(`plan renderer candidates · ${depth} · ${width} cols · NO_COLOR / MU_FORCE_COLOR`),
);
out.push("");

variants.forEach((variant, i) => {
  const n = String(i).padStart(2);
  out.push(
    MARGIN +
      dim(`── ${n} ${"─".repeat(Math.max(0, width - 10 - variant.title.length))} `) +
      variant.title,
  );
  out.push(MARGIN + dim(`   ${variant.note}`));
  out.push("");
  out.push(...variant.render());
  out.push("");
});

process.stdout.write(`${out.join("\n")}\n`);
