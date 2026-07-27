import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyTool } from "@mu/core";
import { FileState } from "./state.ts";
import { bashTool } from "./tools/bash.ts";
import { editTool, lsTool, readTool, resolveInRoot, writeTool } from "./tools/files.ts";
import { globTool, globToRegExp, grepTool } from "./tools/search.ts";
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
});

describe("ls, glob and grep", () => {
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

  test("glob matches nested files and skips node_modules", async () => {
    const root = await tree();
    const result = await run(globTool({ root, state: new FileState() }), {
      pattern: "**/*.ts",
    });
    const text = textOf(result);
    expect(text).toContain("src/index.ts");
    expect(text).toContain("src/util.ts");
    expect(text).not.toContain("node_modules");
  });

  test("glob reports cleanly when nothing matches", async () => {
    const root = await tree();
    const result = await run(globTool({ root, state: new FileState() }), { pattern: "**/*.rs" });
    expect(textOf(result)).toContain("No files matched");
  });

  test("grep finds matches with file and line numbers", async () => {
    const root = await tree();
    const result = await run(grepTool({ root, state: new FileState() }), { pattern: "answer" });
    const text = textOf(result);
    expect(text).toContain("src/index.ts:1:");
    expect(text).not.toContain("node_modules");
  });

  test("grep include filters by glob", async () => {
    const root = await tree();
    const result = await run(grepTool({ root, state: new FileState() }), {
      pattern: "hi",
      include: "**/*.md",
    });
    expect(textOf(result)).toContain("readme.md");
  });

  test("an invalid regex is an error, not a crash", async () => {
    const root = await tree();
    const result = await run(grepTool({ root, state: new FileState() }), { pattern: "([" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid regular expression");
  });
});

describe("globToRegExp", () => {
  test("* stays within a path segment", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
  });

  test("** crosses segments and matches zero directories", () => {
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("src/deep/a.ts")).toBe(true);
  });

  test("dots are literal", () => {
    expect(globToRegExp("a.ts").test("axts")).toBe(false);
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
