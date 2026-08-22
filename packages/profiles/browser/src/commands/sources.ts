// Where `/documents`, `/profile` and `/receipt` get their answers. Each source is
// derived from configuration the profile already resolved — the authorized document
// paths, the applicant profile file, the artifact root — so the commands report real
// state rather than a placeholder. A source that has nothing configured says so;
// none of them invents an answer.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthorizedDocumentStore } from "../artifacts/documents.ts";
import { BrowserArtifactStore } from "../artifacts/store.ts";
import { type ApplicantProfile, applicantProfileSchema } from "../contracts/applicant.ts";
import type { AuthorizedDocumentSummary } from "../contracts/documents.ts";
import type { BrowserReceipt } from "../contracts/receipt.ts";
import { createFactStore, type FactStore } from "../data/facts.ts";

export interface DocumentLoad {
  documents: AuthorizedDocumentSummary[];
  /** Paths that were configured but could not be authorized, with the reason. */
  problems: { path: string; message: string }[];
}

export interface ApplicantProfileLoad {
  configured: boolean;
  path?: string | undefined;
  facts?: FactStore | undefined;
  problem?: string | undefined;
}

export interface BrowserCommandSources {
  documents: () => Promise<DocumentLoad>;
  applicant: () => Promise<ApplicantProfileLoad>;
  receipts: () => BrowserArtifactStore;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Documents are authorized lazily and then cached: hashing a résumé on every
 * `/documents` is wasteful, and re-hashing would also let a file swapped underneath
 * Mu silently become the authorized one.
 */
export function documentSource(paths: readonly string[]): () => Promise<DocumentLoad> {
  let loaded: DocumentLoad | undefined;
  return async () => {
    if (loaded !== undefined) return loaded;
    const store = new AuthorizedDocumentStore();
    const problems: DocumentLoad["problems"] = [];
    for (const path of paths) {
      try {
        await store.authorize(path);
      } catch (error) {
        problems.push({ path, message: describe(error) });
      }
    }
    loaded = { documents: store.summaries(), problems };
    return loaded;
  };
}

/**
 * The saved applicant profile is replayed through `FactStore.adopt`, so every
 * admission guard applies again: a persisted file cannot reintroduce a credential
 * or a non-mechanical inference just by having been written to disk.
 */
export function applicantSource(path: string | undefined): () => Promise<ApplicantProfileLoad> {
  let loaded: ApplicantProfileLoad | undefined;
  return async () => {
    if (loaded !== undefined) return loaded;
    if (path === undefined) {
      loaded = { configured: false };
      return loaded;
    }
    try {
      const raw = await readFile(path, "utf8");
      const parsed = applicantProfileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        loaded = {
          configured: true,
          path,
          problem: parsed.error.issues[0]?.message ?? "the file is not a valid applicant profile",
        };
        return loaded;
      }
      const profile = parsed.data as ApplicantProfile;
      loaded = {
        configured: true,
        path,
        facts: createFactStore({
          facts: profile.facts,
          policy: profile.policy,
          documents: profile.documents,
        }),
      };
    } catch (error) {
      loaded = { configured: true, path, problem: describe(error) };
    }
    return loaded;
  };
}

export function receiptSource(
  dataRoot: string,
  artifactRoot: string | undefined,
): () => BrowserArtifactStore {
  let store: BrowserArtifactStore | undefined;
  return () => {
    store ??= new BrowserArtifactStore({ root: artifactRoot ?? join(dataRoot, "artifacts") });
    return store;
  };
}

/** Newest first: the receipt a user asks about is almost always the last one. */
export async function latestReceipts(
  store: BrowserArtifactStore,
  limit: number,
): Promise<BrowserReceipt[]> {
  const entries = await store.list("receipt");
  const receipts: BrowserReceipt[] = [];
  for (const entry of entries.slice(-limit).reverse()) {
    if (!entry.name.endsWith(".json")) continue;
    const receipt = await store.readReceipt(entry.name.slice(0, -".json".length));
    if (receipt !== undefined) receipts.push(receipt);
  }
  return receipts;
}
