import type { PageModel, PageNode } from "./model.ts";

export const DEFAULT_BUDGET_TOKENS = 6_000;
export const HARD_CAP_TOKENS = 12_000;
const MAX_LINE_TEXT = 200;
const MAX_VALUE = 300;

export interface RenderOptions {
  scope?: "viewport" | "full" | undefined;
  budgetTokens?: number | undefined;
  // Refs and text keys shown by the previous observation of this document.
  previous?: { refs: Set<string>; texts: Set<string> } | undefined;
}

export interface RenderedSnapshot {
  text: string;
  refs: Set<string>;
  texts: Set<string>;
  pruned: number;
  lines: number;
}

interface Line {
  text: string;
  depth: number;
  kind: PageNode["kind"];
  inViewport: boolean;
}

const KEEP_SINGLE_CHILD = new Set([
  "list",
  "table",
  "row",
  "dialog",
  "alertdialog",
  "form",
  "iframe",
]);

function quote(text: string): string {
  return JSON.stringify(text);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function displayUrl(url: string, pageUrl: string): string {
  try {
    const target = new URL(url);
    const page = new URL(pageUrl);
    if (target.protocol === "javascript:") return "(script)";
    const shown =
      target.origin === page.origin
        ? `${target.pathname}${target.search}${target.hash}`
        : `${target.host}${target.pathname === "/" ? "" : target.pathname}${target.search}`;
    return clip(shown, 80);
  } catch {
    return clip(url, 80);
  }
}

function stateTags(node: PageNode): string[] {
  const tags: string[] = [];
  const s = node.states;
  if (s.level !== undefined && node.role === "heading") tags.push(`[level=${s.level}]`);
  if (s.checked === "true") tags.push("[checked]");
  else if (s.checked === "mixed") tags.push("[checked=mixed]");
  if (s.pressed) tags.push("[pressed]");
  if (s.selected) tags.push("[selected]");
  if (s.expanded !== undefined) tags.push(`[expanded=${s.expanded}]`);
  if (s.disabled) tags.push("[disabled]");
  if (s.readonly) tags.push("[readonly]");
  if (s.required) tags.push("[required]");
  if (s.invalid) tags.push("[invalid]");
  if (s.focused) tags.push("[focused]");
  return tags;
}

// Everything shown so far in this document; `*` marks what was never shown before.
export function mergeSeen(
  previous: { refs: Set<string>; texts: Set<string> } | undefined,
  rendered: { refs: Set<string>; texts: Set<string> },
): { refs: Set<string>; texts: Set<string> } {
  if (!previous) return { refs: new Set(rendered.refs), texts: new Set(rendered.texts) };
  return {
    refs: new Set([...previous.refs, ...rendered.refs]),
    texts: new Set([...previous.texts, ...rendered.texts]),
  };
}

export function textKey(node: PageNode): string {
  return `${node.role}:${node.name}`;
}

export function describeNode(node: PageNode, pageUrl: string): string {
  if (node.kind === "text" && node.role !== "heading" && node.role !== "img") {
    const more =
      node.textLength !== undefined
        ? ` …(${node.textLength} chars; read_page for the rest)`
        : node.name.length > MAX_LINE_TEXT
          ? ` …(${node.name.length} chars; read_page for the rest)`
          : "";
    return node.name ? `${node.role}: ${clip(node.name, MAX_LINE_TEXT)}${more}` : node.role;
  }
  const parts = [node.role];
  if (node.name) parts.push(quote(clip(node.name, MAX_LINE_TEXT)));
  if (node.ref) parts.push(`[ref=${node.ref}]`);
  parts.push(...stateTags(node));
  if (node.editable === "rich") parts.push("(rich)");
  else if (node.editable === "secret") parts.push("(password)");
  else if (node.editable === "otp") parts.push("(one-time code)");
  let line = parts.join(" ");
  if (node.value !== undefined) line += `: ${clip(node.value.replace(/\n/g, "⏎"), MAX_VALUE)}`;
  if (node.url) line += ` → ${displayUrl(node.url, pageUrl)}`;
  if (node.options && node.options.length > 0) {
    const extra =
      node.optionCount && node.optionCount > node.options.length
        ? `, … (+${node.optionCount - node.options.length} more)`
        : "";
    line += ` options: ${node.options.map((option) => quote(option)).join(", ")}${extra}`;
  }
  return line;
}

// A label, legend or text wrapper that only repeats a neighbouring name adds nothing.
function redundantText(node: PageNode, siblings: PageNode[], parentName: string): boolean {
  if (node.kind !== "text" || !node.name) return false;
  const text = node.name.replace(/[:*]\s*$/, "").trim();
  if (!text) return false;
  if (node.children.length === 0 && text === parentName) return true;
  const matches = (candidate: PageNode): boolean =>
    candidate.kind === "interactive" && candidate.name.startsWith(text);
  if (node.children.some((child) => matches(child) || child.children.some(matches))) return true;
  return node.role === "label" && siblings.some(matches);
}

function collectLines(
  nodes: PageNode[],
  depth: number,
  pageUrl: string,
  out: Line[],
  marks: { previous?: RenderOptions["previous"]; refs: Set<string>; texts: Set<string> },
  parentName = "",
): void {
  for (const node of nodes) {
    const drop =
      (node.kind === "container" && !node.name && node.children.length === 0) ||
      (node.kind === "text" && !node.name && node.children.length === 0) ||
      (node.kind === "frame" && node.children.length === 0);
    if (drop) continue;
    const collapse =
      (node.kind === "container" &&
        !node.name &&
        node.children.length === 1 &&
        !KEEP_SINGLE_CHILD.has(node.role)) ||
      redundantText(node, nodes, parentName);
    if (collapse) {
      collectLines(node.children, depth, pageUrl, out, marks, parentName);
      continue;
    }
    let isNew = false;
    if (node.ref) {
      marks.refs.add(node.ref);
      isNew = marks.previous !== undefined && !marks.previous.refs.has(node.ref);
    } else if (node.kind === "text" && node.name) {
      const key = textKey(node);
      marks.texts.add(key);
      isNew = marks.previous !== undefined && !marks.previous.texts.has(key);
    }
    out.push({
      text: `${"  ".repeat(depth)}${isNew ? "*" : ""}- ${describeNode(node, pageUrl)}`,
      depth,
      kind: node.kind,
      inViewport: node.inViewport,
    });
    collectLines(node.children, depth + 1, pageUrl, out, marks, node.name);
  }
}

function tokens(lines: Line[]): number {
  return Math.ceil(lines.reduce((total, line) => total + line.text.length + 1, 0) / 4);
}

function countInteractive(node: PageNode): number {
  return (
    (node.kind === "interactive" ? 1 : 0) +
    node.children.reduce((total, child) => total + countInteractive(child), 0)
  );
}

export function renderSnapshot(model: PageModel, options: RenderOptions = {}): RenderedSnapshot {
  const budget = Math.min(options.budgetTokens ?? DEFAULT_BUDGET_TOKENS, HARD_CAP_TOKENS);
  const marks = { previous: options.previous, refs: new Set<string>(), texts: new Set<string>() };
  const lines: Line[] = [];
  const trailer: string[] = [];
  if (model.modal) {
    const background = countInteractive(model.root) - countInteractive(model.modal);
    lines.push({
      text: "(modal dialog open; the page behind it is inert)",
      depth: 0,
      kind: "text",
      inViewport: true,
    });
    collectLines([model.modal], 0, model.url, lines, marks);
    trailer.push(
      `(page behind the dialog: ${background} interactive elements, not usable until the dialog closes)`,
    );
  } else {
    collectLines(model.root.children, 0, model.url, lines, marks);
    const { above, below } = model.offscreen;
    if (above > 0)
      trailer.push(`… (${above} more interactive elements above; scroll up or use find)`);
    if (below > 0) trailer.push(`… (${below} more interactive elements below; scroll or use find)`);
  }
  if (lines.length === 0)
    lines.push({ text: "(no visible content)", depth: 0, kind: "text", inViewport: true });

  let pruned = 0;
  if (tokens(lines) > budget) {
    const textIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.kind === "text")
      .sort((a, b) => b.line.depth - a.line.depth);
    const removed = new Set<number>();
    let current = tokens(lines);
    for (const { line, index } of textIndexes) {
      if (current <= budget) break;
      removed.add(index);
      current -= Math.ceil((line.text.length + 1) / 4);
    }
    if (current > budget && options.scope === "full") {
      lines.forEach((line, index) => {
        if (current <= budget || removed.has(index) || line.inViewport) return;
        removed.add(index);
        current -= Math.ceil((line.text.length + 1) / 4);
      });
    }
    pruned = removed.size;
    const kept = lines.filter((_, index) => !removed.has(index));
    lines.length = 0;
    lines.push(...kept);
    if (tokens(lines) > budget) {
      let total = 0;
      let cut = 0;
      for (; cut < lines.length; cut++) {
        total += Math.ceil(((lines[cut] as Line).text.length + 1) / 4);
        if (total > budget) break;
      }
      pruned += lines.length - cut;
      lines.length = cut;
    }
    trailer.unshift(
      `… (${pruned} lines omitted to stay within the observation budget; use find, read_page, or snapshot with a ref)`,
    );
  }
  if (model.frameErrors.length > 0) {
    trailer.push(`(${model.frameErrors.length} frame(s) could not be read yet)`);
  }
  // Page text must not be able to close the untrusted fence early.
  const body = [...lines.map((line) => line.text), ...trailer]
    .join("\n")
    .replace(/<(\/?)page_content/gi, "‹$1page_content");
  return {
    text: `<page_content untrusted="true">\n${body}\n</page_content>`,
    refs: marks.refs,
    texts: marks.texts,
    pruned,
    lines: lines.length,
  };
}
