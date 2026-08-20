import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { sampleDocument } from "../testing/samples.ts";
import {
  authorizedDocumentSchema,
  canUpload,
  documentSummary,
  findAuthorizedDocument,
} from "./documents.ts";

function rejects(document: unknown): boolean {
  return !authorizedDocumentSchema.safeParse(document).success;
}

describe("authorized document", () => {
  test("accepts an exact, hashed, absolute path", () => {
    expect(authorizedDocumentSchema.safeParse(sampleDocument()).success).toBe(true);
  });

  test("a relative path, a glob or a directory is not an authorization", () => {
    expect(rejects(sampleDocument({ path: "documents/resume.pdf" }))).toBe(true);
    expect(rejects(sampleDocument({ path: resolve("/documents/*.pdf"), basename: "*.pdf" }))).toBe(
      true,
    );
  });

  test("the basename must be the final component of the path", () => {
    expect(rejects(sampleDocument({ basename: "other.pdf" }))).toBe(true);
  });

  test("a basename may not be a path", () => {
    expect(rejects(sampleDocument({ basename: "../resume.pdf" }))).toBe(true);
  });

  test("the digest must be a real sha-256", () => {
    expect(rejects(sampleDocument({ sha256: "not-a-hash" }))).toBe(true);
    expect(rejects(sampleDocument({ sha256: "A".repeat(64) }))).toBe(true);
  });

  test("a document must be authorized for at least one purpose", () => {
    expect(rejects(sampleDocument({ purposes: [] }))).toBe(true);
    expect(rejects(sampleDocument({ purposes: ["upload", "upload"] }))).toBe(true);
  });

  test("the summary the model and receipts see has nowhere to put a path", () => {
    const summary = documentSummary(sampleDocument());
    expect(Object.keys(summary)).not.toContain("path");
    expect(JSON.stringify(summary)).not.toContain(resolve("/documents"));
    expect(summary.basename).toBe("resume.pdf");
  });

  test("upload authorization is per document", () => {
    expect(canUpload(sampleDocument())).toBe(true);
    expect(canUpload(sampleDocument({ purposes: ["reference"] }))).toBe(false);
  });

  test("lookup is by logical id, never by path", () => {
    const documents = [sampleDocument()];
    expect(findAuthorizedDocument(documents, "doc-resume")?.basename).toBe("resume.pdf");
    expect(findAuthorizedDocument(documents, resolve("/documents/resume.pdf"))).toBe(undefined);
  });

  test("extracted text is bounded", () => {
    expect(rejects(sampleDocument({ extractedText: "x".repeat(200_001) }))).toBe(true);
  });
});
