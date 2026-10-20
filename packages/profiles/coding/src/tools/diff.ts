import type { CheckpointDiffFile } from "@mu/core";

const CONTEXT_LINES = 3;
// Myers costs O((N+M)·D) time and O(D²) memory. Past these bounds a whole-file
// diff falls back to one changed region and says so.
const MAX_DIFF_LINES = 50_000;
const MAX_EDIT_DISTANCE = 2_000;

type Op = { kind: "equal" | "del" | "add"; line: string };

// Lines keep their terminators, so a change to the final newline is a change.
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function display(line: string): string {
  return line.endsWith("\r\n") ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line;
}

// Shortest edit script between two line lists, or undefined past the bound.
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxD);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
          ? (v[offset + k + 1] ?? 0)
          : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return undefined;
}

function backtrack(a: readonly string[], b: readonly string[], trace: Int32Array[], last: number) {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = last; d >= 0; d--) {
    const saved = trace[d] as Int32Array;
    // `saved` holds diagonals -d-1..d+1 as they were before step d.
    const at = (k: number) => saved[k + d + 1] ?? 0;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : at(previousK);
    const previousY = d === 0 ? 0 : previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push({ kind: "equal", line: a[x - 1] as string });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === previousX) ops.push({ kind: "add", line: b[y - 1] as string });
      else ops.push({ kind: "del", line: a[x - 1] as string });
    }
    x = previousX;
    y = previousY;
  }
  return ops.reverse();
}

// Lines shared at both ends never need the diff search.
function diffLines(
  before: readonly string[],
  after: readonly string[],
): { ops: Op[]; exact: boolean } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);
  const searched =
    oldMiddle.length + newMiddle.length <= MAX_DIFF_LINES
      ? myers(oldMiddle, newMiddle, MAX_EDIT_DISTANCE)
      : undefined;
  const middle = searched ?? [
    ...oldMiddle.map((line): Op => ({ kind: "del", line })),
    ...newMiddle.map((line): Op => ({ kind: "add", line })),
  ];
  return {
    ops: [
      ...before.slice(0, prefix).map((line): Op => ({ kind: "equal", line })),
      ...middle,
      ...before.slice(before.length - suffix).map((line): Op => ({ kind: "equal", line })),
    ],
    exact: searched !== undefined,
  };
}

// Unified hunks with three lines of context, merging changes whose context meets.
function hunksFromOps(path: string, ops: readonly Op[], exact: boolean): CheckpointDiffFile {
  const hunks: string[] = [];
  let added = 0;
  let removed = 0;
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const op of ops) {
    oldBefore.push(oldLine);
    newBefore.push(newLine);
    if (op.kind !== "add") oldLine++;
    if (op.kind !== "del") newLine++;
  }
  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index]?.kind === "equal") index++;
    if (index >= ops.length) break;
    const from = Math.max(0, index - CONTEXT_LINES);
    let to = index;
    for (;;) {
      while (to < ops.length && ops[to]?.kind !== "equal") to++;
      let run = to;
      while (run < ops.length && ops[run]?.kind === "equal") run++;
      if (run < ops.length && run - to <= 2 * CONTEXT_LINES) {
        to = run;
        continue;
      }
      to = Math.min(ops.length, to + CONTEXT_LINES);
      break;
    }
    const slice = ops.slice(from, to);
    const oldCount = slice.filter((op) => op.kind !== "add").length;
    const newCount = slice.filter((op) => op.kind !== "del").length;
    const oldStart = (oldBefore[from] ?? 0) + (oldCount > 0 ? 1 : 0);
    const newStart = (newBefore[from] ?? 0) + (newCount > 0 ? 1 : 0);
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      if (op.kind === "add") added++;
      if (op.kind === "del") removed++;
      hunks.push(`${op.kind === "add" ? "+" : op.kind === "del" ? "-" : " "}${display(op.line)}`);
    }
    index = to;
  }
  return { path, added, removed, hunks, ...(exact ? {} : { approximate: true }) };
}

// A whole-file comparison, for writes and their approvals.
export function fileDiff(path: string, before: string | undefined, after: string) {
  const { ops, exact } = diffLines(splitLines(before ?? ""), splitLines(after));
  return hunksFromOps(path, ops, exact);
}

export interface Replacement {
  start: number;
  end: number;
  newString: string;
}

// An edit's diff built from where its replacements landed: each is widened to
// whole lines (more when its text joins the next line), replacements sharing a
// line are diffed together, and only those blocks are searched.
export function replacementDiff(
  path: string,
  content: string,
  replacements: readonly Replacement[],
): CheckpointDiffFile {
  const ops: Op[] = [];
  let exact = true;
  let cursor = 0;
  let index = 0;
  while (index < replacements.length) {
    const first = replacements[index] as Replacement;
    const blockStart = first.start === 0 ? 0 : content.lastIndexOf("\n", first.start - 1) + 1;
    let blockEnd = lineEndAfter(content, first.end);
    let last = index + 1;
    let replaced: string;
    for (;;) {
      while (last < replacements.length && (replacements[last] as Replacement).start < blockEnd) {
        blockEnd = Math.max(
          blockEnd,
          lineEndAfter(content, (replacements[last] as Replacement).end),
        );
        last++;
      }
      replaced = "";
      let at = blockStart;
      for (const replacement of replacements.slice(index, last)) {
        replaced += content.slice(at, replacement.start) + replacement.newString;
        at = replacement.end;
      }
      replaced += content.slice(at, blockEnd);
      if (replaced.endsWith("\n") || blockEnd >= content.length || replaced === "") break;
      blockEnd = lineEndAfter(content, blockEnd + 1);
    }
    for (const line of splitLines(content.slice(cursor, blockStart))) {
      ops.push({ kind: "equal", line });
    }
    const block = diffLines(splitLines(content.slice(blockStart, blockEnd)), splitLines(replaced));
    ops.push(...block.ops);
    exact &&= block.exact;
    cursor = blockEnd;
    index = last;
  }
  for (const line of splitLines(content.slice(cursor))) ops.push({ kind: "equal", line });
  return hunksFromOps(path, ops, exact);
}

// The end of the line holding the character before `offset`, newline included.
function lineEndAfter(content: string, offset: number): number {
  if (offset > 0 && content[offset - 1] === "\n") return offset;
  const newline = content.indexOf("\n", offset);
  return newline === -1 ? content.length : newline + 1;
}
