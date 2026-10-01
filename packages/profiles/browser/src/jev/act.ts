import { classify } from "../actions/classify.ts";
import { type ActionContext, type ActionResult, clickRef } from "../actions/click.ts";
import { uploadFiles } from "../actions/files.ts";
import { type FormField, fillForm, pressKeys, selectOptions, typeText } from "../actions/input.ts";
import { hostOf } from "../actions/navigate.ts";
import { waitFor } from "../actions/page.ts";
import { scrollPage } from "../actions/scroll.ts";
import type { PageModel, PageNode } from "../page/model.ts";
import { capturePage } from "../page/snapshot.ts";
import {
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
import { exactMatch, type Grounded, ground, NONE } from "./ground.ts";
import {
  type Candidate,
  checkboxesIn,
  isCheckboxGroup,
  isRadioGroup,
  type PageCandidates,
  pageCandidates,
} from "./page.ts";

export { pageCandidates };

export type ActValue = string | boolean | string[];

export interface ActStep {
  action: "click" | "type" | "select" | "fill" | "press" | "scroll" | "wait";
  // What to act on: a ref from the page state, a visible label, or a description.
  target?: string | undefined;
  // type: the text; select: the option; press: the key (Enter); wait: text to wait for.
  text?: string | undefined;
  // type: press Enter afterwards.
  submit?: boolean | undefined;
  direction?: "up" | "down" | undefined;
}

export interface ActInput {
  steps: ActStep[];
  // Values and files for fill steps, keyed by what the field asks for; values a fill
  // step cannot place stay for the next fill step.
  values?: Record<string, ActValue>;
  files?: Record<string, string[]>;
}

export interface ActOptions {
  jev: Pick<JevClient, "ask">;
  uploadRoots: string[];
  // Whether the user's host rules let the browser go to `host` (default: anywhere).
  hostAllowed?: (host: string) => boolean;
  // Each Jev answer set, for benchmarks and debugging.
  trace?: (step: number, answers: Record<string, JevAnswer>) => void;
}

export type ActStop =
  | "done"
  | "not-found"
  | "needs-approval"
  | "needs-input"
  | "blocked"
  | "error"
  | "left-site";

export interface ActReport extends ActionResult {
  stop: ActStop;
  jev: JevUsage;
}

// Probability a grounded target needs before code acts on it, or a clear lead.
const TARGET_MIN = 0.6;
const TARGET_LEAD_MIN = 0.35;
const TARGET_LEAD = 2;
const FIELD_MIN = 0.7;
// A forward answer this likely is enough when the reverse question agrees.
const AGREED_MIN = 0.3;
const REVERSE_MIN = 0.5;
const BLOCKED_MIN = 0.7;
const ERROR_MIN = 0.7;
const RISKY_MIN = 0.5;
const MAX_REVERSE = 40;
const MAX_SPECULATIVE_RISKY = 30;
const FILL_PASSES = 3;
const RISKY_ROLES = new Set(["button", "clickable", "menuitem"]);
const PICKER_ROLES = new Set(["combobox", "date", "time", "datetime"]);

function confident(grounded: Grounded): boolean {
  if (grounded.ref === NONE) return false;
  return (
    grounded.probability >= TARGET_MIN ||
    (grounded.probability >= TARGET_LEAD_MIN &&
      grounded.probability >= TARGET_LEAD * grounded.second)
  );
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

function riskyQuestion(control: string): JevQuestion {
  return noul(
    {
      question:
        "Would clicking `control` send, submit, post, publish, buy, pay, book, delete, or change account settings, with effects outside this browser page?",
      control,
    },
    {
      true: "Clicking it finalizes something outside the page (a submission, message, purchase, deletion or settings change)",
      false:
        "Clicking it only navigates, opens, reveals, filters, sorts, adds to a cart, accepts or rejects cookies, dismisses a banner or popup, or moves between steps of a form without finalizing it",
    },
  );
}

const CHECKS = {
  blocked: noul(
    "Does `page` require something only a person can provide before going on: signing in, solving a CAPTCHA, a verification code, or payment details?",
  ),
  error: noul(
    "Does `page` show an error message, such as a validation error about entered data or a failed request?",
  ),
};

function describe(step: ActStep): string {
  const target = step.target ? ` ${JSON.stringify(step.target)}` : "";
  switch (step.action) {
    case "type":
      return `type ${JSON.stringify(step.text ?? "")} into${target}`;
    case "select":
      return `select ${JSON.stringify(step.text ?? "")} in${target}`;
    case "press":
      return `press ${step.text ?? "Enter"}${target ? ` in${target}` : ""}`;
    case "scroll":
      return `scroll ${step.direction ?? "down"}${target ? ` in${target}` : ""}`;
    case "wait":
      return `wait for ${JSON.stringify(step.text ?? "")}`;
    default:
      return `${step.action}${target}`;
  }
}

const NOTHING: Grounded = { ref: NONE, probability: 0, second: 0, top: [], by: "jev" };

// Runs the model's steps in order. The model decides what each step does; Jev only
// finds the element a step describes on the page as it is by then (code first when the
// target is a ref or an exact label) and checks the page for errors and sign-in walls.
// Anything consequential, uncertain or broken stops the run and hands back.
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
  const startHost = hostOf(ctx.tab.url);
  const log: string[] = [];
  const notEntered: string[] = [];
  let acted = false;
  const shownValues: Record<string, string> = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, display(value)]),
  );
  for (const [key, paths] of Object.entries(files))
    shownValues[key] = `file: ${paths.map((path) => path.split(/[\\/]/).pop()).join(", ")}`;

  const finish = (stop: ActStop, summary: string, extra: string[] = []): ActReport => {
    const unused = [...pending];
    const lines = [
      `steps run (${log.length} of ${input.steps.length}; jev ${usage.calls} calls, ${Math.round(usage.ms)} ms):`,
      ...log.map((line, index) => `${index + 1}. ${line}`),
      ...(unused.length ? [`values not used: ${unused.join(", ")}`] : []),
      ...notEntered.map((failure) => `could not enter ${failure}`),
      ...extra,
    ];
    return {
      ok: stop === "done" || stop === "needs-approval",
      summary: `act ${stop}: ${summary}`,
      extra: lines.join("\n"),
      stop,
      jev: usage,
      tab: ctx.tab,
    };
  };
  // Typing on another site than the one the run started on could carry page data
  // there; that asks the user through the normal tools instead.
  const leakAt = (url: string): string | undefined => {
    if (!startHost || hostOf(url) === startHost) return undefined;
    const typed = [
      ...Object.values(values).flatMap((value) =>
        typeof value === "string" ? [value] : Array.isArray(value) ? value : [],
      ),
      ...input.steps.flatMap((step) => (step.action === "type" && step.text ? [step.text] : [])),
    ];
    return typed.length ? ctx.browser.dataflow.typingLeak(typed, url) : undefined;
  };
  const capture = async (): Promise<{ model: PageModel; page: PageCandidates } | ActReport> => {
    const model = await ctx.stopwatch.time("snapshotMs", () =>
      capturePage(ctx.tab, { scope: "full", signal }),
    );
    for (const secret of model.secrets) ctx.browser.secrets.add(secret);
    const host = hostOf(model.url);
    if (host && host !== startHost && options.hostAllowed && !options.hostAllowed(host))
      return finish("left-site", `the page moved to ${host}, which your host rules do not allow`);
    return { model, page: pageCandidates(model) };
  };
  const checks = (answers: Record<string, JevAnswer>, index: number): ActReport | undefined => {
    if (answers.blocked && noulOf(answers.blocked) >= BLOCKED_MIN)
      return finish(
        "blocked",
        `before step ${index + 1} the page needs the user (sign-in, CAPTCHA, code or payment)`,
      );
    if (acted && answers.error && noulOf(answers.error) >= ERROR_MIN)
      return finish("error", `the page shows an error after step ${index}; read it below`);
    return undefined;
  };

  // Places pending values on the current page: one Jev request asks which field each
  // value belongs in (and, per empty field, which value belongs there), code fills the
  // confident ones, and a field revealed by an answer gets another pass.
  const fillPending = async (index: number): Promise<{ summary: string } | ActReport> => {
    const done: string[] = [];
    for (let pass = 0; pass < FILL_PASSES && pending.size > 0; pass++) {
      const captured = await capture();
      if ("stop" in captured) return captured;
      const { model, page } = captured;
      const tab = ctx.tab;
      const keys = [...pending];
      const questions: Record<string, JevQuestion> = { ...CHECKS };
      keys.forEach((key, position) => {
        const targets = key in files ? [...page.fields, ...page.clicks] : page.fields;
        questions[`field${position}`] = choice(
          {
            question:
              key in files
                ? "Which file input or upload control in `page` should receive the file for `item`? Answer none if the page has no place for it."
                : "Which field in `page` asks for `item`? Answer none if no field on this page asks for it.",
            item: { name: key, value: shownValues[key] },
          },
          {
            ...Object.fromEntries(
              targets
                .slice(0, MAX_CHOICE_OPTIONS - 1)
                .map((candidate) => [candidate.ref, candidate.line]),
            ),
            [NONE]: "No field on this page asks for it",
          },
        );
      });
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
      const state = ctx.browser.secrets.redactDeep({
        values: shownValues,
        page: { title: model.title, url: model.url, content: page.text },
      });
      const { answers } = await options.jev.ask(state, questions, signal, usage);
      options.trace?.(index, answers);
      const stopped = checks(answers, index);
      if (stopped) return stopped;
      const reverse = (ref: string) => {
        const answer = answers[`value:${ref}`];
        return answer?.type === "choice" && answer.choice !== NONE
          ? { key: answer.choice, probability: answer.probabilities[answer.choice] ?? 0 }
          : undefined;
      };
      const picks = keys
        .map((key, position) => {
          const answer = choiceOf(answers[`field${position}`]);
          return { key, ref: answer.choice, probability: answer.probabilities[answer.choice] ?? 0 };
        })
        .sort((a, b) => b.probability - a.probability);
      const byRef = new Map(
        [...page.fields, ...page.clicks].map((candidate) => [candidate.ref, candidate.node]),
      );
      const taken = new Set<string>();
      const fields: (FormField & { key: string })[] = [];
      const uploads: { key: string; ref: string }[] = [];
      const secretFields: string[] = [];
      for (const { key, ref, probability } of picks) {
        if (ref === NONE || taken.has(ref)) continue;
        const back = reverse(ref);
        const agreed = back?.key === key && back.probability >= REVERSE_MIN;
        if (probability < FIELD_MIN && !(probability >= AGREED_MIN && agreed)) continue;
        taken.add(ref);
        if (key in files) {
          uploads.push({ key, ref });
          continue;
        }
        const node = byRef.get(ref);
        const value = values[key] as ActValue;
        if (node?.editable === "secret" || node?.editable === "otp") {
          secretFields.push(tab.refs.label(ref));
          continue;
        }
        if (node && sameValue(node, value)) {
          pending.delete(key);
          continue;
        }
        // Several choices for a checkbox group (or one of its boxes) tick the matching boxes.
        const boxGroup = node && isCheckboxGroup(node) ? node : page.groupOf.get(ref);
        if (boxGroup && typeof value !== "boolean") {
          const wanted = (Array.isArray(value) ? value : value.split(/\s*,\s*/)).filter(Boolean);
          const boxes = checkboxesIn(boxGroup);
          const unmatched: string[] = [];
          for (const item of wanted) {
            const name = item.trim().toLowerCase();
            const box =
              boxes.find((candidate) => candidate.name.trim().toLowerCase() === name) ??
              boxes.find((candidate) => candidate.name.toLowerCase().includes(name));
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
        fields.push({ key, ref, value: answer });
      }
      if (secretFields.length > 0)
        return finish(
          "needs-approval",
          `a password or one-time-code field (${secretFields.join(", ")}); enter it with type or fill_form, which asks the user`,
        );
      if (fields.length === 0 && uploads.length === 0) break;
      const leak = fields.length > 0 ? leakAt(model.url) : undefined;
      if (leak)
        return finish(
          "needs-approval",
          `filling here would carry data to ${hostOf(model.url)} (${leak}); fill it with fill_form, which asks the user`,
        );
      for (const upload of uploads) {
        const uploaded = await uploadFiles(
          ctx,
          upload.ref,
          files[upload.key] as string[],
          options.uploadRoots,
        );
        pending.delete(upload.key);
        if (uploaded.ok === false) notEntered.push(`${upload.key}: ${uploaded.summary}`);
        else done.push(`${tab.refs.label(upload.ref)} ← file ${upload.key}`);
      }
      if (fields.length > 0) {
        const filled = await fillForm(
          ctx,
          fields.map(({ ref, value }) => ({ ref, value })),
        );
        const failed = (filled.extra ?? "")
          .split("\n")
          .filter((line) => line.startsWith("failed: "))
          .map((line) => line.slice("failed: ".length));
        for (const field of fields) {
          const name = tab.refs.label(field.ref);
          const failure = failed.find((line) => line.startsWith(`${name}:`));
          pending.delete(field.key);
          if (failure) notEntered.push(`${field.key}: ${failure}`);
          else done.push(`${name} ← ${field.key}`);
        }
      }
    }
    return { summary: done.length ? `filled ${done.join(", ")}` : "filled nothing on this page" };
  };

  for (const [index, step] of input.steps.entries()) {
    const stepName = `step ${index + 1} (${describe(step)})`;
    let result: ActionResult;
    let did: string;
    if (step.action === "fill") {
      const filled = await fillPending(index);
      if ("stop" in filled) return filled;
      result = { summary: filled.summary };
      did = filled.summary;
    } else if (step.action === "wait") {
      result = await waitFor(ctx, step.text ? { text: step.text } : { seconds: 1 });
      did = result.summary;
    } else {
      const captured = await capture();
      if ("stop" in captured) return captured;
      const { model, page } = captured;
      const tab = ctx.tab;
      const label = (ref: string) => tab.refs.label(ref);
      const where = { title: model.title, url: model.url };
      const content = ctx.browser.secrets.redact(page.text);
      const gateOf = (tool: string, args: Record<string, unknown>) =>
        classify({
          tool,
          args,
          meta: (ref) => tab.refs.meta(ref),
          page: { url: tab.url, title: tab.title },
        });
      const notFound = (grounded: Grounded, what: string) =>
        finish(
          "not-found",
          `${stepName}: ${what}`,
          grounded.top.length
            ? [
                `closest: ${grounded.top
                  .map((entry) => `${label(entry.ref)} (${entry.probability.toFixed(2)})`)
                  .join(", ")}`,
              ]
            : [],
        );
      let riskyAnswers: Record<string, JevAnswer> = {};
      const riskyFor = (candidates: Candidate[]) =>
        Object.fromEntries(
          candidates
            .filter((candidate) => RISKY_ROLES.has(candidate.node.role))
            .slice(0, MAX_SPECULATIVE_RISKY)
            .map((candidate) => [`risky:${candidate.ref}`, riskyQuestion(candidate.line)]),
        );
      // The element the step's target names. Code resolves refs and exact labels; Jev is
      // asked for descriptions, together with the page checks (after a step acted) and
      // whether each button would finalize something.
      const find = async (
        kind: "click" | "type" | "select",
        candidates: Candidate[],
      ): Promise<Grounded | ActReport> => {
        if (!step.target) return finish("needs-input", `${stepName} needs a target`);
        const exact = exactMatch(step.target, candidates);
        const risky =
          kind === "click"
            ? riskyFor(exact ? candidates.filter((c) => c.ref === exact.ref) : candidates)
            : {};
        const found = await ground(options.jev, step.target, kind, candidates, where, signal, {
          usage,
          content,
          extra: { ...(acted || !exact ? CHECKS : {}), ...risky },
        });
        options.trace?.(index, found.answers);
        const stopped = checks(found.answers, index);
        if (stopped) return stopped;
        riskyAnswers = found.answers;
        return found.grounded;
      };
      switch (step.action) {
        case "click": {
          const grounded = await find("click", page.clicks);
          if ("stop" in grounded) return grounded;
          if (!confident(grounded))
            return notFound(grounded, `no element clearly matches ${JSON.stringify(step.target)}`);
          const candidate = page.clicks.find((entry) => entry.ref === grounded.ref);
          const node = candidate?.node;
          // A button would submit a step with a required field left empty; a link just leaves.
          const emptyRequired = page.fields.filter(
            (entry) => isEmptyRequired(entry.node) && entry.ref !== grounded.ref,
          );
          if (emptyRequired.length > 0 && node?.role === "button")
            return finish(
              "needs-input",
              `before ${stepName}: required fields are empty: ${emptyRequired.map((entry) => label(entry.ref)).join(", ")}`,
            );
          const gate = gateOf("click", { ref: grounded.ref });
          if (gate.scope !== "browser:interact")
            return finish(
              "needs-approval",
              `${stepName} is ${label(grounded.ref)}, a consequential action (${gate.reason ?? gate.scope}); click it with commit: true if the user's request authorizes it`,
            );
          let risk = riskyAnswers[`risky:${grounded.ref}`];
          if (!risk && node && RISKY_ROLES.has(node.role))
            risk = (
              await options.jev.ask(
                { page: where },
                { risky: riskyQuestion(candidate?.line ?? label(grounded.ref)) },
                signal,
                usage,
              )
            ).answers.risky;
          if (risk && noulOf(risk) >= RISKY_MIN)
            return finish(
              "needs-approval",
              `${stepName} is ${label(grounded.ref)}, which looks consequential; click it with commit: true if the user's request authorizes it`,
            );
          result = await clickRef(ctx, grounded.ref);
          did = `${result.summary}${grounded.by === "jev" ? ` (matched ${grounded.probability.toFixed(2)})` : ""}`;
          break;
        }
        case "type": {
          if (step.text === undefined)
            return finish("needs-input", `${stepName} needs the text to type`);
          const grounded = await find("type", page.typing);
          if ("stop" in grounded) return grounded;
          if (!confident(grounded))
            return notFound(grounded, `no field clearly matches ${JSON.stringify(step.target)}`);
          const leak = leakAt(model.url);
          if (leak)
            return finish(
              "needs-approval",
              `${stepName} would carry data to ${hostOf(model.url)} (${leak}); type it with type, which asks the user`,
            );
          if (step.submit) {
            const gate = gateOf("type", { ref: grounded.ref, text: step.text, submit: true });
            if (gate.scope !== "browser:interact")
              return finish(
                "needs-approval",
                `${stepName} submits a form (${gate.reason ?? gate.scope}); type it with type and commit: true if the user's request authorizes it`,
              );
          }
          const role = page.typing.find((entry) => entry.ref === grounded.ref)?.node.role ?? "";
          if (PICKER_ROLES.has(role)) {
            // Autocompletes and date fields: fill_form's machinery picks the suggestion or date.
            result = await fillForm(ctx, [{ ref: grounded.ref, value: step.text }]);
            if (step.submit && result.ok !== false) await pressKeys(ctx, "Enter", grounded.ref);
          } else {
            result = await typeText(
              ctx,
              grounded.ref,
              step.text,
              step.submit ? { submit: true } : {},
            );
          }
          did = result.summary;
          break;
        }
        case "select": {
          if (!step.text) return finish("needs-input", `${stepName} needs the option to choose`);
          const dropdownRefs = new Set(page.options.map((option) => option.ref));
          const dropdowns = page.fields.filter(
            (entry) => dropdownRefs.has(entry.ref) || entry.node.role === "combobox",
          );
          const grounded = await find("select", dropdowns.length ? dropdowns : page.fields);
          if ("stop" in grounded) return grounded;
          if (!confident(grounded))
            return notFound(grounded, `no dropdown clearly matches ${JSON.stringify(step.target)}`);
          result = await selectOptions(ctx, grounded.ref, [step.text]);
          if (result.ok === false) {
            // The option is worded differently on the page: Jev picks among the real ones.
            const own = page.options.filter((option) => option.ref === grounded.ref);
            if (own.length > 0) {
              const pick = await ground(
                options.jev,
                step.text,
                "option",
                own.map((option) => ({ ref: option.id, line: option.line })),
                where,
                signal,
                { usage, content },
              );
              const option = own.find((entry) => entry.id === pick.grounded.ref);
              if (option && confident(pick.grounded))
                result = await selectOptions(ctx, grounded.ref, [option.label]);
            }
          }
          did = result.summary;
          break;
        }
        case "press": {
          const keys = step.text ?? "Enter";
          let ref: string | undefined;
          if (step.target) {
            const grounded = await find("type", page.typing.length ? page.typing : page.fields);
            if ("stop" in grounded) return grounded;
            if (!confident(grounded))
              return notFound(grounded, `no field clearly matches ${JSON.stringify(step.target)}`);
            ref = grounded.ref;
          }
          const gate = gateOf("press", { keys, ...(ref ? { ref } : {}) });
          if (gate.scope !== "browser:interact")
            return finish(
              "needs-approval",
              `${stepName} submits a form (${gate.reason ?? gate.scope}); press it with commit: true if the user's request authorizes it`,
            );
          result = await pressKeys(ctx, keys, ref);
          did = result.summary;
          break;
        }
        default: {
          let ref: string | undefined;
          if (step.target) {
            const grounded = await find("click", [...page.clicks, ...page.fields]);
            if ("stop" in grounded) return grounded;
            if (confident(grounded)) ref = grounded.ref;
            else
              return notFound(
                grounded ?? NOTHING,
                `nothing clearly matches ${JSON.stringify(step.target)}`,
              );
          }
          result = await scrollPage(ctx, {
            direction: step.direction ?? "down",
            amount: "page",
            ...(ref ? { ref } : {}),
          });
          did = result.summary;
        }
      }
    }
    if (result.tab) ctx.tab = result.tab;
    log.push(did);
    acted = true;
    if (result.ok === false)
      return finish(
        "error",
        `${stepName} did not work: ${result.summary}`,
        result.extra ? [result.extra] : [],
      );
  }
  return finish("done", `ran all ${input.steps.length} steps; check the page below`);
}
