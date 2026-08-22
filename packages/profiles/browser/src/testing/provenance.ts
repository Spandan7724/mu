// B7's central assertion, in one place: every value the server received traces to
// something, and "the model produced it" is not something.
//
// Mu cannot see a server, so this reads the fixture's own record of what arrived and
// attributes each value to the plan that filled it, to a value the page already held,
// or to an answer the user typed. A value matching none of those is the failure this
// module exists to catch — a plausible invented answer is worse than a blank field,
// because nobody reviewing the form would know to question it.
import type { AuthorizedDocument } from "../contracts/documents.ts";
import type { BrowserElement, BrowserObservation } from "../contracts/observation.ts";
import type { FillGrounding, FillPlan } from "../data/plan.ts";

export interface ReceivedField {
  name: string;
  value: string;
}

export interface ReceivedFile {
  field: string;
  basename: string;
  sha256?: string | undefined;
}

export interface ReceivedSubmission {
  path: string;
  fields: readonly ReceivedField[];
  files: readonly ReceivedFile[];
}

export interface TypedAnswer {
  /** The control's form name, or its observed label. */
  field: string;
  text: string;
}

export type ValueSource =
  | { kind: "plan"; grounding: FillGrounding; factId?: string | undefined; chain: string[] }
  | { kind: "page"; detail: string }
  | { kind: "user" }
  | { kind: "empty" };

export interface AttributedValue {
  name: string;
  source?: ValueSource | undefined;
  /** Set when nothing accounts for the value. Never carries the value itself. */
  unattributed?: string | undefined;
}

export interface AttributedFile {
  field: string;
  basename: string;
  authorized: boolean;
  detail?: string | undefined;
}

export interface ProvenanceReport {
  path: string;
  values: AttributedValue[];
  files: AttributedFile[];
  /** Every received value traces to a source, and every file was authorized. */
  ok: boolean;
  problems: string[];
}

export interface ProvenanceInput {
  submission: ReceivedSubmission;
  plan: FillPlan;
  /** The page as Mu saw it, which is what says whether a value was already there. */
  observation: BrowserObservation;
  answers?: readonly TypedAnswer[] | undefined;
  documents?: readonly AuthorizedDocument[] | undefined;
}

function elementKeys(element: BrowserElement): string[] {
  return [element.name, element.label, element.ref as string].filter(
    (key): key is string => key !== undefined && key.length > 0,
  );
}

/**
 * The received field name is the form's, not the page's accessible label, so the
 * observation is what joins the two. A name matching no observed control is not an
 * error by itself — hidden inputs are never observed — but it does mean the value can
 * only be the page's own.
 */
function elementFor(name: string, observation: BrowserObservation): BrowserElement | undefined {
  return observation.elements.find((element) => elementKeys(element).includes(name));
}

function planSource(
  element: BrowserElement | undefined,
  value: string,
  plan: FillPlan,
): ValueSource | undefined {
  if (element === undefined) return undefined;
  const fill = plan.fills.find((entry) => entry.ref.ref === element.ref && entry.text === value);
  if (fill === undefined) return undefined;
  return {
    kind: "plan",
    grounding: fill.grounding,
    ...(fill.factId === undefined ? {} : { factId: fill.factId }),
    chain: fill.provenance?.chain ?? [],
  };
}

export function verifyProvenance(input: ProvenanceInput): ProvenanceReport {
  const { submission, plan, observation } = input;
  const answers = input.answers ?? [];
  const documents = input.documents ?? [];
  const problems: string[] = [];

  const values = submission.fields.map((field): AttributedValue => {
    if (field.value.length === 0) return { name: field.name, source: { kind: "empty" } };
    const element = elementFor(field.name, observation);

    const planned = planSource(element, field.value, plan);
    if (planned !== undefined) return { name: field.name, source: planned };

    const names = element === undefined ? [field.name] : [...elementKeys(element), field.name];
    const typed = answers.find(
      (answer) => answer.text === field.value && names.includes(answer.field),
    );
    if (typed !== undefined) return { name: field.name, source: { kind: "user" } };

    // The page put it there. Either it is a control Mu never observed — a hidden
    // input, a token, a step marker — or one whose value Mu did not change.
    if (element === undefined) {
      return { name: field.name, source: { kind: "page", detail: "not an observed control" } };
    }
    if (element.value === field.value) {
      return { name: field.name, source: { kind: "page", detail: "the page's own value" } };
    }

    const problem = `${field.name} carries a value that traces to no fact, policy, page value or user answer`;
    problems.push(problem);
    return { name: field.name, unattributed: problem };
  });

  const files = submission.files.map((file): AttributedFile => {
    const authorized = documents.find((document) => document.basename === file.basename);
    if (authorized === undefined) {
      const problem = `${file.basename} was uploaded to ${file.field} but was never authorized`;
      problems.push(problem);
      return { field: file.field, basename: file.basename, authorized: false, detail: problem };
    }
    if (file.sha256 !== undefined && file.sha256 !== authorized.sha256) {
      const problem = `${file.basename} does not match the authorized document's bytes`;
      problems.push(problem);
      return { field: file.field, basename: file.basename, authorized: false, detail: problem };
    }
    return { field: file.field, basename: file.basename, authorized: true };
  });

  return { path: submission.path, values, files, ok: problems.length === 0, problems };
}

/** Facts that reached the server, for comparison against the disclosure ledger. */
export function disclosedFactIdsIn(report: ProvenanceReport): string[] {
  const ids = report.values
    .map((value) => (value.source?.kind === "plan" ? value.source.factId : undefined))
    .filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
}
