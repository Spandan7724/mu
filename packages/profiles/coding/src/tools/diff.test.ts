import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyTool, CheckpointDiffFile } from "@mu/core";
import { FileState } from "../state.ts";
import { fileDiff } from "./diff.ts";
import { editTool, readTool, writeTool } from "./files.ts";

const signal = new AbortController().signal;

async function gitNumstat(before: string, after: string) {
  const dir = await mkdtemp(join(tmpdir(), "mu-diff-"));
  await writeFile(join(dir, "a"), before);
  await writeFile(join(dir, "b"), after);
  const result = Bun.spawnSync(["git", "diff", "--no-index", "--numstat", "--minimal", "a", "b"], {
    cwd: dir,
  });
  await rm(dir, { recursive: true, force: true });
  const [added = "0", removed = "0"] = result.stdout.toString().trim().split(/\s+/);
  return { added: Number(added), removed: Number(removed) };
}

// Rebuilds the new file's lines from the old one and the hunks alone.
function applyHunks(before: string, diff: CheckpointDiffFile): string[] {
  const old = before.split("\n");
  if (old.at(-1) === "") old.pop();
  const out: string[] = [];
  let cursor = 0;
  for (const line of diff.hunks) {
    const header = /^@@ -(\d+),(\d+) \+\d+,\d+ @@/.exec(line);
    if (header) {
      const start = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1;
      out.push(...old.slice(cursor, start));
      cursor = start;
      continue;
    }
    if (line.startsWith("+")) out.push(line.slice(1));
    else if (line.startsWith("-")) cursor++;
    else {
      out.push(line.slice(1));
      cursor++;
    }
  }
  return [...out, ...old.slice(cursor)].map((line) => line.replace(/\r$/, ""));
}

const lines = (text: string) => {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all.map((line) => line.replace(/\r$/, ""));
};

async function edited(before: string, edits: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "mu-edit-"));
  await writeFile(join(root, "f.ts"), before);
  const state = new FileState();
  await (readTool({ root, state }) as unknown as AnyTool).execute("r", { path: "f.ts" }, signal);
  const result = await (editTool({ root, state }) as unknown as AnyTool).execute(
    "e",
    { path: "f.ts", edits },
    signal,
  );
  const after = await readFile(join(root, "f.ts"), "utf8");
  await rm(root, { recursive: true, force: true });
  expect(result.isError).toBeFalsy();
  return { after, diff: (result.details as { diff: CheckpointDiffFile }).diff };
}

const numbered = (count: number) =>
  `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

describe("edit diffs", () => {
  const cases: [string, string, unknown[]][] = [
    [
      "distant edits in one call stay separate hunks",
      numbered(80),
      [
        { oldString: "line 5\n", newString: "line five\n" },
        { oldString: "line 70\nline 71", newString: "line 70\nline seventy-one\nextra" },
      ],
    ],
    [
      "insertion only",
      numbered(10),
      [{ oldString: "line 4\n", newString: "line 4\nnew a\nnew b\n" }],
    ],
    [
      "unchanged lines inside oldString are context",
      numbered(10),
      [
        {
          oldString: "line 2\nline 3\nline 4\nline 5",
          newString: "line 2\nLINE 3\nline 4\nLINE 5",
        },
      ],
    ],
    [
      "mid-line replacement",
      "const a = 1;\nconst b = 2;\n",
      [{ oldString: "= 2", newString: "= 3" }],
    ],
    [
      "deleting a newline joins two lines",
      "one\ntwo\nthree\n",
      [{ oldString: "one\n", newString: "one " }],
    ],
    [
      "first line of a file starting blank",
      "\nfirst\nsecond\n",
      [{ oldString: "\nfirst", newString: "\nFIRST" }],
    ],
    [
      "two edits on one line",
      "a b c\nd\n",
      [
        { oldString: "a", newString: "A" },
        { oldString: "c", newString: "C" },
      ],
    ],
    ["adds the missing final newline", "one\ntwo", [{ oldString: "two", newString: "two\n" }]],
    [
      "crlf file",
      "one\r\ntwo\r\nthree\r\n",
      [{ oldString: "two\nthree", newString: "TWO\nthree" }],
    ],
    ["bom file", "﻿first\nsecond\n", [{ oldString: "first", newString: "FIRST" }]],
    ["replaceAll", "x\ny\nx\ny\n", [{ oldString: "x\n", newString: "x1\nx2\n", replaceAll: true }]],
  ];
  for (const [name, before, edits] of cases) {
    test(name, async () => {
      const { after, diff } = await edited(before, edits);
      expect({ added: diff.added, removed: diff.removed }).toEqual(await gitNumstat(before, after));
      expect(applyHunks(before.replace(/^﻿/, ""), diff)).toEqual(lines(after.replace(/^﻿/, "")));
      expect(diff.approximate).toBeUndefined();
    });
  }

  test("distant edits produce one hunk each with three lines of context", async () => {
    const { diff } = await edited(numbered(80), [
      { oldString: "line 5\n", newString: "line five\n" },
      { oldString: "line 70\n", newString: "line seventy\n" },
    ]);
    expect(diff.hunks.filter((line) => line.startsWith("@@"))).toEqual([
      "@@ -2,7 +2,7 @@",
      "@@ -67,7 +67,7 @@",
    ]);
  });
});

describe("whole-file diffs", () => {
  test("a write over an existing file counts like git", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-write-"));
    const before = numbered(60);
    const after = before
      .replace("line 3\n", "")
      .replace("line 30\n", "line 30\ninserted\n")
      .replace("line 55", "line fifty-five");
    await writeFile(join(root, "f.ts"), before);
    const state = new FileState();
    await (readTool({ root, state }) as unknown as AnyTool).execute("r", { path: "f.ts" }, signal);
    const result = await (writeTool({ root, state }) as unknown as AnyTool).execute(
      "w",
      { path: "f.ts", content: after },
      signal,
    );
    const diff = (result.details as { diff: CheckpointDiffFile }).diff;
    expect({ added: diff.added, removed: diff.removed }).toEqual({ added: 2, removed: 2 });
    expect({ added: diff.added, removed: diff.removed }).toEqual(await gitNumstat(before, after));
    await rm(root, { recursive: true, force: true });
  });

  test("random line changes count exactly like git and rebuild the new file", async () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 25; round++) {
      const before = Array.from({ length: 5 + Math.floor(random() * 60) }, () =>
        String(Math.floor(random() * 6)),
      );
      const after = before.flatMap((line) => {
        const roll = random();
        if (roll < 0.1) return [];
        if (roll < 0.2) return [line, String(Math.floor(random() * 6))];
        if (roll < 0.3) return ["changed"];
        return [line];
      });
      const a = `${before.join("\n")}\n`;
      const b = `${after.join("\n")}\n`;
      const diff = fileDiff("f", a, b);
      expect({ added: diff.added, removed: diff.removed }).toEqual(await gitNumstat(a, b));
      expect(applyHunks(a, diff)).toEqual(lines(b));
    }
  });

  test("a new file is all additions; an unchanged one has no hunks", () => {
    expect(fileDiff("f", undefined, "a\nb\n")).toEqual({
      path: "f",
      added: 2,
      removed: 0,
      hunks: ["@@ -0,0 +1,2 @@", "+a", "+b"],
    });
    expect(fileDiff("f", "a\n", "a\n")).toEqual({ path: "f", added: 0, removed: 0, hunks: [] });
  });

  test("past the search bound the changed region is reported, marked approximate", () => {
    const before = Array.from({ length: 3_000 }, (_, index) => `old ${index}`);
    const after = Array.from({ length: 3_000 }, (_, index) => `new ${index}`);
    const diff = fileDiff("f", `${before.join("\n")}\n`, `${after.join("\n")}\n`);
    expect(diff).toMatchObject({ added: 3_000, removed: 3_000, approximate: true });
  });
});
