import type { PageModel, PageNode } from "../page/model.ts";
import { describeNode, renderSnapshot } from "../page/render.ts";

export interface Candidate {
  ref: string;
  node: PageNode;
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

export function pageCandidates(model: PageModel): PageCandidates {
  const rendered = renderSnapshot(model, { scope: "full" });
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
      const candidate = { ref: node.ref, node, line: describeNode(node, model.url).slice(0, 160) };
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
  walk(model.modal ?? model.root, false);
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
