import { randomUUID } from "node:crypto";
// ARCHITECTURE §3. Async because it validates configuration, prepares private
// storage and constructs the runtime that owns the connection.
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentMessage, customMessage, type Profile, type SessionEnvironment } from "@mu/core";
import { AuthorizedDocumentStore, discoverWorkspaceDocuments } from "../artifacts/documents.ts";
import { BrowserArtifactStore } from "../artifacts/store.ts";
import { applicantSource, browserCommands } from "../commands/index.ts";
import type { BrowserCarryover } from "../contracts/carryover.ts";
import type { FactStore } from "../data/facts.ts";
import type { BrowserDriverFactory } from "../drivers/factory.ts";
import { taskAuthority } from "../policy/authority.ts";
import { withApprovedOrigin } from "../policy/origin.ts";
import { browserRenderers } from "../renderers/index.ts";
import { BrowserRuntime } from "../runtime/runtime.ts";
import type { BrowserTaskSession } from "../tools/session.ts";
import { browserDataDir, ensureBrowserDataRoot } from "./data.ts";
import {
  applicantFactsMessage,
  browserEnvironment,
  connectionMessage,
  documentsMessage,
  environmentMessage,
  taskUrlsFromMessages,
} from "./environment.ts";
import {
  type BrowserProfileOptions,
  type ResolvedBrowserProfileOptions,
  resolveBrowserProfileOptions,
} from "./options.ts";
import {
  BROWSER_PERMISSION_DEFAULTS,
  BROWSER_PERMISSION_MODES,
  DEFAULT_BROWSER_PERMISSION_MODE,
} from "./permissions.ts";
import { browserPrompt } from "./prompt.ts";
import { browserToolset } from "./tools.ts";

export const BROWSER_PROFILE_NAME = "browser";

export interface BrowserProfile extends Profile {
  runtime: BrowserRuntime;
  session: BrowserTaskSession;
  facts?: FactStore | undefined;
  documents: AuthorizedDocumentStore;
  artifacts: BrowserArtifactStore;
  options: ResolvedBrowserProfileOptions;
  dataRoot: string;
}

// Only used when a caller supplies no factory. It fails with an actionable
// message instead of silently doing nothing, because a driver that connects to
// nothing is worse than one that says why it cannot.
const unconfiguredFactory: BrowserDriverFactory = async (options) => {
  throw new Error(
    `No persistent browser driver is configured for ${options.browser}. Pass a driver factory, or use the fake driver for a deterministic session.`,
  );
};

export async function browserProfile(options: BrowserProfileOptions = {}): Promise<BrowserProfile> {
  const resolved = resolveBrowserProfileOptions(options);
  const home = options.home ?? homedir();
  const diagnostics: string[] = [];
  let dataRoot = options.dataRoot ?? browserDataDir(home);
  if (options.dataRoot === undefined) {
    try {
      dataRoot = await ensureBrowserDataRoot(home);
    } catch (error) {
      diagnostics.push(
        `could not prepare ${dataRoot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Eligible direct files in the launch directory are the product's local-file
  // capability. They are snapshotted inside Mu's root so later edits cannot silently
  // change the bytes the user made available, and so the browser bridge never receives
  // broad filesystem access.
  const documents = new AuthorizedDocumentStore({ stageInto: join(dataRoot, "documents") });
  const documentProblems: { path: string; message: string }[] = [];
  const documentPaths = [...resolved.documents];
  if (resolved.workspaceRoot !== undefined) {
    try {
      const discovered = await discoverWorkspaceDocuments(resolved.workspaceRoot);
      documentPaths.push(...discovered.paths);
      documentProblems.push(...discovered.problems);
    } catch (error) {
      diagnostics.push(
        `could not inspect the launch directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const runtime = new BrowserRuntime({
    factory: options.factory ?? unconfiguredFactory,
    // Read on connect: authorization happens after this runtime is built.
    documents: () => documents.entries(),
    connection: resolved.connection,
    browser: resolved.browser,
    dataRoot,
    headless: resolved.headless,
    ...(resolved.userDataDir === undefined ? {} : { userDataDir: resolved.userDataDir }),
  });

  for (const path of [...new Set(documentPaths)]) {
    try {
      await documents.authorize(path, { purposes: ["reference", "upload"] });
    } catch (error) {
      // A document the user asked for and did not get must be visible, not silent.
      diagnostics.push(
        `could not authorize ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const environment: SessionEnvironment = browserEnvironment({
    options: resolved,
    dataRoot,
    documentCount: documents.size,
  });

  const loadApplicant = applicantSource(resolved.applicantProfile);
  const applicant = await loadApplicant();
  if (applicant.problem !== undefined) {
    diagnostics.push(`could not load applicant profile: ${applicant.problem}`);
  }

  const artifacts = new BrowserArtifactStore({
    root: resolved.artifactRoot ?? join(dataRoot, "artifacts"),
  });
  const { tools, session } = browserToolset({
    runtime,
    allowedOrigins: resolved.allowedOrigins ?? [],
    ...(applicant.facts === undefined ? {} : { facts: applicant.facts }),
    ...(applicant.facts === undefined ? {} : { applicantPolicy: applicant.facts.policy() }),
    ...(documents.size > 0 ? { documents } : {}),
    receipts: {
      // One profile is built per Mu session, so this identifies the session that
      // produced the receipt without the profile having to reach for the agent's id.
      sessionId: randomUUID(),
      store: artifacts,
    },
  });

  return {
    name: BROWSER_PROFILE_NAME,
    toolset: tools,
    promptFor: browserPrompt,
    permissionDefaults: BROWSER_PERMISSION_DEFAULTS,
    permissionModes: BROWSER_PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_BROWSER_PERMISSION_MODE,
    renderers: browserRenderers,
    commands: browserCommands({
      session,
      options: resolved,
      dataRoot,
      sources: {
        applicant: loadApplicant,
        documents: async () => ({
          documents: documents.summaries(),
          problems: [...documentProblems],
        }),
      },
    }),
    environment: () => environment,
    contextMessages: (): AgentMessage[] => [
      environmentMessage(environment),
      connectionMessage(runtime.description, resolved.connection),
      documentsMessage(documents.summaries()),
      ...(applicant.facts === undefined ? [] : [applicantFactsMessage(applicant.facts)]),
    ],
    refreshContext: (messages): AgentMessage[] => {
      let origins = session.policy.origins;
      const added: string[] = [];
      for (const url of taskUrlsFromMessages(messages)) {
        const next = withApprovedOrigin(
          origins,
          url,
          taskAuthority({ reason: "origin explicitly named in the user's task" }),
        );
        if (next !== origins) {
          origins = next;
          added.push(new URL(url).origin);
        }
      }
      if (added.length === 0) return [];
      session.setPolicy({ ...session.policy, origins });
      return [
        customMessage(
          "browser-task-origins",
          `The user explicitly named these task origins, so they are authorized for navigation: ${[
            ...new Set(added),
          ].join(", ")}`,
        ),
      ];
    },
    diagnostics,
    // What compaction must not lose: where the browser is, what was already done
    // to the page, and what is still owed. Labels, ids and origins only — no
    // values, so the carryover is safe to persist (BD22).
    carryoverExtractor: (): BrowserCarryover => session.carryover(),
    // Sessions group under the connection they were run against, inside the
    // browser product's own session root.
    scope: () => `${resolved.connection}-${resolved.browser}`,
    // No checkpoint provider, deliberately. A submitted form, a sent message or a
    // deleted record cannot be rolled back, and claiming otherwise would make
    // /undo a lie (BD17).
    runtime,
    session,
    ...(applicant.facts === undefined ? {} : { facts: applicant.facts }),
    documents,
    artifacts,
    options: resolved,
    dataRoot,
  };
}
