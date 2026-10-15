import type { PageModel, PageNode } from "../page/model.ts";
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

// While text goes in, the field's document refuses form submission: typing must never
// submit (a line break or a stray Enter would). Submitting is an explicit, gated step.
const SUBMIT_GUARD = `function () {
  var view = this.ownerDocument.defaultView;
  var guard = function (event) { event.preventDefault(); event.stopImmediatePropagation(); guard.blocked++; };
  guard.blocked = 0;
  view.addEventListener("submit", guard, true);
  view.__muSubmitGuard = guard;
}`;
const SUBMIT_UNGUARD = `function () {
  var view = this.ownerDocument.defaultView, guard = view.__muSubmitGuard;
  if (!guard) return 0;
  view.removeEventListener("submit", guard, true);
  delete view.__muSubmitGuard;
  return guard.blocked;
}`;

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
  // A single-line input cannot hold a line break, and every way of entering one there
  // (Enter, Shift+Enter, inserted "\n") submits its form.
  const typed = info.tag === "input" ? text.replace(/\r\n?|\n/g, " ") : text;
  const notices = typed === text ? [] : ["line breaks became spaces (the field holds one line)"];
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
      await call(target, SUBMIT_GUARD, [], signal).catch(() => {});
      let blocked = 0;
      try {
        if (options.keystrokes) {
          await typeKeystrokes(tab.session, typed, signal);
        } else if (info.editable === "rich") {
          // Shift+Enter is a line break in every rich editor; a bare Enter sends in chat
          // composers, and inserting "\n" corrupts some editors (Draft.js).
          const lines = typed.split(/\r?\n/);
          for (let index = 0; index < lines.length; index++) {
            if (index > 0) await pressCombo(tab.session, parseKeys("Shift+Enter"), signal);
            const line = lines[index] as string;
            if (line)
              await tab.session.send(
                "Input.insertText",
                { text: line },
                { signal, timeoutMs: 5_000 },
              );
          }
        } else {
          await tab.session.send("Input.insertText", { text: typed }, { signal, timeoutMs: 5_000 });
        }
      } finally {
        blocked = await call<number>(target, SUBMIT_UNGUARD, [], signal).catch(() => 0);
      }
      if (blocked > 0)
        notices.push(
          "the page tried to submit the form while typing; mu blocked it (submit with submit: true or the form's submit button)",
        );
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
        : typed;
  const mismatch =
    expected !== undefined &&
    (info.editable === "rich"
      ? !normalize(actual).includes(normalize(expected).split("\n")[0] ?? "")
      : normalize(actual) !== normalize(expected));
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
  const noticeText = notices.map((notice) => `; ${notice}`).join("");
  return {
    summary: `typed ${shown} into ${label}${submitted}${noticeText}${mismatchNote}${suggestions}${settleNote(settle)}`,
    path: "keyboard",
    ...(notices.length ? { notices } : {}),
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
    const inner = await soleCheckable(ctx, ref);
    if (inner) return setChecked(ctx, inner, checked);
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

const CHECKABLE_ROLES = new Set([
  "checkbox",
  "radio",
  "switch",
  "menuitemcheckbox",
  "menuitemradio",
]);

// A clickable wrapper around a single checkbox or radio stands for that control.
async function soleCheckable(ctx: ActionContext, ref: string): Promise<string | undefined> {
  const model = await ctx.stopwatch.time("snapshotMs", () =>
    capturePage(ctx.tab, { scope: "full", signal: ctx.signal }),
  );
  const wrapper = findNode(model.root, ref);
  const inner = wrapper
    ? collect(wrapper).filter((node) => node !== wrapper && CHECKABLE_ROLES.has(node.role))
    : [];
  return inner.length === 1 ? inner[0]?.ref : undefined;
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

// Case and punctuation aside: "India (+91)" is the option "India +91".
function loose(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function pickOption(
  candidates: PageNode[],
  wanted: string,
  loosest: "contains" | "starts" = "contains",
): PageNode | undefined {
  const named = candidates.filter((node) => node.ref && node.name);
  const byRole = (nodes: PageNode[]) => nodes.find((node) => node.role === "option") ?? nodes[0];
  const exact = named.filter(
    (node) => node.name.trim().toLowerCase() === wanted.trim().toLowerCase(),
  );
  if (exact.length > 0) return byRole(exact);
  const target = loose(wanted);
  if (!target) return undefined;
  for (const matches of [
    (name: string) => name === target,
    (name: string) => name.startsWith(target),
    ...(loosest === "contains" ? [(name: string) => name.includes(target)] : []),
  ]) {
    const found = named.filter((node) => matches(loose(node.name)));
    if (found.length > 0) return byRole(found);
  }
  return undefined;
}

// The list a combobox says it opened: aria-controls/aria-owns, the list holding its
// active option, or a list inside it.
const POPUPS = `function () {
  var root = this.getRootNode ? this.getRootNode() : document;
  var byId = function (id) { return (root.getElementById && root.getElementById(id)) || document.getElementById(id); };
  var lists = '[role=listbox],[role=menu],[role=tree],[role=grid]';
  var found = [];
  var self = this;
  ["aria-controls", "aria-owns"].forEach(function (name) {
    (self.getAttribute(name) || "").split(" ").forEach(function (id) {
      var el = id && byId(id);
      if (el) found.push(el);
    });
  });
  var active = this.getAttribute("aria-activedescendant");
  var option = active && byId(active);
  if (option) found.push(option.closest(lists) || option.parentElement);
  var inner = this.querySelector(lists);
  if (inner) found.push(inner);
  return found;
}`;

async function popupNodeIds(target: ResolvedRef, signal?: AbortSignal): Promise<Set<number>> {
  const ids = new Set<number>();
  const send = { signal, timeoutMs: 3_000 };
  const { result } = await target.session.send(
    "Runtime.callFunctionOn",
    { objectId: target.objectId, functionDeclaration: POPUPS, objectGroup: "mu-action" },
    send,
  );
  if (!result.objectId) return ids;
  const { result: entries } = await target.session.send(
    "Runtime.getProperties",
    { objectId: result.objectId, ownProperties: true },
    send,
  );
  const add = (node: { backendNodeId: number; children?: unknown[]; shadowRoots?: unknown[] }) => {
    ids.add(node.backendNodeId);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])])
      add(child as typeof node);
  };
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name) || !entry.value?.objectId) continue;
    const described = await target.session
      .send("DOM.describeNode", { objectId: entry.value.objectId, depth: -1, pierce: true }, send)
      .catch(() => undefined);
    if (described) add(described.node);
  }
  return ids;
}

interface OpenedList {
  candidates: PageNode[];
  // Text the opened list shows when it has no options ("No options").
  notes: string[];
  expanded: string | null;
}

// Only the opened list's options are choices, never other controls on the page that
// share a name (forms repeat Yes/No): the list the combobox names, else what appeared.
async function openedList(
  ctx: ActionContext,
  target: ResolvedRef,
  before: Set<string>,
): Promise<OpenedList> {
  const { tab, signal } = ctx;
  const model = await ctx.stopwatch.time("snapshotMs", () =>
    capturePage(tab, { scope: "full", signal }),
  );
  const expanded = await call<string | null>(
    target,
    "function () { return this.getAttribute('aria-expanded'); }",
    [],
    signal,
  ).catch(() => null);
  const popup = await popupNodeIds(target, signal).catch(() => new Set<number>());
  const nodes = collect(model.root).filter((node) => node.ref !== target.ref);
  // The combobox's own list counts even where it runs past the viewport (it opens
  // below the field); anything else must be on screen.
  if (popup.size > 0) {
    const inside = nodes.filter(
      (node) =>
        node.frameId === target.frameId &&
        node.backendNodeId !== undefined &&
        popup.has(node.backendNodeId),
    );
    return {
      candidates: inside.filter((node) => OPTION_ROLES.has(node.role)),
      notes: inside.filter((node) => node.kind === "text" && node.name).map((node) => node.name),
      expanded,
    };
  }
  const appeared = nodes.filter((node) => node.inViewport && !before.has(shownKey(node)));
  return {
    candidates: appeared.filter((node) => OPTION_ROLES.has(node.role) && node.ref),
    notes: appeared.filter((node) => node.kind === "text" && node.name).map((node) => node.name),
    expanded,
  };
}

// Resolves true at the page's next structural change, false after `cap` ms.
const NEXT_CHANGE = `function (cap) {
  return new Promise(function (resolve) {
    var timer;
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].type !== "attributes" || records[i].attributeName !== "style") {
          observer.disconnect(); clearTimeout(timer); resolve(true);
          return;
        }
      }
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    timer = setTimeout(function () { observer.disconnect(); resolve(false); }, cap);
  });
}`;
const LIST_WAIT_MS = 4_000;
const LIST_CHANGE_MS = 1_000;
const LOADING_NOTE = /\b(loading|searching|fetching)\b/i;

// Suggestions a search fetches (a school list) can arrive after typing has settled,
// so an open list without the option is read again each time the page changes.
async function awaitOption(
  ctx: ActionContext,
  target: ResolvedRef,
  before: Set<string>,
  wanted: string,
  initial: OpenedList,
  options: { loosest?: "contains" | "starts"; onlyWhileLoading?: boolean } = {},
): Promise<{ list: OpenedList; option: PageNode | undefined }> {
  let list = initial;
  let option = pickOption(list.candidates, wanted, options.loosest);
  const deadline = performance.now() + LIST_WAIT_MS;
  while (!option && list.expanded !== "false") {
    const loading = list.notes.some((note) => LOADING_NOTE.test(note));
    const open =
      loading || list.expanded === "true" || list.candidates.length > 0 || list.notes.length > 0;
    if (!open || (options.onlyWhileLoading && !loading)) break;
    const left = deadline - performance.now();
    if (left <= 0) break;
    const watcher = watchSettle(ctx.tab, "in-page");
    const changed = await call<boolean>(
      target,
      NEXT_CHANGE,
      // A pending search leaves "Loading..." unchanged until its results arrive.
      [loading ? left : Math.min(left, LIST_CHANGE_MS)],
      ctx.signal,
    ).catch(() => false);
    if (!changed) {
      watcher.dispose();
      break;
    }
    await ctx.stopwatch.time("settleMs", () => watcher.settle(ctx.signal));
    list = await openedList(ctx, target, before);
    option = pickOption(list.candidates, wanted, options.loosest);
  }
  return { list, option };
}

function shownKey(node: PageNode): string {
  return node.ref ?? `${node.frameId} ${node.backendNodeId ?? ""} ${node.role} ${node.name}`;
}

// Everything captured before opening, on screen or not: opening often scrolls, and
// what scrolls into view did not appear.
function shown(model: PageModel): Set<string> {
  return new Set(collect(model.root).map(shownKey));
}

export async function selectOptions(
  ctx: ActionContext,
  ref: string,
  options: string[],
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const role = tab.refs.meta(ref)?.role;
  if (role === "radiogroup" || role === "group") {
    const results: ActionResult[] = [];
    for (const wanted of options) {
      const chosen = await chooseInGroup(ctx, ref, wanted);
      if (chosen.ok === false) return chosen;
      results.push(chosen);
    }
    const last = results[results.length - 1] as ActionResult;
    return { ...last, summary: results.map((result) => result.summary).join("; ") };
  }
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
  const typeable = info.combobox && info.editable !== "none";
  const chosen: string[] = [];
  for (const wanted of options) {
    const before = shown(
      await ctx.stopwatch.time("snapshotMs", () => capturePage(tab, { scope: "full", signal })),
    );
    // Real keystrokes: many comboboxes (react-select) open their list only on key events.
    const opened = typeable
      ? await typeText(ctx, ref, wanted, { keystrokes: true })
      : await clickRef(ctx, ref);
    if (opened.ok === false) return opened;
    let list = await openedList(ctx, target, before);
    if (list.candidates.length === 0 && list.expanded === "false") {
      const watcher = watchSettle(tab, typeable ? "typing" : "in-page");
      await pressCombo(tab.session, parseKeys("ArrowDown"), signal);
      await ctx.stopwatch.time("settleMs", () => watcher.settle(signal));
      list = await openedList(ctx, target, before);
    }
    let option: PageNode | undefined;
    ({ list, option } = await awaitOption(ctx, target, before, wanted, list));
    // A filter that matches the option's text verbatim finds nothing for "India (+91)"
    // when the option reads "India +91": retry with the words before the punctuation.
    const shorter = wanted.split(/[^\p{L}\p{N}\s]/u)[0]?.trim() ?? "";
    if (!option && typeable && shorter && shorter !== wanted.trim()) {
      const retyped = await typeText(ctx, ref, shorter, { keystrokes: true });
      if (retyped.ok === false) return retyped;
      ({ list, option } = await awaitOption(
        ctx,
        target,
        before,
        wanted,
        await openedList(ctx, target, before),
      ));
    }
    if (!option?.ref) {
      const choices = list.candidates
        .filter((node) => node.name)
        .slice(0, 15)
        .map((node) => JSON.stringify(node.name));
      if (choices.length === 0) {
        const notes = list.notes.slice(0, 3).map((note) => JSON.stringify(note));
        return {
          ok: false,
          kind: "error",
          summary:
            notes.length > 0 || list.expanded === "true"
              ? `${label} lists no option matching ${JSON.stringify(wanted)}`
              : `${label} did not open a list of options for ${JSON.stringify(wanted)}`,
          extra:
            notes.length > 0
              ? `the list says: ${notes.join(", ")}`
              : list.expanded === "true"
                ? "type less of the option's text, or snapshot to see what the list offers"
                : "click it to open the list, then snapshot and click the option; or type part of the option and look at the suggestions",
        };
      }
      return {
        ok: false,
        kind: "error",
        summary: `opened ${label} but found no option matching ${JSON.stringify(wanted)}`,
        extra: `its choices: ${choices.join(", ")}`,
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

const CHOICE_ROLES = new Set([
  "radio",
  "checkbox",
  "switch",
  "button",
  "option",
  "menuitemradio",
  "menuitemcheckbox",
  "clickable",
]);
const FIELD_ROLES = new Set(["combobox", "textbox", "searchbox", "spinbutton", "listbox"]);

// A question group is answered by one of its own choices (radios, Yes/No buttons,
// checkboxes), never a same-named control elsewhere on the page (forms repeat Yes/No);
// a group holding a single field is that field.
async function chooseInGroup(
  ctx: ActionContext,
  ref: string,
  wanted: string,
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const label = tab.refs.label(ref);
  const model = await ctx.stopwatch.time("snapshotMs", () =>
    capturePage(tab, { scope: "full", signal }),
  );
  const group = findNode(model.root, ref);
  const inside = group ? collect(group).filter((node) => node !== group && node.ref) : [];
  const choices = inside.filter((node) => CHOICE_ROLES.has(node.role) && node.name);
  if (choices.length === 0) {
    const fields = inside.filter(
      (node) => FIELD_ROLES.has(node.role) || node.editable || node.options,
    );
    if (fields.length === 1 && fields[0]?.ref)
      return fillField(ctx, { ref: fields[0].ref, value: wanted });
    return {
      ok: false,
      kind: "error",
      summary: `${label} holds no choice or single field to set to ${JSON.stringify(wanted)}; set one of its controls by its ref`,
    };
  }
  const choice = pickOption(choices, wanted, "starts");
  if (!choice?.ref)
    return {
      ok: false,
      kind: "error",
      summary: `${label} has no choice ${JSON.stringify(wanted)}`,
      extra: `choices: ${choices.map((node) => JSON.stringify(node.name)).join(", ")}`,
    };
  if (CHECKABLE_ROLES.has(choice.role)) {
    const checked = await setChecked(ctx, choice.ref, true);
    return checked.ok === false
      ? checked
      : { ...checked, summary: `${checked.summary} in ${label}` };
  }
  const chosen = `${JSON.stringify(choice.name)} in ${label}`;
  if (choice.states.pressed || choice.states.selected)
    return { summary: `${chosen} was already chosen`, kind: "no-change" };
  const clicked = await clickRef(ctx, choice.ref);
  if (clicked.ok === false) return clicked;
  if (choice.states.pressed === false) {
    const pressed = await resolveRef(tab, choice.ref, signal)
      .then((fresh) =>
        call<string | null>(
          fresh,
          "function () { return this.getAttribute('aria-pressed'); }",
          [],
          signal,
        ),
      )
      .catch(() => null);
    if (pressed !== "true")
      return {
        ok: false,
        kind: "value-mismatch",
        summary: `clicked ${chosen} but it is not pressed`,
      };
  }
  return { ...clicked, summary: `chose ${chosen}` };
}

// A checkbox or radio given text: its own label ("No" for the radio "No") checks it.
function checkedBy(ctx: ActionContext, ref: string, value: string): boolean {
  const name = ctx.tab.refs.meta(ref)?.name ?? "";
  if (name && loose(name) === loose(value)) return true;
  return !/^(false|no|off|0|)$/i.test(value);
}

// Typed with keystrokes so key-driven lists open; a suggestion that is the value (or
// starts with it) is taken, anything looser keeps the typed text. Text the field drops
// when it loses focus (react-select) was never its value: then pick from the list.
async function fillCombobox(
  ctx: ActionContext,
  target: ResolvedRef,
  value: string,
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const before = shown(
    await ctx.stopwatch.time("snapshotMs", () => capturePage(tab, { scope: "full", signal })),
  );
  const typed = await typeText(ctx, target.ref, value, { keystrokes: true });
  if (typed.ok === false) return typed;
  // Free text is fine here, so only a list that says it is still loading is waited on.
  const { option: suggestion } = await awaitOption(
    ctx,
    target,
    before,
    value,
    await openedList(ctx, target, before),
    { loosest: "starts", onlyWhileLoading: true },
  );
  if (suggestion?.ref) {
    const clicked = await clickRef(ctx, suggestion.ref);
    if (clicked.ok === false) return clicked;
    return {
      ...typed,
      summary: `${typed.summary}; picked suggestion ${JSON.stringify(suggestion.name)}`,
    };
  }
  const kept = await call<string>(
    target,
    `function () {
      this.blur();
      var el = this;
      return new Promise(function (done) {
        setTimeout(function () { done(String(el.isContentEditable ? el.innerText : el.value == null ? "" : el.value)); }, 50);
      });
    }`,
    [],
    signal,
  );
  if (loose(kept).includes(loose(value))) return typed;
  return selectOptions(ctx, target.ref, [value]);
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
  if (role === "radiogroup" || role === "group") return chooseInGroup(ctx, field.ref, field.value);
  const target = await resolveRef(ctx.tab, field.ref, ctx.signal);
  const info = await fieldInfo(target, ctx.signal);
  if (info.tag === "select" || (info.editable === "none" && !info.checkable)) {
    const inner = info.tag === "select" ? undefined : await soleCheckable(ctx, field.ref);
    if (inner) return setChecked(ctx, inner, checkedBy(ctx, inner, field.value));
    return selectOptions(ctx, field.ref, [field.value]);
  }
  if (info.checkable) return setChecked(ctx, field.ref, checkedBy(ctx, field.ref, field.value));
  const date = parseDate(field.value);
  if (
    date &&
    ((info.tag === "input" && (info.type === "date" || info.type === "month")) ||
      info.readOnly ||
      DATE_FIELD.test(ctx.tab.refs.label(field.ref)))
  )
    return setDate(ctx, field.ref, field.value, date, info);
  if (info.combobox) return fillCombobox(ctx, target, field.value);
  return typeText(ctx, field.ref, field.value, { settle: false });
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
  let mismatched = false;
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
      if (result.kind === "value-mismatch") {
        notes.push(result.summary);
        mismatched = true;
      } else if (result.summary.includes("picked suggestion")) notes.push(result.summary);
      else if (result.notices)
        notes.push(`${tab.refs.label(field.ref)}: ${result.notices.join("; ")}`);
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
    ...(mismatched ? { kind: "value-mismatch" as const } : {}),
    ...(extra ? { extra } : {}),
  };
}
