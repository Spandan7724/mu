// browser_upload — TOOLS.md's dedicated upload path (BD16). The model names a document
// only by its authorized logical id; `artifacts/documents.ts` is the sole place an id
// becomes a path, and it revalidates existence, declared purpose, type and size, and
// re-hashes to catch bytes that changed since authorization. A document that fails any
// of that never reaches the driver, and neither does the rest of the batch alongside it.
import type { ToolPermissionDetails, ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import type { ResolvedDocument } from "../artifacts/documents.ts";
import type { UploadRequest } from "../contracts/actions.ts";
import { acceptsModelActions } from "../contracts/connection.ts";
import { browserElementRefSchema } from "../contracts/observation.ts";
import { authorizedDocumentIdSchema } from "../contracts/primitives.ts";
import { decideUploadRequest } from "../policy/decide.ts";
import { uploadPattern } from "../policy/scopes.ts";
import { phaseSummary } from "../runtime/state.ts";
import type { BrowserToolContext, BrowserToolDetails } from "./context.ts";
import { toolErrorText } from "./errors.ts";
import { observationFacts, observationHeadline, observationText, outcomeText } from "./render.ts";
import type { ObservationRecord } from "./session.ts";

export const BROWSER_UPLOAD_TOOL = "browser_upload";

/**
 * The shared browser context plus the one thing this tool needs that no other tool
 * does: the authorized-document store BD16 resolves every id through. Extending rather
 * than widening `BrowserToolContext` keeps `context.ts` untouched.
 */
export type BrowserUploadToolContext = BrowserToolContext;

const schema = z
  .object({
    target: browserElementRefSchema.describe("The file input, from the latest observation."),
    documentIds: z
      .array(authorizedDocumentIdSchema)
      .min(1)
      .max(20)
      .describe("Ids from the session's launch-directory document set. Never a filesystem path."),
  })
  .strict();

type Args = z.infer<typeof schema>;

function recordFor(context: BrowserUploadToolContext, args: Args): ObservationRecord | undefined {
  return context.session.record(args.target.tabId);
}

function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

function fieldLabel(record: ObservationRecord | undefined, args: Args): string {
  const element = record?.targets.get(args.target.ref)?.element;
  return element?.label ?? element?.name ?? "unresolved";
}

function basenamesOf(context: BrowserUploadToolContext, args: Args): string {
  return args.documentIds
    .map((id) => context.session.documents?.summary(id)?.basename ?? id)
    .join(" ");
}

function previewLines(
  context: BrowserUploadToolContext,
  record: ObservationRecord | undefined,
  args: Args,
): string[] {
  const lines = [
    `origin: ${record?.observation.origin ?? "unknown"}`,
    `page: ${record?.observation.title ?? "not observed yet"}`,
    `field: ${fieldLabel(record, args)}`,
  ];
  for (const id of args.documentIds) {
    const summary = context.session.documents?.summary(id);
    lines.push(
      summary === undefined
        ? `document: ${id} is not an authorized document`
        : `document: ${summary.basename} · ${summary.mimeType} · ${summary.bytes} bytes · sha256 ${shortHash(summary.sha256)}`,
    );
  }
  lines.push("this does not submit the form");
  return lines;
}

export function browserUploadTool(context: BrowserUploadToolContext) {
  const { session } = context;
  session.configureResources({ documents: context.documents });
  const documents = session.documents;
  if (documents === undefined) {
    throw new TypeError("browser_upload requires documents owned by the task session");
  }

  return tool({
    name: BROWSER_UPLOAD_TOOL,
    description:
      "Attach a document from the launch directory to a file input, by document id. You never name or see a filesystem path — use only ids listed in the session context. This does not submit the form; use browser_submit for that once the form is ready.",
    inputSchema: schema,
    executionMode: "sequential",
    isConcurrencySafe: () => false,
    changesState: true,
    permissionScope: (args) => {
      const record = recordFor(context, args);
      if (record === undefined) return "browser:upload";
      const decision = decideUploadRequest(session.policy, {
        target: args.target,
        basenames: args.documentIds.map((id) => documents.summary(id)?.basename ?? id),
        observation: record.observation,
      });
      return decision.kind === "permission"
        ? (decision.scopes[0] ?? "browser:upload")
        : "browser:upload";
    },
    permissionPattern: (args) =>
      uploadPattern(recordFor(context, args)?.observation.origin, basenamesOf(context, args)),
    permissionDetails: (args): ToolPermissionDetails => {
      const record = recordFor(context, args);
      return {
        description: `upload to ${uploadPattern(record?.observation.origin, basenamesOf(context, args))}`,
        preview: { kind: "text", lines: previewLines(context, record, args) },
      };
    },
    execute: async (args, { signal }): Promise<ToolResult> => {
      try {
        const phase = session.runtime.status().phase;
        if (!acceptsModelActions(phase)) {
          return {
            content: [{ type: "text", text: `The browser is not ready: ${phaseSummary(phase)}.` }],
            isError: true,
          };
        }

        // Resolve against the observation the model was actually handed, never a fresh
        // one. Re-observing here and then checking the old reference against the new
        // record is how a stale reference silently retargets to whatever now occupies
        // that position — precisely what ARCHITECTURE §8 forbids.
        const record = session.record(args.target.tabId);
        if (record === undefined) {
          return {
            content: [{ type: "text", text: "Observe the page before attaching a document." }],
            isError: true,
          };
        }

        const resolution = session.resolve(args.target, record);
        if (resolution.kind === "stale") {
          session.note({
            tool: BROWSER_UPLOAD_TOOL,
            action: "upload",
            outcome: resolution.validity,
          });
          return {
            content: [
              {
                type: "text",
                text: `${resolution.message} The page is now at revision ${record.revision}; call browser_observe and use a reference from that observation.`,
              },
            ],
            isError: true,
          };
        }

        // BD16: every id is resolved and revalidated here — inside the trusted runtime,
        // after permission and before the driver ever sees it. One bad id fails the
        // whole batch rather than silently dropping it.
        const resolved: ResolvedDocument[] = [];
        for (const id of args.documentIds) {
          const outcome = await documents.resolveForPurpose(id, "upload");
          if (!outcome.ok) {
            session.note({
              tool: BROWSER_UPLOAD_TOOL,
              action: "upload",
              outcome: "refused",
              detail: outcome.reason,
            });
            return {
              content: [{ type: "text", text: `Cannot upload ${id}: ${outcome.message}` }],
              isError: true,
            };
          }
          resolved.push(outcome.document);
        }

        const decision = decideUploadRequest(session.policy, {
          target: args.target,
          basenames: resolved.map((document) => document.basename),
          observation: record.observation,
        });
        if (decision.kind === "stale" || decision.kind === "deny") {
          session.note({ tool: BROWSER_UPLOAD_TOOL, action: "upload", outcome: "refused" });
          return { content: [{ type: "text", text: decision.message }], isError: true };
        }

        const driverRequest: UploadRequest = {
          target: resolution.target.driverRef,
          documentIds: args.documentIds,
        };
        const outcome = await session.use((driver) => driver.upload(driverRequest, signal), signal);

        // A material page change (the file input now shows attached names) mints a new
        // revision on its own via the observation digest; navigation invalidates on top
        // of that, same as every other mutating tool.
        if (outcome.navigation !== undefined) session.invalidate(record.tabId);
        const after = await session.observe({ tabId: record.tabId }, signal);
        if (outcome.ok) session.recordUploadedDocuments(args.documentIds);

        const scope = "browser:upload" as const;
        const pattern = uploadPattern(
          record.observation.origin,
          resolved.map((document) => document.basename).join(" "),
        );
        session.note({
          tool: BROWSER_UPLOAD_TOOL,
          action: "upload",
          tabId: after.tabId,
          url: after.observation.url,
          ...(after.observation.origin === undefined ? {} : { origin: after.observation.origin }),
          revision: after.revision,
          outcome: outcome.status,
          scope,
          pattern,
        });

        const details: BrowserToolDetails = {
          kind: "action",
          tool: BROWSER_UPLOAD_TOOL,
          action: "upload",
          status: outcome.status,
          tabId: after.tabId,
          url: after.observation.url,
          navigated: outcome.navigation !== undefined,
          scope,
          pattern,
        };

        return {
          content: [
            {
              type: "text",
              text: [
                outcomeText(outcome),
                outcome.ok
                  ? `Attached: ${resolved.map((document) => document.basename).join(", ")}. This does not submit the form.`
                  : "",
                "",
                observationHeadline(after),
                ...observationFacts(after),
                "",
                observationText(after),
              ]
                .filter((line) => line.length > 0 || line === "")
                .join("\n"),
            },
          ],
          details,
          ...(outcome.ok ? {} : { isError: outcome.status === "failed" }),
        };
      } catch (error) {
        session.note({ tool: BROWSER_UPLOAD_TOOL, action: "upload", outcome: "error" });
        return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
      }
    },
  });
}
