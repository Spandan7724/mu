import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { authorizedDocumentId } from "../contracts/primitives.ts";
import {
  AuthorizedDocumentStore,
  authorizeDocument,
  DOCUMENT_LIMITS,
  DocumentAuthorizationError,
  documentIdForPath,
  mimeTypeForBasename,
} from "./documents.ts";

let root: string;
let resumePath: string;

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "no-error";
  } catch (error) {
    return error instanceof DocumentAuthorizationError ? error.reason : "wrong-error";
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mu-documents-"));
  resumePath = join(root, "resume.pdf");
  await writeFile(resumePath, "%PDF-1.4 resume");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("document authorization", () => {
  test("authorizes an exact path and hashes its bytes", async () => {
    const document = await authorizeDocument(resumePath);
    expect(document.basename).toBe("resume.pdf");
    expect(document.mimeType).toBe("application/pdf");
    expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(document.bytes).toBe(15);
  });

  test("a directory, a glob and a relative path are not authorizations", async () => {
    expect(await reason(authorizeDocument(root))).toBe("not-a-file");
    expect(await reason(authorizeDocument(join(root, "*.pdf")))).toBe("glob");
    expect(await reason(authorizeDocument("resume.pdf"))).toBe("not-absolute");
  });

  test("a missing file is refused with a basename, never a path", async () => {
    const missing = join(root, "absent.pdf");
    try {
      await authorizeDocument(missing);
      expect.unreachable();
    } catch (error) {
      expect((error as DocumentAuthorizationError).reason).toBe("missing");
      expect((error as Error).message).not.toContain(root);
    }
  });

  test("a file over the byte limit is refused at authorization", async () => {
    const big = join(root, "big.pdf");
    await writeFile(big, "x".repeat(2_048));
    expect(await reason(authorizeDocument(big, { maxBytes: 1_024 }))).toBe("too-large");
  });

  test("the logical id is stable for a path and reveals no path", async () => {
    const id = documentIdForPath(resumePath);
    expect(documentIdForPath(resumePath)).toBe(id);
    expect(id).toMatch(/^doc-[0-9a-f]{16}$/);
    expect(id).not.toContain("resume");
  });

  test("an unknown extension is typed conservatively", () => {
    expect(mimeTypeForBasename("payload.exe")).toBe("application/octet-stream");
    expect(mimeTypeForBasename("cover.DOCX")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });
});

describe("authorized document store", () => {
  test("the model-facing view has nowhere to put a path", async () => {
    const store = new AuthorizedDocumentStore();
    await store.authorize(resumePath);
    const [summary] = store.summaries();
    expect(summary).toBeDefined();
    expect(Object.keys(summary as object)).not.toContain("path");
    expect(JSON.stringify(store.summaries())).not.toContain(root);
  });

  test("a path-shaped id cannot address anything", async () => {
    const store = new AuthorizedDocumentStore();
    await store.authorize(resumePath);
    for (const attempt of [
      "../../etc/passwd",
      "/etc/passwd",
      resumePath,
      "..",
      "~/.ssh/id_rsa",
      "C:\\Windows\\win.ini",
    ]) {
      const result = await store.resolveForPurpose(attempt, "upload");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-id");
    }
  });

  test("an id that no longer resolves is refused, not guessed at", async () => {
    const store = new AuthorizedDocumentStore();
    const document = await store.authorize(resumePath);
    await rm(resumePath);
    const result = await store.resolveForPurpose(document.id, "upload");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  test("bytes that changed after authorization are a different document", async () => {
    const store = new AuthorizedDocumentStore();
    const document = await store.authorize(resumePath);
    await writeFile(resumePath, "%PDF-1.4 swapped payload");
    const result = await store.resolveForPurpose(document.id, "upload");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("content-changed");
  });

  test("a document authorized only for reference cannot be uploaded", async () => {
    const store = new AuthorizedDocumentStore();
    const document = await store.authorize(resumePath, { purposes: ["reference"] });
    const upload = await store.resolveForPurpose(document.id, "upload");
    expect(upload.ok).toBe(false);
    if (!upload.ok) expect(upload.reason).toBe("wrong-purpose");
    expect((await store.resolveForPurpose(document.id, "reference")).ok).toBe(true);
  });

  test("a wrong-MIME upload candidate is refused", async () => {
    const store = new AuthorizedDocumentStore();
    const binary = join(root, "installer.exe");
    await writeFile(binary, "MZ");
    const document = await store.authorize(binary);
    const result = await store.resolveForPurpose(document.id, "upload");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported-type");
    // The same bytes are still readable as reference material.
    expect((await store.resolveForPurpose(document.id, "reference")).ok).toBe(true);
  });

  test("an oversized upload candidate is refused at use time", async () => {
    const store = new AuthorizedDocumentStore();
    const document = await store.authorize(resumePath);
    const result = await store.resolveForPurpose(document.id, "upload", { maxBytes: 4 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too-large");
  });

  test("resolution is the only place an id becomes a path", async () => {
    const store = new AuthorizedDocumentStore();
    const document = await store.authorize(resumePath);
    const result = await store.resolveForPurpose(document.id, "upload");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.path).toBe(resumePath);
    expect(store.path(document.id)).toBe(resumePath);
    expect(() => store.path(authorizedDocumentId("doc-absent"))).toThrow(
      DocumentAuthorizationError,
    );
  });

  test("the store is bounded and refuses to reuse an id for another file", async () => {
    const store = new AuthorizedDocumentStore({ maxDocuments: 1 });
    const first = await store.authorize(resumePath);
    const other = join(root, "cover.pdf");
    await writeFile(other, "%PDF-1.4 cover");
    expect(await reason(store.authorize(other))).toBe("store-full");
    expect(await reason(store.authorize(other, { id: first.id }))).toBe("id-conflict");
    expect(store.size).toBe(1);
  });

  test("re-authorizing the same path replaces the record in place", async () => {
    const store = new AuthorizedDocumentStore();
    const first = await store.authorize(resumePath);
    await writeFile(resumePath, "%PDF-1.4 revised resume");
    const second = await store.authorize(resumePath);
    expect(second.id).toBe(first.id);
    expect(second.sha256).not.toBe(first.sha256);
    expect(store.size).toBe(1);
    expect((await store.resolveForPurpose(second.id, "upload")).ok).toBe(true);
  });

  test("the default upload budget is explicit", () => {
    expect(DOCUMENT_LIMITS.maxUploadBytes).toBe(25 * 1024 * 1024);
    expect(DOCUMENT_LIMITS.maxDocuments).toBe(100);
  });

  test("a symlink repointed after authorization fails the hash check", async () => {
    const store = new AuthorizedDocumentStore();
    const target = join(root, "real.pdf");
    const link = join(root, "linked.pdf");
    await writeFile(target, "%PDF-1.4 approved");
    await Bun.$`ln -s ${target} ${link}`.quiet();
    const document = await store.authorize(link);
    await writeFile(target, "%PDF-1.4 substituted");
    const result = await store.resolveForPurpose(document.id, "upload");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("content-changed");
  });

  test("an unauthorized sibling file is unreachable through the store", async () => {
    const store = new AuthorizedDocumentStore();
    await store.authorize(resumePath);
    const secret = join(root, "secrets.txt");
    await writeFile(secret, "token");
    expect(store.ids()).toHaveLength(1);
    expect(store.has(documentIdForPath(secret))).toBe(false);
    const result = await store.resolveForPurpose(documentIdForPath(secret), "reference");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown-id");
  });

  test("resolve does not accept a path even when it is the authorized one", async () => {
    const store = new AuthorizedDocumentStore();
    await store.authorize(resumePath);
    const result = await store.resolveForPurpose(resolve(resumePath), "reference");
    expect(result.ok).toBe(false);
  });
});
