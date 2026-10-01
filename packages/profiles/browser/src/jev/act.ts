import { classify } from "../actions/classify.ts";
import { type ActionContext, type ActionResult, clickRef } from "../actions/click.ts";
import { uploadFiles } from "../actions/files.ts";
import { type FormField, fillForm } from "../actions/input.ts";
import { hostOf } from "../actions/navigate.ts";
import type { PageModel, PageNode } from "../page/model.ts";
import { describeNode, renderSnapshot } from "../page/render.ts";
import { capturePage } from "../page/snapshot.ts";
import {
  type Criterion,
  choice,
  choiceOf,
  type JevAnswer,
  type JevClient,
  type JevQuestion,
  type JevUsage,
  MAX_CHOICE_OPTIONS,
  noul,
  noulOf,
} from "./client.ts";

export type ActValue = string | boolean | string[];

export interface ActInput {
  goal: string;
  values?: Record<string, ActValue>;
  files?: Record<string, string[]>;
  maxSteps?: number;
}

export interface ActOptions {
  jev: Pick<JevClient, "ask">;
  uploadRoots: string[];
}

export type ActStop =
  | "done"
  | "needs-approval"
  | "needs-input"
  | "blocked"
  | "error"
  | "unsure"
  | "no-progress"
  | "left-site"
  | "max-steps";

export interface ActReport extends ActionResult {
  stop: ActStop;
  jev: JevUsage;
}

export const DEFAULT_MAX_STEPS = 12;
// Probability the chosen option needs before code acts on it.
const FIELD_MIN = 0.6;
const CLICK_MIN = 0.6;
const DONE_MIN = 0.8;
const DONE_WHEN_NOTHING_NEXT = 0.4;
// A forward answer this likely is enough when the reverse question agrees.
const AGREED_MIN = 0.3;
const MAX_REVERSE = 40;
const BLOCKED_MIN = 0.7;
const ERROR_MIN = 0.7;
const RISKY_MIN = 0.5;
const NONE = "none";

const FIELD_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "spinbutton",
  "checkbox",
  "switch",
  "slider",
  "radiogroup",
  "time",
  "date",
  "datetime",
]);
const CLICK_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "option",
  "clickable",
]);

interface Candidate {
  ref: string;
  node: PageNode;
  line: string;
}

interface PageCandidates {
  fields: Candidate[];
  // The checkbox group each grouped checkbox belongs to.
  groupOf: Map<string, PageNode>;
  clickables: Candidate[];
  text: string;
}

function hasRadio(node: PageNode): boolean {
  return node.children.some((child) => child.role === "radio" || hasRadio(child));
}

function isRadioGroup(node: PageNode): boolean {
  return node.role === "radiogroup" || (node.role === "group" && hasRadio(node));
}

function checkboxesIn(node: PageNode): PageNode[] {
  return node.children.flatMap((child) =>
    child.role === "checkbox" ? [child] : checkboxesIn(child),
  );
}

// A group of checkboxes answers one question with several choices ("toppings").
function isCheckboxGroup(node: PageNode): boolean {
  return node.role === "group" && !hasRadio(node) && checkboxesIn(node).length >= 2;
}

// Fields and clickable controls the rendered page shows, in page order.
export function pageCandidates(model: PageModel): PageCandidates {
  const rendered = renderSnapshot(model, { scope: "full" });
  const fields: Candidate[] = [];
  const clickables: Candidate[] = [];
  const groupOf = new Map<string, PageNode>();
  const walk = (node: PageNode, inGroup: boolean) => {
    const group = isRadioGroup(node) && node.ref !== undefined;
    const boxes = node.ref !== undefined && isCheckboxGroup(node);
    if (boxes) for (const box of checkboxesIn(node)) if (box.ref) groupOf.set(box.ref, node);
    if (node.ref && rendered.refs.has(node.ref) && !node.states.disabled) {
      const candidate = { ref: node.ref, node, line: describeNode(node, model.url).slice(0, 160) };
      if (
        FIELD_ROLES.has(node.role) ||
        node.editable !== undefined ||
        group ||
        boxes ||
        (node.role === "radio" && !inGroup)
      )
        fields.push(candidate);
      else if (CLICK_ROLES.has(node.role)) clickables.push(candidate);
    }
    for (const child of node.children) walk(child, inGroup || group);
  };
  walk(model.modal ?? model.root, false);
  const text = rendered.text
    .replace(/^<page_content untrusted="true">\n/, "")
    .replace(/\n<\/page_content>$/, "");
  return { fields, clickables, groupOf, text };
}

// A Choice over refs, split into requests of at most 255 options (with "none")
// whose winners meet in a runoff.
function refQuestions(
  id: string,
  instructions: unknown,
  candidates: Candidate[],
  none: string,
): Record<string, JevQuestion> {
  const size = MAX_CHOICE_OPTIONS - 1;
  const questions: Record<string, JevQuestion> = {};
  for (let start = 0, part = 0; start < Math.max(candidates.length, 1); start += size, part++) {
    const criteria: Record<string, Criterion> = {};
    for (const candidate of candidates.slice(start, start + size))
      criteria[candidate.ref] = candidate.line;
    criteria[NONE] = none;
    questions[`${id}#${part}`] = choice(instructions, criteria);
  }
  return questions;
}

interface RefPick {
  ref: string;
  probability: number;
}

async function resolvePick(
  id: string,
  answers: Record<string, JevAnswer>,
  runoff: (candidates: string[]) => Promise<JevAnswer>,
): Promise<RefPick> {
  const parts = Object.keys(answers)
    .filter((key) => key.startsWith(`${id}#`))
    .map((key) => choiceOf(answers[key]));
  if (parts.length === 1) {
    const only = parts[0] as (typeof parts)[number];
    return { ref: only.choice, probability: only.probabilities[only.choice] ?? 0 };
  }
  const finalists = parts.map((part) => part.choice).filter((ref) => ref !== NONE);
  if (finalists.length === 0) return { ref: NONE, probability: 1 };
  if (finalists.length === 1)
    return {
      ref: finalists[0] as string,
      probability: Math.max(
        ...parts.map((part) => part.probabilities[finalists[0] as string] ?? 0),
      ),
    };
  const final = choiceOf(await runoff(finalists));
  return { ref: final.choice, probability: final.probabilities[final.choice] ?? 0 };
}

function display(value: ActValue): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function sameValue(node: PageNode, value: ActValue): boolean {
  if (typeof value !== "string" || node.value === undefined) return false;
  return node.value.trim().toLowerCase() === value.trim().toLowerCase();
}

function isEmptyRequired(node: PageNode): boolean {
  if (!(node.states.required || /\*\s*$/.test(node.name)) || node.editable === undefined)
    return false;
  return (node.value ?? "").trim() === "";
}

// Drives the page toward a goal with Jev making each small decision, and stops
// whenever the next step needs the model, the user, or an approval.
export async function runAct(
  ctx: ActionContext,
  input: ActInput,
  options: ActOptions,
): Promise<ActReport> {
  const { signal } = ctx;
  const usage: JevUsage = { calls: 0, ms: 0, inputTokens: 0 };
  const values = input.values ?? {};
  const files = input.files ?? {};
  const pending = new Set([...Object.keys(values), ...Object.keys(files)]);
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const startHost = hostOf(ctx.tab.url);
  const log: string[] = [];
  let lastAction: "fill" | "click" | undefined;
  let lastStep = "none yet";
  let stale = 0;
  let previousFingerprint: string | undefined;
  const shownValues = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, display(value)]),
  );
  for (const [key, paths] of Object.entries(files))
    shownValues[key] = `file: ${paths.map((path) => path.split(/[\\/]/).pop()).join(", ")}`;

  // Values that failed once are not retried; the report hands them back.
  const notEntered: string[] = [];
  const finish = (stop: ActStop, summary: string, extra: string[] = []): ActReport => {
    const unused = [...pending];
    const lines = [
      `steps (${log.length}; jev ${usage.calls} calls, ${Math.round(usage.ms)} ms):`,
      ...log.map((line, index) => `${index + 1}. ${line}`),
      ...(unused.length ? [`values not used: ${unused.join(", ")}`] : []),
      ...notEntered.map((failure) => `could not enter ${failure}`),
      ...extra,
    ];
    return {
      ok: stop === "done" || stop === "needs-approval" || stop === "needs-input",
      summary: `act ${stop}: ${summary}`,
      extra: lines.join("\n"),
      stop,
      jev: usage,
      tab: ctx.tab,
    };
  };

  for (let step = 0; step < maxSteps; step++) {
    const tab = ctx.tab;
    const model = await ctx.stopwatch.time("snapshotMs", () =>
      capturePage(tab, { scope: "full", signal }),
    );
    for (const secret of model.secrets) ctx.browser.secrets.add(secret);
    if (startHost && hostOf(model.url) !== startHost)
      return finish("left-site", `the page moved to ${hostOf(model.url)}; continue there yourself`);
    const page = pageCandidates(model);
    const fingerprint = `${model.url}#${Bun.hash(page.text).toString(36)}`;
    if (lastAction === "click" && fingerprint === previousFingerprint) stale++;
    else stale = 0;
    previousFingerprint = fingerprint;
    if (stale >= 2) return finish("no-progress", "the page did not change after the last clicks");

    const state = ctx.browser.secrets.redactDeep({
      goal: input.goal,
      values: shownValues,
      last_step: lastStep,
      page: { title: model.title, url: model.url, content: page.text },
    });
    const keys = [...pending];
    const questions: Record<string, JevQuestion> = {
      done: noul("Does `page` show that `goal` has been reached?", {
        true: "The page shows the end state `goal` describes",
        false: "The goal is not reached yet on this page",
      }),
      blocked: noul(
        "Does `page` require something only a person can provide before going on: signing in, solving a CAPTCHA, a verification code, or payment details?",
      ),
      error: noul(
        "Does `page` show an error message, such as a validation error about entered data or a failed request?",
      ),
      ...refQuestions(
        "next",
        "Which one control in `page` should be clicked next to move toward `goal`, assuming the fields for `values` on this page are already filled in?",
        page.clickables,
        "No control should be clicked: the goal is reached, or no control moves toward it",
      ),
    };
    keys.forEach((key, index) => {
      const fieldCandidates = key in files ? [...page.fields, ...page.clickables] : page.fields;
      Object.assign(
        questions,
        refQuestions(
          `field${index}`,
          {
            question:
              key in files
                ? "Which file input or upload control in `page` should receive the file for `item`? Answer none if the page has no place for it."
                : "Which field in `page` asks for `item`? Answer none if no field on this page asks for it.",
            item: { name: key, value: shownValues[key] },
          },
          fieldCandidates,
          "No field on this page asks for it",
        ),
      );
    });
    // The reverse question for each empty field: a pair both directions agree on is
    // filled even when the forward answer alone is not confident enough.
    const valueKeys = keys.filter((key) => !(key in files));
    const empty = page.fields
      .filter((candidate) => (candidate.node.value ?? "").trim() === "")
      .slice(0, MAX_REVERSE);
    if (valueKeys.length > 0 && valueKeys.length < MAX_CHOICE_OPTIONS)
      for (const candidate of empty)
        questions[`value:${candidate.ref}`] = choice(
          {
            question: "Which entry of `values` belongs in `field`? Answer none if no entry does.",
            field: candidate.line,
          },
          {
            ...Object.fromEntries(valueKeys.map((key) => [key, shownValues[key] ?? null])),
            [NONE]: "No entry of `values` belongs in this field",
          },
        );
    const response = await options.jev.ask(state, questions, signal, usage);
    const answers = response.answers;
    const runoff = (id: string, instructions: unknown) => async (refs: string[]) => {
      const byRef = new Map(
        [...page.fields, ...page.clickables].map((candidate) => [candidate.ref, candidate]),
      );
      const finalists = refs.map((ref) => byRef.get(ref)).filter((c): c is Candidate => !!c);
      const final = await options.jev.ask(
        state,
        refQuestions(id, instructions, finalists, "None of these"),
        signal,
        usage,
      );
      return final.answers[`${id}#0`] as JevAnswer;
    };

    if (noulOf(answers.blocked) >= BLOCKED_MIN)
      return finish("blocked", "the page needs the user (sign-in, CAPTCHA, code or payment)");

    // Fill every value Jev places with enough confidence, one value per field.
    const picks: { key: string; pick: RefPick }[] = [];
    for (const [index, key] of keys.entries()) {
      const pick = await resolvePick(
        `field${index}`,
        answers,
        runoff(`field${index}`, { question: "Which field asks for `item`?", item: key }),
      );
      picks.push({ key, pick });
    }
    picks.sort((a, b) => b.pick.probability - a.pick.probability);
    const byRef = new Map(page.fields.map((candidate) => [candidate.ref, candidate]));
    const taken = new Set<string>();
    const fields: (FormField & { key: string })[] = [];
    const uploads: { key: string; ref: string }[] = [];
    const unsure: string[] = [];
    const secretFields: string[] = [];
    const agreed = (key: string, ref: string) => {
      const reverse = answers[`value:${ref}`];
      return (
        reverse?.type === "choice" &&
        reverse.choice === key &&
        (reverse.probabilities[key] ?? 0) >= FIELD_MIN
      );
    };
    for (const { key, pick } of picks) {
      if (pick.ref === NONE || taken.has(pick.ref)) continue;
      if (
        pick.probability < FIELD_MIN &&
        !(pick.probability >= AGREED_MIN && agreed(key, pick.ref))
      ) {
        unsure.push(`${key} → ${tab.refs.label(pick.ref)} (${pick.probability.toFixed(2)})`);
        continue;
      }
      taken.add(pick.ref);
      if (key in files) {
        uploads.push({ key, ref: pick.ref });
        continue;
      }
      const node = byRef.get(pick.ref)?.node;
      const value = values[key] as ActValue;
      if (node?.editable === "secret" || node?.editable === "otp") {
        secretFields.push(tab.refs.label(pick.ref));
        continue;
      }
      if (node && sameValue(node, value)) {
        pending.delete(key);
        continue;
      }
      // Several choices for a checkbox group (or one of its boxes) tick the matching boxes.
      const boxGroup = node && isCheckboxGroup(node) ? node : page.groupOf.get(pick.ref);
      if (boxGroup && typeof value !== "boolean") {
        const wanted = (Array.isArray(value) ? value : value.split(/\s*,\s*/)).filter(Boolean);
        const boxes = checkboxesIn(boxGroup);
        const unmatched: string[] = [];
        for (const item of wanted) {
          const label = item.trim().toLowerCase();
          const box =
            boxes.find((candidate) => candidate.name.trim().toLowerCase() === label) ??
            boxes.find((candidate) => candidate.name.toLowerCase().includes(label));
          if (box?.ref) fields.push({ key, ref: box.ref, value: true });
          else unmatched.push(item);
        }
        if (unmatched.length)
          notEntered.push(
            `${key}: no checkbox matches ${unmatched.map((item) => JSON.stringify(item)).join(", ")}`,
          );
        if (unmatched.length === wanted.length) pending.delete(key);
        continue;
      }
      // A yes/no question asked as a radio group takes the option's label.
      const answer =
        typeof value === "boolean" && node && isRadioGroup(node) ? (value ? "Yes" : "No") : value;
      fields.push({ key, ref: pick.ref, value: answer });
    }
    if (fields.length > 0 || uploads.length > 0) {
      const done: string[] = [];
      const failures: string[] = [];
      for (const upload of uploads) {
        const result = await uploadFiles(
          ctx,
          upload.ref,
          files[upload.key] as string[],
          options.uploadRoots,
        );
        pending.delete(upload.key);
        if (result.ok === false) failures.push(`${upload.key}: ${result.summary}`);
        else {
          done.push(`${tab.refs.label(upload.ref)} ← file ${upload.key}`);
        }
      }
      if (fields.length > 0) {
        const result = await fillForm(
          ctx,
          fields.map(({ ref, value }) => ({ ref, value })),
        );
        const failed = new Set(
          (result.extra ?? "")
            .split("\n")
            .filter((line) => line.startsWith("failed: "))
            .map((line) => line.slice("failed: ".length)),
        );
        for (const field of fields) {
          const label = tab.refs.label(field.ref);
          const failure = [...failed].find((line) => line.startsWith(`${label}:`));
          pending.delete(field.key);
          if (failure) failures.push(`${field.key}: ${failure}`);
          else done.push(`${label} ← ${field.key}`);
        }
      }
      lastStep = `filled ${done.length ? done.join(", ") : "nothing"}${failures.length ? `; failed: ${failures.join("; ")}` : ""}`;
      log.push(lastStep);
      notEntered.push(...failures);
      lastAction = "fill";
      continue;
    }
    if (secretFields.length > 0)
      return finish(
        "needs-approval",
        `a password or one-time-code field is next (${secretFields.join(", ")}); enter it with type or fill_form, which asks the user`,
      );
    const consequential = page.clickables
      .filter(
        (candidate) =>
          classify({
            tool: "click",
            args: { ref: candidate.ref },
            meta: (ref) => tab.refs.meta(ref),
            page: { url: tab.url, title: tab.title },
          }).scope !== "browser:interact",
      )
      .map((candidate) => tab.refs.label(candidate.ref));
    const leftHere = consequential.length
      ? [
          `consequential controls on this page (click with commit: true): ${consequential.join(", ")}`,
        ]
      : [];
    if (noulOf(answers.done) >= DONE_MIN)
      return finish("done", "the page shows the goal reached", leftHere);
    if (lastAction === "click" && noulOf(answers.error) >= ERROR_MIN)
      return finish("error", "the page shows an error after the last step; read it below");
    const next = await resolvePick(
      "next",
      answers,
      runoff("next", {
        question: "Which control should be clicked next to move toward `goal`?",
      }),
    );
    // Nothing moves toward the goal because the goal says to stop here.
    if (next.ref === NONE && noulOf(answers.done) >= DONE_WHEN_NOTHING_NEXT)
      return finish("done", "the page shows the goal reached", leftHere);
    if (next.ref === NONE || next.probability < CLICK_MIN)
      return finish(
        "unsure",
        next.ref === NONE
          ? "no control on the page moves toward the goal; decide the next step yourself"
          : `unsure what to click next (best guess ${tab.refs.label(next.ref)}, ${next.probability.toFixed(2)})`,
        [...(unsure.length ? [`unsure: ${unsure.join("; ")}`] : []), ...leftHere],
      );
    // A button would submit the step with a required field left empty; a link just leaves.
    const emptyRequired = page.fields.filter(
      (candidate) => isEmptyRequired(candidate.node) && !taken.has(candidate.ref),
    );
    const nextNode = page.clickables.find((candidate) => candidate.ref === next.ref)?.node;
    if (emptyRequired.length > 0 && nextNode?.role === "button")
      return finish(
        "needs-input",
        `required fields have no value in values: ${emptyRequired.map((c) => tab.refs.label(c.ref)).join(", ")}`,
        unsure.length ? [`unsure: ${unsure.join("; ")}`] : [],
      );
    const gate = classify({
      tool: "click",
      args: { ref: next.ref },
      meta: (ref) => tab.refs.meta(ref),
      page: { url: tab.url, title: tab.title },
    });
    const label = tab.refs.label(next.ref);
    if (gate.scope !== "browser:interact")
      return finish(
        "needs-approval",
        `the next step is ${label}, a consequential action (${gate.reason ?? gate.scope}); click it with commit: true if the user's request authorizes it`,
      );
    const risky = await options.jev.ask(
      { page: state.page, control: byRefLine(page, next.ref) },
      {
        risky: noul(
          "Would clicking `control` on `page` send, submit, post, publish, buy, pay, book, delete, or change account settings, with effects outside this browser page?",
          {
            true: "Clicking it finalizes something outside the page (a submission, message, purchase, deletion or settings change)",
            false:
              "Clicking it only navigates, opens, reveals, filters or moves between steps of a form without finalizing it",
          },
        ),
      },
      signal,
      usage,
    );
    if (noulOf(risky.answers.risky) >= RISKY_MIN)
      return finish(
        "needs-approval",
        `the next step is ${label}, which looks consequential; click it with commit: true if the user's request authorizes it`,
      );
    const clicked = await clickRef(ctx, next.ref);
    if (clicked.tab) ctx.tab = clicked.tab;
    lastStep = clicked.summary;
    log.push(lastStep);
    lastAction = "click";
  }
  return finish("max-steps", `stopped after ${maxSteps} steps; check the page and continue`);
}

function byRefLine(page: PageCandidates, ref: string): string {
  return (
    [...page.clickables, ...page.fields].find((candidate) => candidate.ref === ref)?.line ?? ref
  );
}
