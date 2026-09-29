import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyTool, evaluate, type ToolResult } from "@mu/core";
import { BROWSER_PERMISSION_DEFAULTS } from "../agent/permissions.ts";
import { minimalPdf } from "../testing/pdf.ts";
import { fileTools, pathPattern } from "./files.ts";

test("file tools work inside the agent's folder only, read PDFs, and fence what they read", async () => {
  const base = mkdtempSync(join(tmpdir(), "mu-files-"));
  const root = join(base, "work");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "about-me.md"), "Name: Ada Lovelace\n");
  writeFileSync(join(root, ".env"), "TOKEN=secret\n");
  writeFileSync(join(root, "resume.pdf"), minimalPdf(["Ada Lovelace, Analyst"]));
  writeFileSync(join(base, "outside.md"), "private\n");
  symlinkSync(join(base, "outside.md"), join(root, "link.md"));
  const tools = Object.fromEntries(fileTools(root).map((tool) => [tool.name, tool])) as Record<
    string,
    AnyTool
  >;
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = (await tools[name]?.execute(
      "f",
      args,
      new AbortController().signal,
    )) as ToolResult;
    return {
      result,
      text: result.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    };
  };

  expect(Object.keys(tools).sort()).toEqual(["edit", "ls", "read", "write"]);
  expect((await run("ls", {})).text).toContain("resume.pdf");

  const about = await run("read", { path: "docs/about-me.md" });
  expect(about.text).toMatch(
    /^<local_data source="file docs\/about-me.md" untrusted="true">\n\s+1\s+Name: Ada Lovelace/,
  );
  if (Bun.which("pdftotext"))
    expect((await run("read", { path: "resume.pdf" })).text).toContain("Ada Lovelace, Analyst");

  expect((await run("read", { path: "../outside.md" })).result.isError).toBe(true);
  expect((await run("read", { path: join(base, "outside.md") })).result.isError).toBe(true);
  expect((await run("read", { path: "link.md" })).text).not.toContain("private");
  expect((await run("read", { path: ".env" })).text).toContain("Refusing to access");

  await run("write", { path: "docs/about-me.md", content: "Name: Ada Lovelace\nPhone: 555\n" });
  expect(readFileSync(join(root, "docs", "about-me.md"), "utf8")).toContain("Phone: 555");
  expect((await run("write", { path: "../escape.md", content: "x" })).result.isError).toBe(true);
  expect((await run("write", { path: ".env", content: "x" })).text).toContain("Refusing to access");
  rmSync(base, { recursive: true, force: true });
});

test("progress/ is writable without asking; nothing else is, however the path is spelled", () => {
  const root = mkdtempSync(join(tmpdir(), "mu-progress-"));
  mkdirSync(join(root, "progress"));
  writeFileSync(join(root, "about-me.md"), "Name: Ada\n");
  symlinkSync(join(root, "about-me.md"), join(root, "progress", "link.md"));
  const rules = BROWSER_PERMISSION_DEFAULTS;
  const write = (path: string) => evaluate(rules, "write", pathPattern(root, path));
  expect(pathPattern(root, "progress/jobs.md")).toBe("progress/jobs.md");
  expect(write("progress/jobs.md")).toBe("allow");
  expect(write(join(root, "progress", "new", "list.md"))).toBe("allow");
  expect(write("about-me.md")).toBe("ask");
  expect(write("progress/../about-me.md")).toBe("ask");
  expect(write("progress/link.md")).toBe("ask");
  expect(write("../elsewhere/progress/x.md")).toBe("ask");
  expect(evaluate(rules, "edit", pathPattern(root, "progress/jobs.md"))).toBe("allow");
  rmSync(root, { recursive: true, force: true });
});
