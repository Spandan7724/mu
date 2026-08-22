import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import {
  type AuthorizedDocument,
  type AuthorizedDocumentSummary,
  authorizedDocumentSchema,
  type DocumentPurpose,
  documentSummary,
} from "../contracts/documents.ts";
import {
  type AuthorizedDocumentId,
  authorizedDocumentIdSchema,
  hasGlobMetacharacters,
} from "../contracts/primitives.ts";

export const DOCUMENT_LIMITS = {
  maxUploadBytes: 25 * 1024 * 1024,
  maxDocuments: 100,
} as const;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const FALLBACK_MIME_TYPE = "application/octet-stream";

// A form accepts documents, not executables. An extension Mu cannot name is not
// upload material, so the fallback type is deliberately absent here.
export const DEFAULT_UPLOAD_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "image/png",
  "image/jpeg",
];

export type DocumentRejectionReason =
  | "invalid-id"
  | "unknown-id"
  | "wrong-purpose"
  | "not-absolute"
  | "glob"
  | "missing"
  | "not-a-file"
  | "content-changed"
  | "too-large"
  | "unsupported-type"
  | "unreadable"
  | "store-full"
  | "id-conflict";

export class DocumentAuthorizationError extends Error {
  readonly reason: DocumentRejectionReason;

  constructor(reason: DocumentRejectionReason, message: string) {
    super(message);
    this.name = "DocumentAuthorizationError";
    this.reason = reason;
  }
}

// The one shape carrying a real path. It is produced only by a store lookup that
// starts from an authorized id, so there is no input that can widen it (BD16).
export interface ResolvedDocument {
  id: AuthorizedDocumentId;
  path: string;
  basename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

export type DocumentUseResult =
  | { ok: true; document: ResolvedDocument }
  | { ok: false; reason: DocumentRejectionReason; message: string };

export interface DocumentUsePolicy {
  maxBytes?: number | undefined;
  allowedMimeTypes?: readonly string[] | undefined;
}

export interface AuthorizeDocumentOptions {
  /**
   * Copy the file into this directory and authorize the copy instead of the original.
   *
   * The browser bridge enforces file-access roots: it refuses to attach any path outside
   * the directories it was started with, so an ordinary `~/Documents/resume.pdf` cannot
   * be uploaded at all. Staging brings the exact authorized bytes inside that boundary
   * without widening it — the alternative, unrestricted file access, would also unblock
   * `file://` navigation and is never acceptable.
   *
   * The original is never modified, and the copy is private (0600 inside a 0700 parent).
   */
  stageInto?: string | undefined;
  purposes?: readonly DocumentPurpose[] | undefined;
  id?: string | undefined;
  maxBytes?: number | undefined;
  extractedText?: string | undefined;
  now?: (() => number) | undefined;
}

/**
 * The staged copy lives under its own id, so two files sharing a basename cannot collide
 * and a staged path can always be traced back to exactly one authorization.
 */
async function stageDocument(
  source: string,
  id: string,
  name: string,
  root: string,
): Promise<string> {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staged = join(directory, name);
  await copyFile(source, staged);
  await chmod(staged, 0o600);
  return staged;
}

export function documentIdForPath(path: string): AuthorizedDocumentId {
  const digest = createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16);
  return authorizedDocumentIdSchema.parse(`doc-${digest}`);
}

export function mimeTypeForBasename(name: string): string {
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? FALLBACK_MIME_TYPE;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export async function authorizeDocument(
  path: string,
  options: AuthorizeDocumentOptions = {},
): Promise<AuthorizedDocument> {
  if (!isAbsolute(path)) {
    throw new DocumentAuthorizationError(
      "not-absolute",
      "a document is authorized by its exact absolute path",
    );
  }
  if (hasGlobMetacharacters(path)) {
    throw new DocumentAuthorizationError(
      "glob",
      "a glob is never an authorization; declare the exact file",
    );
  }
  const maxBytes = options.maxBytes ?? DOCUMENT_LIMITS.maxUploadBytes;
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new DocumentAuthorizationError("missing", `no file at ${basename(path)}`);
    }
    throw new DocumentAuthorizationError("unreadable", `cannot read ${basename(path)}`);
  }
  if (!stats.isFile()) {
    throw new DocumentAuthorizationError(
      "not-a-file",
      "a directory is never an authorization; declare the exact file",
    );
  }
  if (stats.size > maxBytes) {
    throw new DocumentAuthorizationError(
      "too-large",
      `${basename(path)} is ${stats.size} bytes, over the ${maxBytes} byte limit`,
    );
  }
  const name = basename(path);
  // Derived from the path the user actually authorized, so re-authorizing the same file
  // is idempotent whether or not it is staged.
  const id =
    options.id === undefined
      ? documentIdForPath(path)
      : authorizedDocumentIdSchema.parse(options.id);
  const stored =
    options.stageInto === undefined ? path : await stageDocument(path, id, name, options.stageInto);
  const document: AuthorizedDocument = {
    id,
    path: stored,
    basename: name,
    mimeType: mimeTypeForBasename(name),
    bytes: stats.size,
    sha256: await hashFile(path),
    purposes: [...(options.purposes ?? ["reference", "upload"])],
    ...(options.extractedText === undefined ? {} : { extractedText: options.extractedText }),
    addedAt: (options.now ?? Date.now)(),
  };
  return authorizedDocumentSchema.parse(document) as AuthorizedDocument;
}

export interface AuthorizedDocumentStoreOptions {
  /** Staging root; see `AuthorizeDocumentOptions.stageInto`. */
  stageInto?: string | undefined;
  maxDocuments?: number | undefined;
  policy?: DocumentUsePolicy | undefined;
  now?: (() => number) | undefined;
}

// Ids address a finite authorized set. A lookup cannot name a file the user never
// authorized, so traversal is not filtered here — it is unrepresentable.
export class AuthorizedDocumentStore {
  private readonly documents = new Map<string, AuthorizedDocument>();
  private readonly maxDocuments: number;
  private readonly policy: DocumentUsePolicy;
  private readonly now: () => number;
  private readonly stageInto: string | undefined;

  constructor(options: AuthorizedDocumentStoreOptions = {}) {
    this.maxDocuments = options.maxDocuments ?? DOCUMENT_LIMITS.maxDocuments;
    this.policy = options.policy ?? {};
    this.now = options.now ?? Date.now;
    this.stageInto = options.stageInto;
  }

  get size(): number {
    return this.documents.size;
  }

  async authorize(
    path: string,
    options: AuthorizeDocumentOptions = {},
  ): Promise<AuthorizedDocument> {
    const document = await authorizeDocument(path, {
      now: this.now,
      maxBytes: this.policy.maxBytes ?? DOCUMENT_LIMITS.maxUploadBytes,
      ...(this.stageInto === undefined ? {} : { stageInto: this.stageInto }),
      ...options,
    });
    this.add(document);
    return document;
  }

  add(document: AuthorizedDocument): void {
    const existing = this.documents.get(document.id);
    if (existing !== undefined && existing.path !== document.path) {
      throw new DocumentAuthorizationError(
        "id-conflict",
        `document id ${document.id} already refers to another file`,
      );
    }
    if (existing === undefined && this.documents.size >= this.maxDocuments) {
      throw new DocumentAuthorizationError(
        "store-full",
        `at most ${this.maxDocuments} documents may be authorized`,
      );
    }
    this.documents.set(document.id, document);
  }

  has(id: string): boolean {
    return this.documents.has(id);
  }

  // Everything model-facing goes through here: there is no field for a path.
  summaries(): AuthorizedDocumentSummary[] {
    return [...this.documents.values()].map(documentSummary);
  }

  summary(id: string): AuthorizedDocumentSummary | undefined {
    const document = this.documents.get(id);
    return document === undefined ? undefined : documentSummary(document);
  }

  ids(): AuthorizedDocumentId[] {
    return [...this.documents.values()].map((document) => document.id);
  }

  // Trusted runtime only. Callers that need validation use resolveForPurpose.
  path(id: AuthorizedDocumentId): string {
    const document = this.documents.get(id);
    if (document === undefined) {
      throw new DocumentAuthorizationError("unknown-id", `no authorized document ${id}`);
    }
    return document.path;
  }

  async resolveForPurpose(
    id: string,
    purpose: DocumentPurpose,
    policy: DocumentUsePolicy = {},
  ): Promise<DocumentUseResult> {
    const parsed = authorizedDocumentIdSchema.safeParse(id);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "invalid-id",
        message: "a document is addressed by its logical id, never by a path",
      };
    }
    const document = this.documents.get(parsed.data);
    if (document === undefined) {
      return { ok: false, reason: "unknown-id", message: `no authorized document ${parsed.data}` };
    }
    if (!document.purposes.includes(purpose)) {
      return {
        ok: false,
        reason: "wrong-purpose",
        message: `${document.basename} is not authorized for ${purpose}`,
      };
    }
    const maxBytes = policy.maxBytes ?? this.policy.maxBytes ?? DOCUMENT_LIMITS.maxUploadBytes;
    const allowedMimeTypes =
      purpose === "upload"
        ? (policy.allowedMimeTypes ?? this.policy.allowedMimeTypes ?? DEFAULT_UPLOAD_MIME_TYPES)
        : undefined;
    if (allowedMimeTypes !== undefined && !allowedMimeTypes.includes(document.mimeType)) {
      return {
        ok: false,
        reason: "unsupported-type",
        message: `${document.basename} is a ${document.mimeType}, which this field does not accept`,
      };
    }
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(document.path);
    } catch (error) {
      const code = errnoCode(error);
      const reason: DocumentRejectionReason =
        code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
      return { ok: false, reason, message: `${document.basename} is no longer readable` };
    }
    if (!stats.isFile()) {
      return {
        ok: false,
        reason: "not-a-file",
        message: `${document.basename} is no longer a file`,
      };
    }
    if (stats.size > maxBytes) {
      return {
        ok: false,
        reason: "too-large",
        message: `${document.basename} is ${stats.size} bytes, over the ${maxBytes} byte limit`,
      };
    }
    // Authorization covered the bytes that were hashed. Different bytes — a rewrite,
    // or a symlink repointed after authorization — are a different document.
    const sha256 = await hashFile(document.path);
    if (stats.size !== document.bytes || sha256 !== document.sha256) {
      return {
        ok: false,
        reason: "content-changed",
        message: `${document.basename} changed since it was authorized; re-authorize it`,
      };
    }
    return {
      ok: true,
      document: {
        id: document.id,
        path: document.path,
        basename: document.basename,
        mimeType: document.mimeType,
        bytes: document.bytes,
        sha256,
      },
    };
  }
}
