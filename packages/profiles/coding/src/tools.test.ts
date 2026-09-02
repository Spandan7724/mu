import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyTool } from "@mu/core";
import { FileState } from "./state.ts";
import { bashTool } from "./tools/bash.ts";
import { editTool, lsTool, readTool, resolveInRoot, writeTool } from "./tools/files.ts";
import { renderTodos, TodoStore, todoTool } from "./tools/todo.ts";
import { truncateOutput } from "./truncate.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-coding-"));
}

const signal = new AbortController().signal;

// Tools are typed by their zod schema; tests drive them through the erased
// AnyTool surface the loop uses.
function run(tool: unknown, args: Record<string, unknown>) {
  return (tool as AnyTool).execute("t1", args, signal);
}

function permissionDetails(tool: unknown, args: Record<string, unknown>) {
  return (tool as AnyTool).permissionDetails?.(args);
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

describe("read", () => {
  test("returns numbered lines and records the read", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "first\nsecond\n");
    const state = new FileState();
    const result = await run(readTool({ root, state }), { path: "a.txt" });

    expect(textOf(result)).toContain("1  first");
    expect(textOf(result)).toContain("2  second");
    expect(state.hasRead(join(root, "a.txt"))).toBe(true);
  });

  test("offset and limit window the file", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "l1\nl2\nl3\nl4\n");
    const result = await run(readTool({ root, state: new FileState() }), {
      path: "a.txt",
      offset: 2,
      limit: 2,
    });
    const text = textOf(result);
    expect(text).toContain("2  l2");
    expect(text).toContain("3  l3");
    expect(text).not.toContain("l4");
    expect(result.details).toMatchObject({
      lines: 5,
      startLine: 2,
      endLine: 3,
      returnedLines: 2,
      truncated: false,
    });
  });

  test("a missing file is a helpful error, not a throw", async () => {
    const root = await scratch();
    const result = await run(readTool({ root, state: new FileState() }), { path: "nope.txt" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("File not found");
  });

  test("paths outside the session root are rejected", async () => {
    const root = await scratch();
    await expect(
      run(readTool({ root, state: new FileState() }), { path: "../../../etc/passwd" }),
    ).rejects.toThrow("escapes the session root");
  });

  test("canonical paths cannot escape through a symlink", async () => {
    const root = await scratch();
    const outside = await scratch();
    await writeFile(join(outside, "secret.txt"), "outside secret");
    await symlink(join(outside, "secret.txt"), join(root, "secret.txt"));

    await expect(
      run(readTool({ root, state: new FileState() }), { path: "secret.txt" }),
    ).rejects.toThrow("symbolic link");
  });

  test("an in-root name beginning with two dots remains valid", async () => {
    const root = await scratch();
    await writeFile(join(root, "..notes"), "valid");
    const result = await run(readTool({ root, state: new FileState() }), { path: "..notes" });
    expect(textOf(result)).toContain("valid");
  });
});

describe("write", () => {
  test("permission preview shows a new file as additions", async () => {
    const root = await scratch();
    const details = await permissionDetails(writeTool({ root, state: new FileState() }), {
      path: "new.txt",
      content: "first\nsecond\n",
    });

    expect(details?.description).toBe("Create new.txt");
    expect(details?.preview?.kind).toBe("diff");
    if (details?.preview?.kind === "diff") {
      expect(details.preview.file.added).toBe(2);
      expect(details.preview.file.removed).toBe(0);
      expect(details.preview.file.hunks).toContain("+first");
      expect(details.preview.file.hunks).toContain("+second");
    }
  });

  test("creates a new file without needing a prior read", async () => {
    const root = await scratch();
    const state = new FileState();
    const result = await run(writeTool({ root, state }), {
      path: "new.txt",
      content: "hello",
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("hello");
    expect(textOf(result)).toContain("Created");
  });

  test("refuses to overwrite a file that was never read", async () => {
    const root = await scratch();
    await writeFile(join(root, "existing.txt"), "precious");
    const result = await run(writeTool({ root, state: new FileState() }), {
      path: "existing.txt",
      content: "clobbered",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("has not been read");
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("precious");
  });

  test("allows the overwrite once the file has been read", async () => {
    const root = await scratch();
    await writeFile(join(root, "existing.txt"), "old");
    const state = new FileState();
    await run(readTool({ root, state }), { path: "existing.txt" });
    const result = await run(writeTool({ root, state }), {
      path: "existing.txt",
      content: "new",
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("new");
  });

  test("creates missing parent directories", async () => {
    const root = await scratch();
    await run(writeTool({ root, state: new FileState() }), {
      path: "deep/nested/file.txt",
      content: "x",
    });
    expect(await readFile(join(root, "deep/nested/file.txt"), "utf8")).toBe("x");
  });

  test("refuses a changed file even when its mtime is forced backwards", async () => {
    const root = await scratch();
    const path = join(root, "existing.txt");
    await writeFile(path, "original");
    const state = new FileState();
    await run(readTool({ root, state }), { path: "existing.txt" });
    const before = await stat(path);
    await writeFile(path, "external");
    await utimes(path, before.atime, new Date(before.mtimeMs - 60_000));

    const result = await run(writeTool({ root, state }), {
      path: "existing.txt",
      content: "agent overwrite",
    });
    expect(result.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe("external");
  });

  test("refuses to recreate a file deleted after it was read", async () => {
    const root = await scratch();
    const path = join(root, "existing.txt");
    await writeFile(path, "original");
    const state = new FileState();
    await run(readTool({ root, state }), { path: "existing.txt" });
    await rm(path);

    const result = await run(writeTool({ root, state }), {
      path: "existing.txt",
      content: "replacement",
    });
    expect(result.isError).toBe(true);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});

describe("edit", () => {
  async function prepared(content: string) {
    const root = await scratch();
    await writeFile(join(root, "code.ts"), content);
    const state = new FileState();
    await run(readTool({ root, state }), { path: "code.ts" });
    return { root, state };
  }

  test("replaces a unique string", async () => {
    const { root, state } = await prepared("const a = 1;\nconst b = 2;\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      oldString: "const a = 1;",
      newString: "const a = 42;",
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toContain("const a = 42;");
  });

  test("permission preview shows the proposed replacement before execution", async () => {
    const { root, state } = await prepared("const a = 1;\nconst b = 2;\n");
    const details = await permissionDetails(editTool({ root, state }), {
      path: "code.ts",
      oldString: "const a = 1;",
      newString: "const a = 42;",
    });

    expect(details?.description).toBe("Edit code.ts");
    expect(details?.preview?.kind).toBe("diff");
    if (details?.preview?.kind === "diff") {
      expect(details.preview.file.hunks).toContain("-const a = 1;");
      expect(details.preview.file.hunks).toContain("+const a = 42;");
      expect(await readFile(join(root, "code.ts"), "utf8")).toContain("const a = 1;");
    }
  });

  test("refuses an ambiguous match and says how many there were", async () => {
    const { root, state } = await prepared("x();\nx();\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      oldString: "x();",
      newString: "y();",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("appears 2 times");
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("x();\nx();\n");
  });

  test("replaceAll edits every occurrence", async () => {
    const { root, state } = await prepared("x();\nx();\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      oldString: "x();",
      newString: "y();",
      replaceAll: true,
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("y();\ny();\n");
  });

  test("writes $-sequences in newString literally instead of expanding them", async () => {
    const { root, state } = await prepared("const price = compute();\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      oldString: "compute()",
      newString: "compute($&, $`, $', $$, $1)",
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe(
      "const price = compute($&, $`, $', $$, $1);\n",
    );
  });

  test("permission preview keeps $-sequences literal too", async () => {
    const { root, state } = await prepared("const price = compute();\n");
    const details = await permissionDetails(editTool({ root, state }), {
      path: "code.ts",
      oldString: "compute()",
      newString: "compute($&)",
    });
    expect(details?.preview?.kind).toBe("diff");
    if (details?.preview?.kind === "diff") {
      expect(details.preview.file.hunks).toContain("+const price = compute($&);");
    }
  });

  test("replaceAll keeps $-sequences literal in every occurrence", async () => {
    const { root, state } = await prepared("a();\na();\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      oldString: "a()",
      newString: "b($&)",
      replaceAll: true,
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("b($&);\nb($&);\n");
  });

  test("a missing oldString explains the exact-match requirement", async () => {
    const { root, state } = await prepared("const a = 1;\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      oldString: "const  a = 1;",
      newString: "z",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("must match exactly");
  });

  test("editing without reading first is refused", async () => {
    const root = await scratch();
    await writeFile(join(root, "code.ts"), "a");
    const result = await run(editTool({ root, state: new FileState() }), {
      path: "code.ts",
      oldString: "a",
      newString: "b",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("before editing");
  });

  test("identical old and new strings are rejected", async () => {
    const { root, state } = await prepared("a");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      oldString: "a",
      newString: "a",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("identical");
  });

  test("a file changed behind the agent's back must be re-read", async () => {
    const { root, state } = await prepared("original\n");
    await Bun.sleep(10);
    await writeFile(join(root, "code.ts"), "changed by someone else\n");

    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      oldString: "changed",
      newString: "x",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("changed on disk");
  });

  test("applies several edits in one call", async () => {
    const { root, state } = await prepared("const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [
        { oldString: "const a = 1;", newString: "const a = 10;" },
        { oldString: "const c = 3;", newString: "const c = 30;" },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("2 replacements");
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe(
      "const a = 10;\nconst b = 2;\nconst c = 30;\n",
    );
  });

  test("reports where each replacement landed, in file order and in both versions", async () => {
    // The second edit grows by a line, so later old and new numbers diverge.
    const { root, state } = await prepared("one\ntwo\nthree\nfour\nfive\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [
        { oldString: "four", newString: "FOUR" },
        { oldString: "two", newString: "TWO\nEXTRA" },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect((result.details as { hunks: unknown }).hunks).toEqual([
      { edit: 1, oldLine: 2, newLine: 2 },
      { edit: 0, oldLine: 4, newLine: 5 },
    ]);
  });

  test("replaceAll reports a position per occurrence, not per edit", async () => {
    const { root, state } = await prepared("x();\nkeep\nx();\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      oldString: "x();",
      newString: "y();",
      replaceAll: true,
    });
    expect(result.isError).toBeFalsy();
    expect((result.details as { hunks: unknown }).hunks).toEqual([
      { edit: 0, oldLine: 1, newLine: 1 },
      { edit: 0, oldLine: 3, newLine: 3 },
    ]);
  });

  test("matches every edit against the original file, not against earlier edits", async () => {
    // Applied incrementally, the first edit would make "b" ambiguous for the second.
    const { root, state } = await prepared("a\nb\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [
        { oldString: "a", newString: "b" },
        { oldString: "b", newString: "c" },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("b\nc\n");
  });

  test("rejects overlapping edits and names both", async () => {
    const { root, state } = await prepared("hello world\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [
        { oldString: "hello world", newString: "x" },
        { oldString: "world", newString: "y" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("edits[0] and edits[1] overlap");
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("hello world\n");
  });

  test("one failing edit aborts the whole call and names the index", async () => {
    const { root, state } = await prepared("a\nb\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [
        { oldString: "a", newString: "z" },
        { oldString: "not present", newString: "y" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("edits[1]");
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("a\nb\n");
  });

  test("replaceAll applies per edit", async () => {
    const { root, state } = await prepared("x();\nx();\nkeep\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [
        { oldString: "x()", newString: "y()", replaceAll: true },
        { oldString: "keep", newString: "kept" },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("3 replacements");
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("y();\ny();\nkept\n");
  });

  test("the preview shows every edit in one diff", async () => {
    const { root, state } = await prepared("const a = 1;\nconst b = 2;\n");
    const details = await permissionDetails(editTool({ root, state }), {
      path: "code.ts",
      edits: [
        { oldString: "const a = 1;", newString: "const a = 10;" },
        { oldString: "const b = 2;", newString: "const b = 20;" },
      ],
    });
    expect(details?.preview?.kind).toBe("diff");
    if (details?.preview?.kind === "diff") {
      expect(details.preview.file.hunks).toContain("+const a = 10;");
      expect(details.preview.file.hunks).toContain("+const b = 20;");
    }
  });

  test("accepts a single flat edit, the shape most models reach for", async () => {
    const { root, state } = await prepared("const a = 1;\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      oldString: "const a = 1;",
      newString: "const a = 2;",
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("const a = 2;\n");
  });

  test("accepts edits sent as a JSON string", async () => {
    const { root, state } = await prepared("const a = 1;\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: JSON.stringify([{ oldString: "const a = 1;", newString: "const a = 3;" }]),
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("const a = 3;\n");
  });

  test("a flat edit sent alongside edits[] is an extra edit, not a discarded one", async () => {
    const { root, state } = await prepared("p\nq\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [{ oldString: "p", newString: "P" }],
      oldString: "q",
      newString: "Q",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("2 replacements");
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("P\nQ\n");
  });

  test("an incomplete flat edit is reported against the shape the tool documents", async () => {
    const { root, state } = await prepared("p\n");
    const result = await run(editTool({ root, state }), { path: "code.ts", oldString: "p" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("edits");
    expect(textOf(result)).not.toContain("edits.0.newString");
  });

  test("duplicate edits are named as duplicates rather than as an overlap", async () => {
    const { root, state } = await prepared("foo\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [
        { oldString: "foo", newString: "a" },
        { oldString: "foo", newString: "b" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("match the same text");
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("foo\n");
  });

  test("edits a CRLF file when oldString comes back with bare newlines", async () => {
    const { root, state } = await prepared("line1\r\nline2\r\nline3\r\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [{ oldString: "line1\nline2", newString: "changed1\nchanged2" }],
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("changed1\r\nchanged2\r\nline3\r\n");
  });

  test("leaves an LF file alone when oldString arrives with CRLF", async () => {
    const { root, state } = await prepared("line1\nline2\nline3\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [{ oldString: "line1\r\nline2", newString: "changed1\r\nchanged2" }],
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("changed1\nchanged2\nline3\n");
  });

  test("inserted lines follow the file's line endings", async () => {
    const { root, state } = await prepared("a\r\nb\r\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [{ oldString: "a", newString: "one\ntwo" }],
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("one\r\ntwo\r\nb\r\n");
  });

  test("edits a file that starts with a byte order mark and keeps it", async () => {
    const { root, state } = await prepared("\uFEFFconst a = 1;\n");
    const result = await run(editTool({ root, state }), {
      path: "code.ts",
      edits: [{ oldString: "const a = 1;", newString: "const a = 2;" }],
    });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe("\uFEFFconst a = 2;\n");
  });
});

describe("ls", () => {
  async function tree() {
    const root = await scratch();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "src/index.ts"), "export const answer = 42;\n");
    await writeFile(join(root, "src/util.ts"), "export function help() {}\n");
    await writeFile(join(root, "readme.md"), "# hi\n");
    await writeFile(join(root, "node_modules/pkg/index.ts"), "export const answer = 0;\n");
    return root;
  }

  test("ls marks directories", async () => {
    const root = await tree();
    const result = await run(lsTool({ root, state: new FileState() }), {});
    const text = textOf(result);
    expect(text).toContain("src/");
    expect(text).toContain("readme.md");
  });

  test("does not follow a directory symlink outside the root", async () => {
    const root = await tree();
    const outside = await scratch();
    await writeFile(join(outside, "secret.ts"), "export const externalSecret = 1;\n");
    await symlink(outside, join(root, "linked"));

    await expect(run(lsTool({ root, state: new FileState() }), { path: "linked" })).rejects.toThrow(
      "symbolic link",
    );
  });
});

describe("bash", () => {
  function fakeSpawn(
    result: Partial<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>,
  ) {
    return async () => ({
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
      timedOut: result.timedOut ?? false,
    });
  }

  test("returns stdout on success", async () => {
    const tool = bashTool({ root: "/tmp", spawn: fakeSpawn({ stdout: "hello\n" }) });
    const result = await run(tool, { command: "echo hello" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("hello");
  });

  test("streams stdout and stderr before returning the final result", async () => {
    const updates: string[] = [];
    const tool = bashTool({
      root: "/tmp",
      spawn: async (_command, _cwd, _signal, _timeoutMs, onOutput) => {
        onOutput?.("first\n", "stdout");
        await Bun.sleep(1);
        onOutput?.("warning\n", "stderr");
        return {
          stdout: "first\n",
          stderr: "warning\n",
          exitCode: 0,
          timedOut: false,
        };
      },
    }) as AnyTool;

    const result = await tool.execute("t1", { command: "stream" }, signal, (partial) => {
      updates.push(
        partial
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      );
    });

    expect(updates.join("")).toContain("first");
    expect(updates.join("")).toContain("[stderr]\nwarning");
    expect(textOf(result)).toContain("warning");
    expect((result.details as { durationMs?: number }).durationMs).toBeNumber();
  });

  test("a non-zero exit is an error result carrying the code", async () => {
    const tool = bashTool({
      root: "/tmp",
      spawn: fakeSpawn({ stderr: "boom", exitCode: 2 }),
    });
    const result = await run(tool, { command: "false" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("exit code 2");
    expect(textOf(result)).toContain("boom");
  });

  test("ripgrep exit code 1 is a successful no-match result", async () => {
    const tool = bashTool({ root: "/tmp", spawn: fakeSpawn({ exitCode: 1 }) });
    const result = await run(tool, { command: "rg -n -e 'grepTool' packages" });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("No matches");
    expect(result.details).toMatchObject({ exitCode: 1, noMatches: true });
  });

  test("compound commands keep ordinary exit-code semantics", async () => {
    const tool = bashTool({ root: "/tmp", spawn: fakeSpawn({ exitCode: 1 }) });
    const result = await run(tool, { command: "rg missing packages; false" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("exit code 1");
  });

  test("a timeout is reported as such", async () => {
    const tool = bashTool({
      root: "/tmp",
      spawn: fakeSpawn({ stdout: "partial", timedOut: true, exitCode: null }),
    });
    const result = await run(tool, { command: "sleep 999" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("timed out");
  });

  test("really runs a command against the shell", async () => {
    const root = await scratch();
    const result = await run(bashTool({ root }), { command: "echo integration && pwd" });
    expect(textOf(result)).toContain("integration");
  });

  test("bounds foreground output before the process exits", async () => {
    if (process.platform === "win32") return;
    const root = await scratch();
    const result = await run(bashTool({ root }), {
      command: "printf 'x%.0s' {1..100000}",
    });
    expect(textOf(result)).toContain("bytes omitted");
    expect(textOf(result).length).toBeLessThan(40_000);
  });

  test("escalates timeout termination when a process ignores SIGTERM", async () => {
    if (process.platform === "win32") return;
    const root = await scratch();
    const started = Date.now();
    const result = await run(bashTool({ root }), {
      command: "trap '' TERM; while :; do sleep 1; done",
      timeoutMs: 50,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("todo", () => {
  test("renders the list and stores it", async () => {
    const store = new TodoStore();
    const result = await run(todoTool(store), {
      items: [
        { content: "write tests", status: "completed" },
        { content: "ship it", status: "in_progress" },
        { content: "celebrate", status: "pending" },
      ],
    });
    const text = textOf(result);
    expect(text).toContain("[x] write tests");
    expect(text).toContain("[~] ship it");
    expect(text).toContain("[ ] celebrate");
    expect(store.all().length).toBe(3);
  });

  test("warns when more than one task is in progress", async () => {
    const result = await run(todoTool(new TodoStore()), {
      items: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    });
    expect(textOf(result)).toContain("one at a time");
  });

  test("renders an empty list", () => {
    expect(renderTodos([])).toBe("(no tasks)");
  });
});

describe("truncation", () => {
  test("short output is untouched", () => {
    expect(truncateOutput("small").truncated).toBe(false);
  });

  test("long output keeps head and tail and says what was dropped", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const result = truncateOutput(lines);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("line 0");
    expect(result.text).toContain("line 4999");
    expect(result.text).toContain("lines omitted");
  });

  test("a single enormous line is truncated by characters", () => {
    const result = truncateOutput("x".repeat(100_000));
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("characters omitted");
  });

  test("read applies truncation with a notice", async () => {
    const root = await scratch();
    await writeFile(
      join(root, "big.txt"),
      Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n"),
    );
    const result = await run(readTool({ root, state: new FileState() }), { path: "big.txt" });
    expect(textOf(result)).toContain("output truncated");
    expect(result.details).toMatchObject({ lines: 4000, truncated: true });
  });
});

describe("resolveInRoot", () => {
  test("keeps relative paths inside the root", () => {
    expect(resolveInRoot("/base", "sub/file.ts")).toBe("/base/sub/file.ts");
  });

  test("rejects traversal", () => {
    expect(() => resolveInRoot("/base", "../outside")).toThrow("escapes");
  });
});
