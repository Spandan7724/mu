import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFile, detectType, uploadProblem } from "./filetype.ts";

test("types come from content; the accept list is checked by name, and names must match content", () => {
  const dir = mkdtempSync(join(tmpdir(), "mu-filetype-"));
  const file = (name: string, content: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  const pdf = file("cv.pdf", "%PDF-1.4\n...");
  const md = file("cv.md", "# Ada\n");
  const txt = file("cv.txt", "# Ada\n");
  const fakePdf = file("renamed.pdf", "# Ada\n");
  const png = file("me.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  const docx = file("cv.docx", Buffer.from("PK\u0003\u0004....word/document.xml", "latin1"));

  expect(detectType(pdf).label).toBe("PDF");
  expect(detectType(md).mime).toBe("text/markdown");
  expect(detectType(png).mime).toBe("image/png");
  expect(detectType(docx).label).toBe("Word document");
  expect(describeFile(fakePdf)).toBe("plain text, 1 KB (named .pdf but the content is plain text)");

  const accept = ".pdf,.docx,.txt";
  expect(uploadProblem(accept, pdf)).toBeUndefined();
  expect(uploadProblem(accept, docx)).toBeUndefined();
  expect(uploadProblem(accept, txt)).toBeUndefined();
  expect(uploadProblem(accept, md)).toBe(
    "the field accepts .pdf, .docx, .txt; this is Markdown text (.md)",
  );
  expect(uploadProblem("", fakePdf)).toBe("named .pdf but the content is plain text");
  expect(uploadProblem("image/*", png)).toBeUndefined();
  expect(uploadProblem("application/pdf", pdf)).toBeUndefined();
  expect(uploadProblem("", md)).toBeUndefined();
  rmSync(dir, { recursive: true });
});
