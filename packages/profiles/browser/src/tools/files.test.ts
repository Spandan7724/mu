import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyTool, ToolResult } from "@mu/core";
import { fileTools } from "./files.ts";

// One page, one line of text: enough for pdftotext.
function minimalPdf(line: string): string {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return `${out}trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("file tools work inside the agent's folder only, read PDFs, and fence what they read", async () => {
  const base = mkdtempSync(join(tmpdir(), "mu-files-"));
  const root = join(base, "work");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "about-me.md"), "Name: Ada Lovelace\n");
  writeFileSync(join(root, ".env"), "TOKEN=secret\n");
  writeFileSync(join(root, "resume.pdf"), minimalPdf("Ada Lovelace, Analyst"));
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
