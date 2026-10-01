import type { PageModel, PageNode } from "../page/model.ts";
import { describeNode, renderSnapshot } from "../page/render.ts";

export interface Candidate {
  ref: string;
  node: PageNode;
  // The element, then where it sits: its row or card, the heading above it, its landmark.
  line: string;
}

export interface SelectOption {
  // `<ref>:<n>`, the option's index within its dropdown.
  id: string;
  ref: string;
  label: string;
  line: string;
}

// What Jev can act on in one observation, in page order.
export interface PageCandidates {
  // Where a value can go: text fields, dropdowns, checkboxes, radio and checkbox groups.
  fields: Candidate[];
  // The checkbox group each grouped checkbox belongs to.
  groupOf: Map<string, PageNode>;
  // What a click can target: buttons, links, tabs, menu items, options, checkboxes, radios.
  clicks: Candidate[];
  // Where text can be typed (never password or one-time-code fields).
  typing: Candidate[];
  // Every visible option of every dropdown, capped.
  options: SelectOption[];
  canScroll: { up: boolean; down: boolean };
  text: string;
}

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
  "menuitemradio",
  "option",
  "treeitem",
  "clickable",
  "checkbox",
  "radio",
  "switch",
  "summary",
]);
const TYPING_ROLES = new Set(["textbox", "searchbox", "spinbutton", "time", "date", "datetime"]);
const MAX_OPTIONS_PER_SELECT = 40;
const MAX_OPTIONS = 250;
const MAX_LINE = 240;
// Containers whose own text tells apart identical controls ("Add to cart" per product).
const ITEM_ROLES = new Set([
  "listitem",
  "row",
  "article",
  "gridcell",
  "cell",
  "option",
  "treeitem",
]);
const LANDMARK_ROLES = new Set([
  "navigation",
  "banner",
  "main",
  "complementary",
  "contentinfo",
  "dialog",
  "alertdialog",
  "form",
  "region",
  "search",
  "menu",
  "tablist",
  "toolbar",
  "group",
  "radiogroup",
]);
const SCAN_BACK = 40;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const PUNCTUATION = /^[\s|·•\-–—()[\],.:;/]*$/;

function textOf(node: PageNode, skip: PageNode, out: string[] = []): string[] {
  if (node === skip) return out;
  if (
    node.name &&
    !PUNCTUATION.test(node.name) &&
    (node.kind === "text" || node.kind === "interactive" || node.role === "heading")
  )
    out.push(node.name);
  for (const child of node.children) textOf(child, skip, out);
  return out;
}

interface Flat {
  node: PageNode;
  ancestors: PageNode[];
}

function flatten(root: PageNode): Flat[] {
  const out: Flat[] = [];
  const visit = (node: PageNode, ancestors: PageNode[]) => {
    out.push({ node, ancestors });
    for (const child of node.children) visit(child, [...ancestors, node]);
  };
  visit(root, []);
  return out;
}

// Where an element sits, in words: what tells it apart from others like it.
function contextOf(flat: Flat[], index: number): string {
  const { node, ancestors } = flat[index] as Flat;
  const parts: string[] = [];
  const item = [...ancestors].reverse().find((ancestor) => ITEM_ROLES.has(ancestor.role));
  if (item) {
    const own = clip(textOf(item, node).join(" · "), 90);
    if (own) parts.push(`${item.role}: ${own}`);
    const row = [...ancestors].reverse().find((ancestor) => ancestor.role === "row");
    if (row) {
      const parent = ancestors[ancestors.indexOf(row) - 1];
      const siblings = parent?.children ?? [];
      const previous = siblings[siblings.indexOf(row) - 1];
      if (previous) {
        const before = clip(textOf(previous, node).join(" · "), 70);
        if (before) parts.push(`row above: ${before}`);
      }
    }
  } else {
    const nearby: string[] = [];
    for (let back = index - 1; back >= 0 && back >= index - SCAN_BACK; back--) {
      const entry = flat[back] as Flat;
      if (entry.node.role === "heading") {
        parts.push(
          `under heading "${clip(entry.node.name, 60)}"${nearby.length ? `: ${nearby.reverse().join(" · ")}` : ""}`,
        );
        break;
      }
      if (entry.node.kind === "text" && entry.node.name && nearby.length < 2)
        nearby.push(clip(entry.node.name, 50));
    }
  }
  const landmark = [...ancestors]
    .reverse()
    .find((ancestor) => LANDMARK_ROLES.has(ancestor.role) && ancestor !== item);
  if (landmark)
    parts.push(`in ${landmark.role}${landmark.name ? ` "${clip(landmark.name, 40)}"` : ""}`);
  return parts.join(" · ");
}

function hasRadio(node: PageNode): boolean {
  return node.children.some((child) => child.role === "radio" || hasRadio(child));
}

export function isRadioGroup(node: PageNode): boolean {
  return node.role === "radiogroup" || (node.role === "group" && hasRadio(node));
}

export function checkboxesIn(node: PageNode): PageNode[] {
  return node.children.flatMap((child) =>
    child.role === "checkbox" ? [child] : checkboxesIn(child),
  );
}

// A group of checkboxes answers one question with several choices ("toppings").
export function isCheckboxGroup(node: PageNode): boolean {
  return node.role === "group" && !hasRadio(node) && checkboxesIn(node).length >= 2;
}

function typeable(node: PageNode): boolean {
  if (node.editable === "secret" || node.editable === "otp") return false;
  if (node.states.readonly) return false;
  return node.editable !== undefined || TYPING_ROLES.has(node.role);
}

export function pageCandidates(
  model: PageModel,
  options_: { context?: boolean } = {},
): PageCandidates {
  const rendered = renderSnapshot(model, { scope: "full" });
  const root = model.modal ?? model.root;
  const flat = flatten(root);
  const position = new Map(flat.map((entry, index) => [entry.node, index]));
  const withContext = options_.context !== false;
  const lineOf = (node: PageNode) => {
    const own = describeNode(node, model.url).slice(0, 160);
    const context = withContext ? contextOf(flat, position.get(node) ?? 0) : "";
    return clip(context ? `${own} · ${context}` : own, MAX_LINE);
  };
  const fields: Candidate[] = [];
  const clicks: Candidate[] = [];
  const typing: Candidate[] = [];
  const options: SelectOption[] = [];
  const groupOf = new Map<string, PageNode>();
  const walk = (node: PageNode, inGroup: boolean) => {
    const group = isRadioGroup(node) && node.ref !== undefined;
    const boxes = node.ref !== undefined && isCheckboxGroup(node);
    if (boxes) for (const box of checkboxesIn(node)) if (box.ref) groupOf.set(box.ref, node);
    if (node.ref && rendered.refs.has(node.ref) && !node.states.disabled) {
      const candidate = { ref: node.ref, node, line: lineOf(node) };
      if (
        FIELD_ROLES.has(node.role) ||
        node.editable !== undefined ||
        group ||
        boxes ||
        (node.role === "radio" && !inGroup)
      )
        fields.push(candidate);
      if (CLICK_ROLES.has(node.role)) clicks.push(candidate);
      if (typeable(node)) typing.push(candidate);
      if (node.options && node.options.length > 0 && !typeable(node)) {
        const name = describeNode({ ...node, options: [] }, model.url).slice(0, 100);
        node.options.slice(0, MAX_OPTIONS_PER_SELECT).forEach((label, index) => {
          if (options.length < MAX_OPTIONS)
            options.push({
              id: `${node.ref}:${index + 1}`,
              ref: node.ref as string,
              label,
              line: `${name} → option ${JSON.stringify(label)}${label === node.value ? " (selected)" : ""}`,
            });
        });
      }
    }
    for (const child of node.children) walk(child, inGroup || group);
  };
  walk(root, false);
  const { scrollY, height, pageHeight } = model.viewport;
  const text = rendered.text
    .replace(/^<page_content untrusted="true">\n/, "")
    .replace(/\n<\/page_content>$/, "");
  return {
    fields,
    groupOf,
    clicks,
    typing,
    options,
    canScroll: { up: scrollY > 4, down: scrollY + height < pageHeight - 4 },
    text,
  };
}
