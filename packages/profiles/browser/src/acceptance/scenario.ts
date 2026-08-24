// B7's acceptance scenario: one job application, start to finish.
//
// It drives the shipped tools rather than the driver, because what B7 has to prove is
// a property of the product, not of the adapter — that every value reaching a server
// traces to a source, that only the authorized document is uploaded, and that exactly
// one submission happens. A scenario that called the driver directly would prove none
// of that, since the tools are where grounding, disclosure and the commitment ledger
// live.
//
// The model is replaced by a deterministic script. That is deliberate: a model would
// make this a measurement of the model, and the properties here must hold for any
// caller of the tools.
import type { ToolResult } from "@mu/core";
import type { ApplicantPolicy } from "../contracts/applicant.ts";
import type { AuthorizedDocument } from "../contracts/documents.ts";
import type { BrowserElement, BrowserObservation } from "../contracts/observation.ts";
import type { AuthorizedDocumentId } from "../contracts/primitives.ts";
import type { FactLookup } from "../data/facts.ts";
import { type FillPlan, planFill } from "../data/plan.ts";
import { createQuestionQueue } from "../data/questions.ts";
import { browserActTool } from "../tools/act.ts";
import { browserNavigateTool } from "../tools/navigate.ts";
import { browserObserveTool } from "../tools/observe.ts";
import type { ObservationRecord } from "../tools/session.ts";
import { browserSubmitTool } from "../tools/submit.ts";
import { type BrowserUploadToolContext, browserUploadTool } from "../tools/upload.ts";

export interface ScenarioContext extends BrowserUploadToolContext {
  facts: FactLookup;
  policy: ApplicantPolicy;
}

export interface ScenarioStep {
  what: string;
  ok: boolean;
  detail: string;
}

export interface ScenarioLog {
  steps: ScenarioStep[];
  /** Every fill the plan grounded, across every step of the form. */
  plans: FillPlan[];
  /** Every page the form was filled across, for attributing what the server received. */
  observed: BrowserObservation[];
  /** Questions the plan raised rather than guessing an answer. */
  unanswered: string[];
}

function textOf(result: ToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("\n");
}

/** A control the fill plan can drive, by the action its role implies. */
function actionFor(element: BrowserElement): "fill" | "select" | "check" | "click" {
  const role = element.role ?? "";
  // Options, not the role, decide this. A combobox backed by a datalist is a text
  // field with suggestions, and `select` on it has nothing to choose from.
  const selectable = (element.options ?? []).length > 0;
  if (
    selectable &&
    (role === "combobox" || role === "listbox" || role === "menu" || role === "radiogroup")
  ) {
    return "select";
  }
  if (role === "checkbox" || role === "switch" || element.inputType === "checkbox") return "check";
  if (role === "radio" || element.inputType === "radio") return "click";
  return "fill";
}

export interface ApplyOptions {
  context: ScenarioContext;
  url: string;
  signal: AbortSignal;
  /** Answers the user typed, for fields no fact or policy can ground. */
  answers?: Readonly<Record<string, string>>;
  /** Document ids to attach to the first file input on a step. */
  documentIds?: readonly AuthorizedDocumentId[];
  log: ScenarioLog;
}

/**
 * Fills every control on the current page that the plan can ground, and nothing else.
 * A field with no fact, no policy and no user answer is left empty on purpose — that
 * is the property B7 exists to demonstrate, so it is never quietly filled here.
 */
export async function fillCurrentStep(options: ApplyOptions): Promise<ObservationRecord> {
  const { context, signal, log } = options;
  const observe = browserObserveTool(context);
  const act = browserActTool(context);

  await observe.execute("observe", {}, signal);
  let record = context.session.record();
  if (record === undefined) throw new Error("the page was not observed");

  const plan = planFill({
    url: record.observation.url,
    elements: record.observation.elements,
    facts: context.facts,
    policy: context.policy,
    questions: createQuestionQueue(),
  });
  log.plans.push(plan);
  log.observed.push(record.observation);
  const suppliedAnswers = new Set(Object.keys(options.answers ?? {}));
  for (const question of plan.questions) {
    if (!suppliedAnswers.has(question.field) && !suppliedAnswers.has(question.label)) {
      log.unanswered.push(question.field);
    }
  }

  for (const fill of plan.fills) {
    let element = record.observation.elements.find((entry) => entry.ref === fill.ref.ref);
    if (element === undefined) continue;
    // A radio group with no options of its own is answered by clicking the member
    // whose label is the answer; the group itself accepts nothing.
    const grouped = element.role === "radiogroup" || element.role === "group";
    if (grouped && (element.options ?? []).length === 0) {
      const option = record.observation.elements.find(
        (entry) =>
          (entry.role === "radio" || entry.inputType === "radio") &&
          (entry.label ?? entry.name ?? "").toLowerCase() === fill.text.toLowerCase(),
      );
      if (option === undefined) {
        log.steps.push({
          what: `answer ${fill.label}`,
          ok: false,
          detail: `no radio labelled "${fill.text}" in this group`,
        });
        continue;
      }
      element = option;
    }
    const action = actionFor(element);
    const target = { ref: element.ref, revision: element.revision, tabId: element.tabId };
    const args =
      action === "select"
        ? { action, target, values: [fill.text] }
        : action === "check" || action === "click"
          ? { action, target }
          : { action, target, value: fill.text, sourceFactId: fill.factId };
    const result = await act.execute(`fill-${fill.field}`, args, signal);
    log.steps.push({
      what: `${action} ${fill.label}`,
      ok: result.isError !== true,
      detail: textOf(result),
    });
    // Filling changes the page; the next reference must come from a fresh observation.
    await observe.execute("observe", {}, signal);
    record = context.session.record() ?? record;
  }

  // Answers the user typed are applied after the grounded ones, so a typed answer
  // never silently overwrites something with provenance.
  for (const [field, value] of Object.entries(options.answers ?? {})) {
    const element = record.observation.elements.find(
      (entry) => entry.name === field || entry.label === field,
    );
    if (element === undefined) continue;
    const target = { ref: element.ref, revision: element.revision, tabId: element.tabId };
    const action = actionFor(element);
    const args =
      action === "select"
        ? { action, target, values: [value] }
        : action === "check" || action === "click"
          ? { action, target }
          : { action, target, value };
    const result = await act.execute(`answer-${field}`, args, signal);
    log.steps.push({
      what: `answer ${field}`,
      ok: result.isError !== true,
      detail: textOf(result),
    });
    await observe.execute("observe", {}, signal);
    record = context.session.record() ?? record;
  }

  if (options.documentIds !== undefined && options.documentIds.length > 0) {
    const upload = browserUploadTool(context);
    // A real browser exposes `<input type=file>` as a plain button, with nothing in the
    // accessibility tree naming it a file input, so there is no marker to look for. What
    // is left is the label — the same evidence a person uses. `browser_upload` is what
    // settles it: it opens the control and refuses anything that is not a file input.
    const fileInput =
      record.observation.elements.find(
        (entry) => entry.inputType === "file" || (entry.risk ?? []).includes("file-upload"),
      ) ??
      record.observation.elements.find((entry) =>
        /resume|cv\b|upload|attach/i.test(entry.label ?? entry.name ?? ""),
      );
    if (fileInput !== undefined) {
      const result = await upload.execute(
        "upload",
        {
          target: { ref: fileInput.ref, revision: fileInput.revision, tabId: fileInput.tabId },
          documentIds: [...options.documentIds],
        },
        signal,
      );
      log.steps.push({
        what: `upload to ${fileInput.label ?? fileInput.name ?? "file input"}`,
        ok: result.isError !== true,
        detail: textOf(result),
      });
      await observe.execute("observe", {}, signal);
      record = context.session.record() ?? record;
    }
  }

  return record;
}

/** Presses the control that advances a multi-step form. Never the one that commits. */
export async function advance(
  options: ApplyOptions,
  label: string,
): Promise<ObservationRecord | undefined> {
  const { context, signal, log } = options;
  const act = browserActTool(context);
  const observe = browserObserveTool(context);
  const record = context.session.record();
  const control = record?.observation.elements.find(
    (entry) => entry.label === label || entry.name === label,
  );
  if (record === undefined || control === undefined) return undefined;
  const result = await act.execute(
    "advance",
    {
      action: "click",
      target: { ref: control.ref, revision: control.revision, tabId: control.tabId },
    },
    signal,
  );
  log.steps.push({
    what: `advance via ${label}`,
    ok: result.isError !== true,
    detail: textOf(result),
  });
  await observe.execute("observe", {}, signal);
  const next = context.session.record();
  if (next?.observation.url === record.observation.url) {
    log.steps.push({
      what: `advance via ${label}`,
      ok: false,
      detail: `the form remained at ${record.observation.url}; validation did not accept this step`,
    });
    return undefined;
  }
  return next;
}

export interface CommitResult {
  text: string;
  isError: boolean;
}

/** The one irreversible step, through the one tool that can reach it. */
export async function commit(
  options: ApplyOptions,
  label: string,
): Promise<CommitResult | undefined> {
  const { context, signal, log } = options;
  const submit = browserSubmitTool(context);
  const record = context.session.record();
  const control = record?.observation.elements.find(
    (entry) => entry.label === label || entry.name === label,
  );
  if (control === undefined) {
    log.steps.push({
      what: `submit via ${label}`,
      ok: false,
      detail: `no such control at ${record?.observation.url ?? "an unobserved page"}; controls: ${(
        record?.observation.elements ?? []
      )
        .map((entry) => `${entry.role ?? "?"}/${entry.label ?? entry.name ?? entry.ref}`)
        .slice(0, 30)
        .join(", ")}`,
    });
    return undefined;
  }
  const result = await submit.execute(
    "commit",
    {
      target: { ref: control.ref, revision: control.revision, tabId: control.tabId },
      intent: "submit-form",
    },
    signal,
  );
  const text = textOf(result);
  log.steps.push({ what: `submit via ${label}`, ok: result.isError !== true, detail: text });
  return { text, isError: result.isError === true };
}

export async function openApplication(options: ApplyOptions): Promise<void> {
  const navigate = browserNavigateTool(options.context);
  const result = await navigate.execute(
    "open",
    { action: "open" as const, url: options.url },
    options.signal,
  );
  options.log.steps.push({
    what: `open ${options.url}`,
    ok: result.isError !== true,
    detail: textOf(result),
  });
}

export function emptyLog(): ScenarioLog {
  return { steps: [], plans: [], observed: [], unanswered: [] };
}

export type { AuthorizedDocument };
