import type { PageNode } from "../page/model.ts";
import { type ResolvedRef, resolveRef } from "../page/resolve.ts";
import { type SettleResult, watchSettle } from "../page/settle.ts";
import { capturePage } from "../page/snapshot.ts";
import { type ActionContext, type ActionResult, clickRef, mainPoint, raceDialog } from "./click.ts";
import {
  type DateTarget,
  isoFor,
  MONTHS,
  namesDate,
  parseDate,
  periodOf,
  shownPeriod,
} from "./dates.ts";
import { parseKeys, pressCombo, typeKeystrokes } from "./keyboard.ts";
import { clickablePoint, mouseClick } from "./pointer.ts";

interface FieldInfo {
  tag: string;
  type: string;
  role: string;
  editable: "value" | "rich" | "none";
  secret: boolean;
  disabled: boolean;
  readOnly: boolean;
  combobox: boolean;
  checkable: boolean;
  checked?: boolean;
  multiple?: boolean;
}

const OTP = "otp|one.?time|2fa|totp|verification.?code|mfa|security.?code";

const FIELD_INFO = `function () {
  var tag = this.tagName.toLowerCase(), type = (this.type || "").toLowerCase();
  var role = (this.getAttribute("role") || "").toLowerCase();
  var rich = this.isContentEditable;
  var hint = (this.autocomplete || "") + " " + (this.name || "") + " " + (this.id || "");
  var ariaChecked = this.getAttribute("aria-checked") || this.getAttribute("aria-pressed");
  var checkable = type === "checkbox" || type === "radio" || role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox" || role === "menuitemradio" || ariaChecked !== null;
  return {
    tag: tag, type: type, role: role,
    editable: (tag === "input" && !/^(checkbox|radio|button|submit|reset|file|image|hidden|range|color)$/.test(type)) || tag === "textarea" ? "value" : rich ? "rich" : "none",
    secret: type === "password" || /one-time-code/.test(this.autocomplete || "") || new RegExp("${OTP}", "i").test(hint),
    disabled: !!this.disabled || this.getAttribute("aria-disabled") === "true",
    readOnly: !!this.readOnly || this.getAttribute("aria-readonly") === "true",
    combobox: role === "combobox" || this.hasAttribute("aria-autocomplete") || (tag === "input" && this.hasAttribute("list")),
    checkable: checkable,
    checked: type === "checkbox" || type === "radio" ? this.checked : ariaChecked === null ? undefined : ariaChecked === "true",
    multiple: tag === "select" ? this.multiple : undefined
  };
}`;

async function fieldInfo(target: ResolvedRef, signal?: AbortSignal): Promise<FieldInfo> {
  const result = await target.session.send(
    "Runtime.callFunctionOn",
    { objectId: target.objectId, functionDeclaration: FIELD_INFO, returnByValue: true },
    { signal, timeoutMs: 3_000 },
  );
  return result.result.value as FieldInfo;
}

async function call<T>(
  target: ResolvedRef,
  functionDeclaration: string,
  args: unknown[] = [],
  signal?: AbortSignal,
): Promise<T> {
  const result = await target.session.send(
    "Runtime.callFunctionOn",
    {
      objectId: target.objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    },
    { signal, timeoutMs: 5_000 },
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value as T;
}

function quoteValue(text: string, secret: boolean): string {
  if (secret) return "••••";
  const clipped = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  return JSON.stringify(clipped);
}

function settleNote(settle: SettleResult | undefined): string {
  if (!settle) return "";
  if (settle.navigated) return " → navigated";
  if (settle.reason.startsWith("a JavaScript dialog")) return " → a JavaScript dialog opened";
  return "";
}

const NATIVE_VALUE_TYPES = /^(date|time|datetime-local|month|week|color|range)$/;

// Values the user types in any common shape, converted to what <input type=date> accepts.
export function normalizeDateValue(type: string, value: string): string {
  const trimmed = value.trim();
  if (type !== "date") return trimmed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

const SET_NATIVE_VALUE = `function (value) {
  var proto = this.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(this, value);
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return this.value;
}`;

async function focusField(ctx: ActionContext, target: ResolvedRef): Promise<void> {
  const focused = await target.session
    .send(
      "DOM.focus",
      { backendNodeId: target.backendNodeId },
      { signal: ctx.signal, timeoutMs: 3_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (focused && target.session === ctx.tab.session) return;
  // Out-of-process frames only receive keys once their frame has focus: click into it.
  const point = await clickablePoint(target, { width: 10_000, height: 10_000 }, ctx.signal);
  if (!point) {
    if (!focused) throw new Error("the field cannot be focused");
    return;
  }
  await mouseClick(ctx.tab.session, await mainPoint(ctx, target, point), { signal: ctx.signal });
}

export interface TypeOptions {
  clear?: boolean;
  submit?: boolean;
  keystrokes?: boolean;
  // Skip settling (fill_form settles once at the end).
  settle?: boolean;
}

export async function typeText(
  ctx: ActionContext,
  ref: string,
  text: string,
  options: TypeOptions = {},
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const target = await ctx.stopwatch.time("cdpMs", () => resolveRef(tab, ref, signal));
  const label = tab.refs.label(ref);
  const info = await fieldInfo(target, signal);
  if (info.disabled || info.readOnly) {
    return {
      ok: false,
      kind: "not-interactable",
      summary: `${label} is ${info.disabled ? "disabled" : "read-only"}; it cannot be typed into`,
    };
  }
  if (info.editable === "none" && !info.combobox) {
    return {
      ok: false,
      kind: "not-interactable",
      summary: `${label} is not a text field (${info.tag}${info.type ? ` type=${info.type}` : ""}); click it or use select/fill_form`,
    };
  }
  if (info.secret) ctx.browser.secrets.add(text);
  const shown = quoteValue(text, info.secret);
  const watcher =
    options.settle === false ? undefined : watchSettle(tab, info.combobox ? "typing" : "in-page");
  let actual: string;
  try {
    await ctx.stopwatch.time("cdpMs", async () => {
      if (info.tag === "input" && NATIVE_VALUE_TYPES.test(info.type)) {
        await call(target, SET_NATIVE_VALUE, [normalizeDateValue(info.type, text)], signal);
        return;
      }
      await focusField(ctx, target);
      if (options.clear !== false) {
        const had = await call<number>(
          target,
          `function () {
            if (this.isContentEditable) {
              var range = document.createRange(); range.selectNodeContents(this);
              var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
              return (this.innerText || "").length;
            }
            if (typeof this.select === "function") this.select();
            return (this.value || "").length;
          }`,
          [],
          signal,
        );
        if (had > 0) await pressCombo(tab.session, parseKeys("Backspace"), signal);
      } else {
        await call(
          target,
          `function () {
            if (this.isContentEditable) {
              var range = document.createRange(); range.selectNodeContents(this); range.collapse(false);
              var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
            } else if (typeof this.setSelectionRange === "function") {
              try { var n = (this.value || "").length; this.setSelectionRange(n, n); } catch (e) {}
            }
          }`,
          [],
          signal,
        );
      }
      if (options.keystrokes) {
        await typeKeystrokes(tab.session, text, signal);
      } else if (info.editable === "rich" || (info.tag === "input" && text.includes("\n"))) {
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (index > 0) await pressCombo(tab.session, parseKeys("Enter"), signal);
          const line = lines[index] as string;
          if (line)
            await tab.session.send(
              "Input.insertText",
              { text: line },
              { signal, timeoutMs: 5_000 },
            );
        }
      } else {
        await tab.session.send("Input.insertText", { text }, { signal, timeoutMs: 5_000 });
      }
    });
    actual = await call<string>(
      target,
      "function () { return this.isContentEditable ? this.innerText : String(this.value == null ? '' : this.value); }",
      [],
      signal,
    );
    if (options.submit) {
      await ctx.stopwatch.time("cdpMs", () =>
        raceDialog(tab, pressCombo(tab.session, parseKeys("Enter"), signal)),
      );
    }
  } catch (error) {
    watcher?.dispose();
    throw error;
  }
  const settle = watcher
    ? await ctx.stopwatch.time("settleMs", () => watcher.settle(signal))
    : undefined;
  const normalize = (value: string) => value.replace(/\r\n?/g, "\n").replace(/ /g, " ").trim();
  const expected =
    info.tag === "input" && NATIVE_VALUE_TYPES.test(info.type)
      ? normalizeDateValue(info.type, text)
      : options.clear === false
        ? undefined
        : text;
  const mismatch =
    expected !== undefined &&
    (info.editable === "rich"
      ? !normalize(actual).includes(normalize(expected).split("\n")[0] ?? "")
      : normalize(actual) !== normalize(expected.replace(/\n/g, info.tag === "input" ? "" : "\n")));
  let suggestions = "";
  if (info.combobox && !settle?.navigated) {
    const expanded = await resolveRef(tab, ref, signal)
      .then((fresh) =>
        call<boolean>(
          fresh,
          `function () {
            if (this.getAttribute("aria-expanded") === "true") return true;
            var id = this.getAttribute("aria-controls") || this.getAttribute("aria-owns");
            var list = id && document.getElementById(id);
            return !!(list && list.offsetParent !== null && list.children.length > 0);
          }`,
          [],
          signal,
        ),
      )
      .catch(() => false);
    suggestions = expanded
      ? " → suggestions appeared (new options are marked * below)"
      : " (no suggestions shown yet)";
  }
  const submitted = options.submit ? " and pressed Enter" : "";
  const mismatchNote = mismatch
    ? `; the field now shows ${quoteValue(actual, info.secret)} (reformatted, masked, or changed by the page)`
    : "";
  return {
    summary: `typed ${shown} into ${label}${submitted}${mismatchNote}${suggestions}${settleNote(settle)}`,
    path: "keyboard",
    ...(settle ? { settle: `${settle.reason} (${settle.ms} ms)` } : {}),
    ...(mismatch ? { kind: "value-mismatch" as const } : {}),
    ...(settle?.navigated ? { kind: "navigated" as const } : {}),
  };
}

export async function pressKeys(
  ctx: ActionContext,
  keys: string,
  ref?: string,
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const combo = parseKeys(keys);
  let where = "";
  if (ref) {
    const target = await resolveRef(tab, ref, signal);
    await focusField(ctx, target);
    where = ` in ${tab.refs.label(ref)}`;
  }
  const watcher = watchSettle(tab, "in-page");
  try {
    await ctx.stopwatch.time("cdpMs", () =>
      raceDialog(tab, pressCombo(tab.session, combo, signal)),
    );
  } catch (error) {
    watcher.dispose();
    throw error;
  }
  const settle = await ctx.stopwatch.time("settleMs", () => watcher.settle(signal));
  return {
    summary: `pressed ${combo.label}${where}${settleNote(settle)}`,
    path: "keyboard",
    settle: `${settle.reason} (${settle.ms} ms)`,
    ...(settle.navigated ? { kind: "navigated" as const } : {}),
  };
}

export async function setChecked(
  ctx: ActionContext,
  ref: string,
  checked: boolean,
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const target = await resolveRef(tab, ref, signal);
  const label = tab.refs.label(ref);
  const info = await fieldInfo(target, signal);
  if (!info.checkable) {
    return {
      ok: false,
      kind: "not-interactable",
      summary: `${label} is not a checkbox, radio or switch`,
    };
  }
  if (info.checked === checked) {
    return {
      summary: `${label} was already ${checked ? "checked" : "unchecked"}`,
      kind: "no-change",
    };
  }
  if (!checked && info.type === "radio") {
    return {
      ok: false,
      kind: "not-interactable",
      summary: `${label} is a radio button; choose another option in its group instead of unchecking it`,
    };
  }
  const clicked = await clickRef(ctx, ref);
  if (clicked.ok === false) return clicked;
  const after = await resolveRef(tab, ref, signal)
    .then((fresh) => fieldInfo(fresh, signal))
    .catch(() => undefined);
  if (after && after.checked !== undefined && after.checked !== checked) {
    return {
      ok: false,
      kind: "value-mismatch",
      summary: `clicked ${label} but it is still ${after.checked ? "checked" : "unchecked"}`,
    };
  }
  return { ...clicked, summary: `${checked ? "checked" : "unchecked"} ${label}` };
}

function collect(node: PageNode, out: PageNode[] = []): PageNode[] {
  out.push(node);
  for (const child of node.children) collect(child, out);
  return out;
}

const OPTION_ROLES = new Set([
  "option",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "treeitem",
  "gridcell",
  "clickable",
  "listitem",
  "radio",
  "link",
  "button",
]);

function pickOption(candidates: PageNode[], wanted: string): PageNode | undefined {
  const target = wanted.trim().toLowerCase();
  const named = candidates.filter((node) => node.ref && node.name);
  const byRole = (nodes: PageNode[]) => nodes.find((node) => node.role === "option") ?? nodes[0];
  const exact = named.filter((node) => node.name.trim().toLowerCase() === target);
  if (exact.length > 0) return byRole(exact);
  const starts = named.filter((node) => node.name.trim().toLowerCase().startsWith(target));
  if (starts.length > 0) return byRole(starts);
  const contains = named.filter((node) => node.name.toLowerCase().includes(target));
  return contains.length > 0 ? byRole(contains) : undefined;
}

export async function selectOptions(
  ctx: ActionContext,
  ref: string,
  options: string[],
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const target = await resolveRef(tab, ref, signal);
  const label = tab.refs.label(ref);
  const info = await fieldInfo(target, signal);
  if (info.tag === "select") {
    const watcher = watchSettle(tab, "in-page");
    let result: { chosen: string[]; missing: string[]; available: string[] };
    try {
      result = await call(
        target,
        `function (wanted) {
          var opts = Array.prototype.slice.call(this.options);
          var norm = function (s) { return String(s).trim().toLowerCase(); };
          var chosen = [], missing = [];
          if (!this.multiple && wanted.length > 1) wanted = wanted.slice(0, 1);
          var picks = wanted.map(function (w) {
            var o = opts.find(function (o) { return norm(o.label || o.text) === norm(w) || norm(o.value) === norm(w); })
              || opts.find(function (o) { return norm(o.label || o.text).indexOf(norm(w)) === 0; });
            if (!o) missing.push(w); else chosen.push(o.label || o.text);
            return o;
          });
          if (missing.length === 0) {
            opts.forEach(function (o) { o.selected = picks.indexOf(o) >= 0; });
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return { chosen: chosen, missing: missing, available: opts.map(function (o) { return o.label || o.text; }).slice(0, 40) };
        }`,
        [options],
        signal,
      );
    } catch (error) {
      watcher.dispose();
      throw error;
    }
    if (result.missing.length > 0) {
      watcher.dispose();
      return {
        ok: false,
        kind: "error",
        summary: `${label} has no option ${result.missing.map((m) => JSON.stringify(m)).join(", ")}`,
        extra: `options: ${result.available.map((option) => JSON.stringify(option)).join(", ")}`,
      };
    }
    const settle = await ctx.stopwatch.time("settleMs", () => watcher.settle(signal));
    return {
      summary: `selected ${result.chosen.map((c) => JSON.stringify(c)).join(", ")} in ${label}${settleNote(settle)}`,
      path: "js",
      settle: `${settle.reason} (${settle.ms} ms)`,
    };
  }
  // ARIA / custom dropdowns: open, then click the option by its visible name.
  const chosen: string[] = [];
  for (const wanted of options) {
    if (info.combobox && info.editable !== "none") {
      const typed = await typeText(ctx, ref, wanted);
      if (typed.ok === false) return typed;
    } else {
      const opened = await clickRef(ctx, ref);
      if (opened.ok === false) return opened;
    }
    const model = await ctx.stopwatch.time("snapshotMs", () =>
      capturePage(tab, { scope: "full", signal }),
    );
    const candidates = collect(model.root).filter(
      (node) => node.ref !== ref && OPTION_ROLES.has(node.role) && node.inViewport,
    );
    const option = pickOption(candidates, wanted);
    if (!option?.ref) {
      const visible = candidates
        .filter((node) => node.name)
        .slice(0, 15)
        .map((node) => JSON.stringify(node.name));
      return {
        ok: false,
        kind: "error",
        summary: `opened ${label} but found no option matching ${JSON.stringify(wanted)}`,
        ...(visible.length > 0 ? { extra: `visible choices: ${visible.join(", ")}` } : {}),
      };
    }
    const clicked = await clickRef(ctx, option.ref);
    if (clicked.ok === false) return clicked;
    chosen.push(option.name);
  }
  return {
    summary: `selected ${chosen.map((c) => JSON.stringify(c)).join(", ")} in ${label}`,
    path: "mouse",
  };
}

export interface FormField {
  ref: string;
  value: string | boolean | string[];
}

function findNode(node: PageNode, ref: string): PageNode | undefined {
  if (node.ref === ref) return node;
  for (const child of node.children) {
    const found = findNode(child, ref);
    if (found) return found;
  }
  return undefined;
}

// A radio group set by the label of one of its own radios, never a radio elsewhere
// on the page with the same label (forms repeat Yes/No).
async function chooseInGroup(
  ctx: ActionContext,
  ref: string,
  wanted: string,
): Promise<ActionResult | undefined> {
  const model = await ctx.stopwatch.time("snapshotMs", () =>
    capturePage(ctx.tab, { scope: "full", signal: ctx.signal }),
  );
  const group = findNode(model.root, ref);
  const radios = group ? collect(group).filter((node) => node.role === "radio") : [];
  if (radios.length === 0) return undefined;
  const radio = pickOption(radios, wanted);
  if (!radio?.ref)
    return {
      ok: false,
      kind: "error",
      summary: `${ctx.tab.refs.label(ref)} has no choice ${JSON.stringify(wanted)}`,
      ...(radios.length > 0
        ? { extra: `choices: ${radios.map((node) => JSON.stringify(node.name)).join(", ")}` }
        : {}),
    };
  return clickRef(ctx, radio.ref);
}

// After typing into an autocomplete, take the suggestion that is the typed value
// (or starts with it); anything looser keeps the typed text.
async function takeSuggestion(
  ctx: ActionContext,
  ref: string,
  typed: string,
): Promise<string | undefined> {
  const model = await ctx.stopwatch.time("snapshotMs", () =>
    capturePage(ctx.tab, { scope: "full", signal: ctx.signal }),
  );
  const target = typed.trim().toLowerCase();
  const options = collect(model.root).filter(
    (node) => node.ref && node.ref !== ref && node.role === "option" && node.inViewport,
  );
  const match =
    options.find((node) => node.name.trim().toLowerCase() === target) ??
    options.find((node) => node.name.trim().toLowerCase().startsWith(target));
  if (!match?.ref) return undefined;
  const clicked = await clickRef(ctx, match.ref);
  return clicked.ok === false ? undefined : match.name;
}

// Labels of fields that take a date even when the page does not say so in markup.
const DATE_FIELD =
  /\b(date|month|year|from|to|start|end|birth|dob|since|until|expir\w*|graduat\w*)\b/i;
const PICKER_ROLES = new Set([
  "option",
  "gridcell",
  "cell",
  "button",
  "clickable",
  "link",
  "menuitem",
  "listitem",
]);
const NEXT = /\b(next|forward|later)\b|^[›»>]$/i;
const PREVIOUS = /\b(prev|previous|back|earlier)\b|^[‹«<]$/i;
const MAX_PICKER_STEPS = 30;

async function fieldValue(ctx: ActionContext, ref: string): Promise<string> {
  const target = await resolveRef(ctx.tab, ref, ctx.signal);
  return call<string>(
    target,
    "function () { return String(this.value != null ? this.value : this.innerText || ''); }",
    [],
    ctx.signal,
  );
}

// Native date inputs take an ISO value; custom fields are typed into, and when the
// typing does not stick, their picker is driven: open it, click the element that
// names the date, else pick the year/month in its dropdowns or step toward it.
async function setDate(
  ctx: ActionContext,
  ref: string,
  value: string,
  target: DateTarget,
  info: FieldInfo,
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const label = tab.refs.label(ref);
  if (info.tag === "input" && (info.type === "date" || info.type === "month")) {
    const iso = isoFor(info.type, target);
    if (!iso)
      return {
        ok: false,
        kind: "error",
        summary: `${label} needs ${info.type === "date" ? "a day, month and year" : "a month and year"}`,
      };
    const element = await resolveRef(tab, ref, signal);
    const watcher = watchSettle(tab, "in-page");
    try {
      await call(
        element,
        `function (v) {
          var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          set.call(this, v);
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
        }`,
        [iso],
        signal,
      );
    } catch (error) {
      watcher.dispose();
      throw error;
    }
    const settle = await ctx.stopwatch.time("settleMs", () => watcher.settle(signal));
    return { summary: `set ${label} to ${iso}${settleNote(settle)}`, path: "js" };
  }
  if (!info.readOnly && info.editable === "value") {
    const typed = await typeText(ctx, ref, value);
    if (typed.ok !== false) {
      // Many date fields only reject free text once focus leaves them.
      const element = await resolveRef(tab, ref, signal);
      const watcher = watchSettle(tab, "in-page");
      await call(element, "function () { this.blur(); }", [], signal).catch(() => {});
      await watcher.settle(signal);
      if ((await fieldValue(ctx, ref)).trim()) return typed;
    }
  }
  const opened = await clickRef(ctx, ref);
  if (opened.ok === false) return opened;
  let visible: PageNode[] = [];
  for (let step = 0; step < MAX_PICKER_STEPS; step++) {
    const model = await ctx.stopwatch.time("snapshotMs", () =>
      capturePage(tab, { scope: "full", signal }),
    );
    visible = collect(model.root).filter((node) => node.inViewport && node.ref !== ref);
    const shown = visible.map((node) => node.name).join(" | ");
    const usable = visible.filter((node) => node.ref && !node.states.disabled);
    const matches = usable.filter(
      (node) => PICKER_ROLES.has(node.role) && namesDate(node.name, target, shown),
    );
    const match =
      matches.find((node) => node.role === "option" || node.role === "gridcell") ?? matches[0];
    if (match?.ref) {
      const clicked = await clickRef(ctx, match.ref);
      if (clicked.ok === false) return clicked;
      if ((await fieldValue(ctx, ref)).trim())
        return { summary: `picked ${JSON.stringify(match.name)} in the date picker of ${label}` };
      continue;
    }
    const dropdowns = usable.filter((node) => node.options && node.options.length > 0);
    const year = String(target.year);
    // Only the first options are captured, so a long year list is recognised by
    // looking like years; the selection itself searches every option.
    const yearish = (text: string | undefined) => !!text && /^\s*(19|20|21)\d{2}\s*$/.test(text);
    const yearDropdown = dropdowns.find(
      (node) => (node.options?.some(yearish) || yearish(node.value)) && node.value?.trim() !== year,
    );
    if (yearDropdown?.ref) {
      const chosen = await selectOptions(ctx, yearDropdown.ref, [year]);
      if (chosen.ok === false) return chosen;
      continue;
    }
    const monthName = target.month ? (MONTHS[target.month - 1] as string) : undefined;
    const monthDropdown = monthName
      ? dropdowns.find(
          (node) =>
            node.options?.some((option) =>
              option.toLowerCase().startsWith(monthName.slice(0, 3)),
            ) && !node.value?.toLowerCase().startsWith(monthName.slice(0, 3)),
        )
      : undefined;
    if (monthDropdown?.ref && monthName) {
      const option = monthDropdown.options?.find((candidate) =>
        candidate.toLowerCase().startsWith(monthName.slice(0, 3)),
      ) as string;
      const chosen = await selectOptions(ctx, monthDropdown.ref, [option]);
      if (chosen.ok === false) return chosen;
      continue;
    }
    const period = shownPeriod(visible.map((node) => node.name));
    const wanted = periodOf(target);
    const forward = period === undefined ? step < 12 : period < wanted;
    const pattern = forward ? NEXT : PREVIOUS;
    const steppers = usable.filter(
      (node) =>
        (node.role === "button" || node.role === "clickable" || node.role === "link") &&
        pattern.test(node.name),
    );
    const byYear = period !== undefined && Math.abs(wanted - period) >= 12;
    const stepper = steppers.find((node) => /year/i.test(node.name) === byYear) ?? steppers[0];
    if (!stepper?.ref) break;
    const stepped = await clickRef(ctx, stepper.ref);
    if (stepped.ok === false) return stepped;
  }
  const choices = visible
    .filter((node) => node.ref && PICKER_ROLES.has(node.role) && node.name)
    .slice(0, 12)
    .map((node) => JSON.stringify(node.name));
  return {
    ok: false,
    kind: "error",
    summary: `could not set ${label} to ${JSON.stringify(value)}: the date picker did not offer it`,
    ...(choices.length > 0 ? { extra: `picker shows: ${choices.join(", ")}` } : {}),
  };
}

async function fillField(ctx: ActionContext, field: FormField): Promise<ActionResult> {
  if (typeof field.value === "boolean") return setChecked(ctx, field.ref, field.value);
  if (Array.isArray(field.value)) return selectOptions(ctx, field.ref, field.value);
  const role = ctx.tab.refs.meta(field.ref)?.role;
  if (role === "radiogroup" || role === "group") {
    const chosen = await chooseInGroup(ctx, field.ref, field.value);
    if (chosen) return chosen;
  }
  const target = await resolveRef(ctx.tab, field.ref, ctx.signal);
  const info = await fieldInfo(target, ctx.signal);
  if (info.tag === "select" || (info.editable === "none" && !info.checkable))
    return selectOptions(ctx, field.ref, [field.value]);
  if (info.checkable) return setChecked(ctx, field.ref, !/^(false|no|off|0|)$/i.test(field.value));
  const date = parseDate(field.value);
  if (
    date &&
    ((info.tag === "input" && (info.type === "date" || info.type === "month")) ||
      info.readOnly ||
      DATE_FIELD.test(ctx.tab.refs.label(field.ref)))
  )
    return setDate(ctx, field.ref, field.value, date, info);
  const typed = await typeText(ctx, field.ref, field.value, { settle: info.combobox });
  if (typed.ok === false || !info.combobox) return typed;
  const picked = await takeSuggestion(ctx, field.ref, field.value);
  return picked
    ? { ...typed, summary: `${typed.summary}; picked suggestion ${JSON.stringify(picked)}` }
    : typed;
}

// Fills every field it can and reports the rest, so one call covers a whole form
// step; the submit button is only clicked when every field went in.
export async function fillForm(
  ctx: ActionContext,
  fields: FormField[],
  submitRef?: string,
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const watcher = watchSettle(tab, "in-page");
  const done: string[] = [];
  const notes: string[] = [];
  const failed: string[] = [];
  try {
    for (const field of fields) {
      let result: ActionResult;
      try {
        result = await fillField(ctx, field);
      } catch (error) {
        if (signal.aborted) throw error;
        result = {
          ok: false,
          kind: "error",
          summary: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.ok === false) {
        failed.push(
          `${tab.refs.label(field.ref)}: ${result.summary}${result.extra ? ` (${result.extra})` : ""}`,
        );
        continue;
      }
      if (result.kind === "value-mismatch") notes.push(result.summary);
      else if (result.summary.includes("picked suggestion")) notes.push(result.summary);
      done.push(tab.refs.label(field.ref));
    }
  } catch (error) {
    watcher.dispose();
    throw error;
  }
  const settle = await ctx.stopwatch.time("settleMs", () => watcher.settle(signal));
  const count = failed.length > 0 ? `${done.length} of ${fields.length}` : `${fields.length}`;
  let summary = `filled ${count} field${fields.length === 1 ? "" : "s"}${done.length ? ` (${done.join(", ")})` : ""}`;
  const extra = [
    ...notes.map((note) => `note: ${note}`),
    ...failed.map((failure) => `failed: ${failure}`),
  ].join("\n");
  if (failed.length > 0)
    return {
      ok: false,
      kind: "error",
      summary: `${summary}; ${failed.length} failed${submitRef ? ", so nothing was submitted" : ""}`,
      extra,
    };
  if (submitRef) {
    const submitted = await clickRef(ctx, submitRef);
    if (submitted.ok === false) {
      return { ...submitted, summary: `${summary}; then ${submitted.summary}` };
    }
    summary = `${summary}; then ${submitted.summary}`;
    return { ...submitted, summary, ...(extra ? { extra } : {}) };
  }
  return {
    summary,
    settle: `${settle.reason} (${settle.ms} ms)`,
    ...(notes.some((note) => !note.includes("picked suggestion"))
      ? { kind: "value-mismatch" as const }
      : {}),
    ...(extra ? { extra } : {}),
  };
}
