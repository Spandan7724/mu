// The browser product's own commands (DESIGN §Commands). Connection, tabs, takeover,
// resume, disconnect, documents, applicant profile and receipts — the state a user
// needs on demand rather than only when the model happens to mention it.
//
// Every one answers with data that exists. Where a source is not configured the
// command says so and names what to configure; it never prints a shape with nothing
// in it.
import type { Command } from "@mu/core";
import { redactFactValue } from "../contracts/applicant.ts";
import { connectionSummary } from "../contracts/connection.ts";
import { isBrowserDriverError } from "../contracts/driver.ts";
import { RECEIPT_STATUS_SUMMARY, receiptNeedsReview } from "../contracts/receipt.ts";
import { type TakeoverReason, takeoverReasonSchema } from "../contracts/takeover.ts";
import { factValueText } from "../data/facts.ts";
import { takeoverInstructions } from "../policy/takeover.ts";
import type { ResolvedBrowserProfileOptions } from "../profile/options.ts";
import { renderResumeReport, renderTakeoverCell } from "../renderers/takeover.ts";
import {
  bytesLabel,
  clampLine,
  countLabel,
  joinParts,
  safeLines,
  shaPrefix,
} from "../renderers/text.ts";
import type { BrowserRuntime } from "../runtime/runtime.ts";
import { phaseSummary } from "../runtime/state.ts";
import type { BrowserTaskSession } from "../tools/session.ts";
import {
  applicantSource,
  type BrowserCommandSources,
  documentSource,
  latestReceipts,
  receiptSource,
} from "./sources.ts";

const MAX_LISTED_RECEIPTS = 10;

/**
 * The TUI surface registers its own `/resume` for session resume after profile
 * commands, so a browser `/resume` would be shadowed by it. The capability keeps a
 * name of its own and stays reachable as `/browser resume` too, which is the
 * spelling TOOLS.md uses.
 */
export const BROWSER_RESUME_COMMAND = "resume-browser";

function describe(error: unknown): string {
  if (isBrowserDriverError(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function lines(values: readonly (string | undefined)[]): string {
  return safeLines(
    values.filter((value): value is string => value !== undefined && value.length > 0),
    [],
    "a browser command",
  ).join("\n");
}

function parseTakeoverReason(value: string): TakeoverReason {
  const parsed = takeoverReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : "user-requested";
}

export interface BrowserCommandsOptions {
  session: BrowserTaskSession;
  options: ResolvedBrowserProfileOptions;
  dataRoot: string;
  /** Overridable so a test or an embedding host can supply its own data. */
  sources?: Partial<BrowserCommandSources> | undefined;
}

export function browserCommands(context: BrowserCommandsOptions): Command[] {
  const { session, options, dataRoot } = context;
  const runtime = session.runtime;
  const takeover = session.takeoverController;
  const sources: BrowserCommandSources = {
    documents: context.sources?.documents ?? documentSource(options.documents),
    applicant: context.sources?.applicant ?? applicantSource(options.applicantProfile),
    receipts: context.sources?.receipts ?? receiptSource(dataRoot, options.artifactRoot),
  };

  const report = (): string => {
    const state = runtime.status();
    return lines([
      connectionSummary(state),
      phaseSummary(state.phase),
      joinParts(["connection", runtime.description]),
      joinParts(["shutdown", "closes the browser Mu owns; its persistent profile remains on disk"]),
      joinParts(["permission mode", "see /permissions"]),
      joinParts(["data root", dataRoot]),
      joinParts([
        "allowed origins",
        options.allowedOrigins.length === 0
          ? "none beyond the task's own origin"
          : options.allowedOrigins.join(", "),
      ]),
      takeover.state === undefined
        ? undefined
        : joinParts(["paused", "you have the browser", `/${BROWSER_RESUME_COMMAND} to continue`]),
      state.message,
    ]);
  };

  const listTabs = async (select?: string): Promise<string> => {
    const controller = new AbortController();
    try {
      const outcome = await runtime.use(
        (driver) =>
          select === undefined || select.length === 0
            ? driver.tabs({ kind: "list" }, controller.signal)
            : driver.tabs({ kind: "select", tabId: select }, controller.signal),
        controller.signal,
      );
      if (outcome.tabs.length === 0) return "No tabs are attached.";
      return lines([
        countLabel(outcome.tabs.length, "controlled tab"),
        ...outcome.tabs.map((tab) =>
          joinParts([
            tab.active ? "active" : "background",
            tab.id,
            tab.title,
            tab.url,
            tab.attached ? undefined : "not attached",
          ]),
        ),
        joinParts(["/tabs <id>", "to make one active"]),
      ]);
    } catch (error) {
      return `could not list tabs — ${describe(error)}`;
    }
  };

  const beginTakeover = async (reason: TakeoverReason, note: string): Promise<string> => {
    if (takeover.active) {
      return lines([
        "automation is already paused",
        ...renderTakeoverCell(takeover.state as NonNullable<typeof takeover.state>),
      ]);
    }
    const state = runtime.status();
    const instructions = note.length > 0 ? note : takeoverInstructions(reason);
    try {
      await runtime.takeover(reason, instructions);
    } catch (error) {
      return `could not pause — ${describe(error)}`;
    }
    // The runtime publishes a connection phase and an active tab id, not a URL, so
    // the task's own origin is the most specific destination available here.
    session.beginTakeover({
      reason,
      tabId: state.activeTabId ?? "the active tab",
      url: options.allowedOrigins[0] ?? "the page in your browser",
      instructions,
      startedAt: Date.now(),
    });
    const recorded = session.takeover;
    if (recorded === undefined) return "could not record browser takeover state";
    return lines([
      phaseSummary("takeover"),
      ...renderTakeoverCell(recorded, {
        expanded: true,
        resumeCommand: `/${BROWSER_RESUME_COMMAND}`,
      }),
    ]);
  };

  const resume = async (): Promise<string> => {
    const controller = new AbortController();
    let observation: Awaited<ReturnType<BrowserRuntime["resume"]>>;
    try {
      observation = await runtime.resume(controller.signal);
    } catch (error) {
      return `could not resume — ${describe(error)}`;
    }
    if (!takeover.active) {
      return lines([
        joinParts(["resumed", observation.url, `revision ${observation.revision}`]),
        "the page was observed again; every earlier reference is stale",
      ]);
    }
    try {
      return lines(renderResumeReport(session.resumeTakeover(observation)));
    } catch (error) {
      return `could not resume — ${describe(error)}`;
    }
  };

  const disconnect = async (): Promise<string> => {
    try {
      await runtime.shutdown();
    } catch (error) {
      return `could not disconnect cleanly — ${describe(error)}`;
    }
    return "Closed the browser Mu owns. Its profile directory is untouched.";
  };

  const documents = async (): Promise<string> => {
    const load = await sources.documents();
    if (load.documents.length === 0 && load.problems.length === 0) {
      return lines([
        "No uploadable documents were found in the launch directory.",
        "Put the file directly in that directory and start a new session.",
      ]);
    }
    return lines([
      countLabel(load.documents.length, "launch-directory document"),
      ...load.documents.map((document) =>
        joinParts([
          document.id,
          document.basename,
          document.mimeType,
          bytesLabel(document.bytes),
          `sha256 ${shaPrefix(document.sha256)}`,
          document.purposes.join("+"),
        ]),
      ),
      ...load.problems.map((problem) =>
        joinParts(["not available", problem.path, problem.message]),
      ),
      "The model sees these ids and this metadata; it never sees a path.",
    ]);
  };

  /**
   * SECURITY §7/§11: values are shown by sensitivity — sensitive ones stay withheld
   * here and are visible only in the browser — and a credential can never be in the
   * store to print, because `FactStore` refuses to admit one.
   */
  const applicantProfile = async (): Promise<string> => {
    const load = await sources.applicant();
    if (!load.configured) {
      return lines([
        "No applicant profile is configured.",
        "Point at one with --applicant-profile <absolute path> to ground personal answers.",
      ]);
    }
    if (load.problem !== undefined || load.facts === undefined) {
      return lines([
        joinParts(["could not read the applicant profile", load.path]),
        load.problem ?? "the file could not be parsed",
      ]);
    }
    const store = load.facts;
    const facts = store.all();
    const uncertain = facts.filter((fact) => fact.confidence === "uncertain");
    const ungrounded = facts.filter((fact) => !store.trace(fact).grounded);
    const policy = store.policy();
    const unanswered = (
      [
        ["work authorization", policy.workAuthorizationFactId],
        ["sponsorship", policy.sponsorshipFactId],
        ["relocation", policy.relocationFactId],
        ["desired salary", policy.compensationFactId],
      ] as const
    )
      .filter(([, id]) => id === undefined)
      .map(([name]) => name);
    return lines([
      joinParts([countLabel(facts.length, "fact"), load.path]),
      ...facts.map((fact) => {
        const value = redactFactValue(fact);
        const trace = store.trace(fact);
        return joinParts([
          fact.field,
          fact.sensitivity === "sensitive"
            ? "withheld · shown in the browser only"
            : factValueText(value),
          fact.sensitivity,
          fact.confidence,
          trace.userStated ? "you told Mu" : undefined,
          trace.documentIds.length === 0 ? undefined : `from ${trace.documentIds.join(", ")}`,
        ]);
      }),
      unanswered.length === 0
        ? "every consequential policy answer is set"
        : joinParts(["unanswered policy answers", unanswered.join(", ")]),
      uncertain.length === 0
        ? undefined
        : joinParts(["uncertain", uncertain.map((fact) => fact.field).join(", ")]),
      ungrounded.length === 0
        ? undefined
        : joinParts(["no longer grounded", ungrounded.map((fact) => fact.field).join(", ")]),
      "Sensitive values are never printed here; check them in the browser before submitting.",
    ]);
  };

  const receipt = async (id: string): Promise<string> => {
    const store = sources.receipts();
    try {
      if (id.length > 0) {
        const found = await store.readReceipt(id);
        if (found === undefined) return `No receipt ${id} under ${store.directory("receipt")}.`;
        return lines([
          joinParts([found.id, found.status, RECEIPT_STATUS_SUMMARY[found.status]]),
          joinParts([found.intent, found.origin, found.completedAt]),
          joinParts(["started at", found.startedUrl]),
          joinParts(["ended at", found.finalUrl]),
          found.externalId === undefined ? undefined : joinParts(["external id", found.externalId]),
          found.confirmationText === undefined
            ? undefined
            : joinParts(["the site said", clampLine(found.confirmationText, 300)]),
          found.disclosedFields.length === 0
            ? undefined
            : joinParts(["fields disclosed", found.disclosedFields.join(", ")]),
          found.uploadedFiles.length === 0
            ? undefined
            : joinParts(["documents", found.uploadedFiles.map((file) => file.basename).join(", ")]),
          joinParts(["file", `${store.directory("receipt")}/${found.id}.json`]),
          receiptNeedsReview(found.status)
            ? "Mu will not repeat this action. Check the site before doing so yourself."
            : undefined,
        ]);
      }
      const recent = await latestReceipts(store, MAX_LISTED_RECEIPTS);
      if (recent.length === 0) {
        return lines([
          "No receipts yet.",
          `They are written to ${store.directory("receipt")} once an action commits.`,
        ]);
      }
      return lines([
        countLabel(recent.length, "recent receipt"),
        ...recent.map((found) =>
          joinParts([found.id, found.status, found.intent, found.origin, found.completedAt]),
        ),
        "/receipt <id> for the whole record",
      ]);
    } catch (error) {
      return `could not read receipts — ${describe(error)}`;
    }
  };

  const usage = lines([
    "Usage: /browser [status|connect|reconnect|disconnect|tabs|takeover [reason]|resume]",
  ]);

  return [
    {
      name: "browser",
      description: "Show the browser connection, or connect, take over, resume, disconnect",
      run: async (ctx) => {
        const [verb = "status", ...rest] = ctx.args.trim().split(/\s+/).filter(Boolean);
        const argument = rest.join(" ");
        const controller = new AbortController();
        try {
          switch (verb) {
            case "status":
              return { handled: true, message: report() };
            case "connect":
              await runtime.connect(controller.signal);
              return { handled: true, message: report() };
            case "reconnect":
              await runtime.reconnect(controller.signal);
              return { handled: true, message: report() };
            case "disconnect":
              return { handled: true, message: await disconnect() };
            case "tabs":
              return { handled: true, message: await listTabs(argument) };
            case "takeover":
              return {
                handled: true,
                message: await beginTakeover(parseTakeoverReason(argument), ""),
              };
            case "resume":
              return { handled: true, message: await resume() };
            default:
              return { handled: true, message: usage };
          }
        } catch (error) {
          return {
            handled: true,
            message: `${report()}\n\ncould not connect — ${describe(error)}`,
          };
        }
      },
    },
    {
      name: "tabs",
      description: "List the tabs Mu controls, or select one",
      run: async (ctx) => ({ handled: true, message: await listTabs(ctx.args.trim()) }),
    },
    {
      name: "takeover",
      description: "Pause automation and take manual control of the browser",
      run: async (ctx) => {
        const argument = ctx.args.trim();
        const first = argument.split(/\s+/)[0] ?? "";
        const reason = takeoverReasonSchema.safeParse(first);
        return {
          handled: true,
          message: await beginTakeover(
            reason.success ? reason.data : "user-requested",
            reason.success ? argument.slice(first.length).trim() : argument,
          ),
        };
      },
    },
    {
      name: BROWSER_RESUME_COMMAND,
      description: "Re-observe the page and hand control back to the agent after a takeover",
      run: async () => ({ handled: true, message: await resume() }),
    },
    {
      name: "disconnect",
      description: "End browser access without deleting any browser data",
      run: async () => ({ handled: true, message: await disconnect() }),
    },
    {
      name: "documents",
      description: "List the documents authorized for reference and upload",
      run: async () => ({ handled: true, message: await documents() }),
    },
    {
      name: "profile",
      description: "Show applicant facts, their provenance, and what is still unanswered",
      run: async () => ({ handled: true, message: await applicantProfile() }),
    },
    {
      name: "receipt",
      description: "Show the latest action receipts, or one by id",
      run: async (ctx) => ({ handled: true, message: await receipt(ctx.args.trim()) }),
    },
  ];
}

export * from "./sources.ts";
