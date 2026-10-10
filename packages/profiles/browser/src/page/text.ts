import type { PageModel, PageNode } from "./model.ts";
import { describeNode, displayUrl } from "./render.ts";

export const READ_PAGE_CHARS = 12_000;

// Site chrome outside the main content: read as text only, its links and controls counted.
const PAGE_CHROME: Record<string, string> = {
  banner: "header",
  navigation: "navigation",
  contentinfo: "footer",
  complementary: "sidebar",
};
const CONTENT_ROLES = new Set(["main", "article"]);

interface Omitted {
  links: number;
  controls: number;
}

function linkText(node: PageNode, pageUrl: string): string {
  const label = node.name || node.url || "link";
  const target = node.url ? ` ${displayUrl(node.url, pageUrl)}` : "";
  return `[${label}](${node.ref ?? "no ref"}${target})`;
}

function inline(node: PageNode, pageUrl: string): string {
  if (node.kind === "interactive") {
    if (node.role === "link") return linkText(node, pageUrl);
    return `[${describeNode(node, pageUrl)}]`;
  }
  const segments = node.segments;
  if (segments) {
    const interactive = node.children.filter((child) => child.kind === "interactive");
    const rest = node.children.filter((child) => child.kind !== "interactive");
    const parts: string[] = [];
    segments.forEach((segment, index) => {
      if (segment.trim()) parts.push(segment.trim());
      const child = index < segments.length - 1 ? interactive[index] : undefined;
      if (child) parts.push(inline(child, pageUrl));
    });
    parts.push(...interactive.slice(segments.length - 1).map((child) => inline(child, pageUrl)));
    parts.push(...rest.map((child) => inline(child, pageUrl)));
    return parts.filter(Boolean).join(" ");
  }
  const own = node.name;
  const children = node.children.map((child) => inline(child, pageUrl)).filter(Boolean);
  return [own, ...children].filter(Boolean).join(" ");
}

interface MarkdownContext {
  // Set while compacting: chrome outside the content is reduced to its text.
  omitted?: Omitted;
  inContent: boolean;
}

function toMarkdown(
  node: PageNode,
  pageUrl: string,
  out: string[],
  listDepth: number,
  context: MarkdownContext,
): void {
  const chrome = PAGE_CHROME[node.role];
  if (chrome && !context.inContent) {
    const label = `${chrome}${node.name ? ` "${node.name}"` : ""}`;
    if (!context.omitted) {
      out.push(`[${label}]`);
    } else {
      const lines: string[] = [];
      const omitted: Omitted = { links: 0, controls: 0 };
      for (const child of node.children) chromeText(child, lines, omitted);
      context.omitted.links += omitted.links;
      context.omitted.controls += omitted.controls;
      const counts = [count(omitted.links, "link"), count(omitted.controls, "control")].filter(
        Boolean,
      );
      if (lines.length === 0 && counts.length === 0) return;
      out.push(`[${label}${counts.length ? `: ${counts.join(", ")} not listed` : ""}]`, ...lines);
      return;
    }
  }
  if (CONTENT_ROLES.has(node.role) && !context.inContent) context = { ...context, inContent: true };
  const children = () => {
    for (const child of node.children) toMarkdown(child, pageUrl, out, listDepth, context);
  };
  switch (node.role) {
    case "heading":
      out.push(`${"#".repeat(Math.min(6, node.states.level ?? 2))} ${inline(node, pageUrl)}`);
      return;
    case "listitem":
      out.push(`${"  ".repeat(Math.max(0, listDepth - 1))}- ${inline(node, pageUrl)}`);
      return;
    case "list":
      for (const child of node.children) toMarkdown(child, pageUrl, out, listDepth + 1, context);
      return;
    case "row": {
      const cells = node.children.map((child) => inline(child, pageUrl).replace(/\|/g, "\\|"));
      if (cells.length > 0) out.push(`| ${cells.join(" | ")} |`);
      return;
    }
    case "img":
      if (node.name) out.push(`![${node.name}]`);
      return;
  }
  if (node.kind === "interactive") {
    out.push(inline(node, pageUrl));
    return;
  }
  if (node.kind === "text") {
    const text = inline(node, pageUrl);
    if (text) out.push(text);
    return;
  }
  if (node.kind === "frame") {
    out.push(`[frame: ${node.name || "iframe"}]`);
    children();
    return;
  }
  if (node.name && (node.role === "dialog" || node.role === "region" || node.role === "form")) {
    out.push(`[${node.role}: ${node.name}]`);
  }
  children();
}

const count = (n: number, noun: string) => (n ? `${n} ${noun}${n === 1 ? "" : "s"}` : "");

function countControls(node: PageNode, omitted: Omitted): void {
  if (node.kind === "interactive") {
    if (node.role === "link") omitted.links++;
    else omitted.controls++;
    return;
  }
  for (const child of node.children) countControls(child, omitted);
}

// A block's words without its controls; links inside running text keep their label.
function plainText(node: PageNode, omitted: Omitted): string {
  if (node.kind === "interactive") {
    if (node.role === "link" && node.name) return node.name;
    countControls(node, omitted);
    return "";
  }
  const parts: string[] = [];
  const segments = node.segments;
  if (segments) {
    const interactive = node.children.filter((child) => child.kind === "interactive");
    const rest = node.children.filter((child) => child.kind !== "interactive");
    segments.forEach((segment, index) => {
      if (segment.trim()) parts.push(segment.trim());
      const child = index < segments.length - 1 ? interactive[index] : undefined;
      if (child) parts.push(plainText(child, omitted));
    });
    for (const child of interactive.slice(segments.length - 1)) countControls(child, omitted);
    for (const child of rest) parts.push(plainText(child, omitted));
  } else {
    if (node.name && node.kind !== "container") parts.push(node.name);
    for (const child of node.children) parts.push(plainText(child, omitted));
  }
  return parts.filter(Boolean).join(" ");
}

function hasWords(node: PageNode): boolean {
  if (node.kind === "interactive") return false;
  if (node.segments) {
    if (node.segments.some((segment) => segment.trim())) return true;
  } else if (node.name && node.kind !== "container") return true;
  return node.children.some(hasWords);
}

// Chrome is kept as its own words: lines that are only links or controls (menus,
// social buttons, language pickers) are counted instead of listed.
function chromeText(node: PageNode, out: string[], omitted: Omitted): void {
  if (node.kind === "interactive") {
    countControls(node, omitted);
    return;
  }
  if (node.role === "img") return;
  const line = node.kind === "text" || node.role === "listitem" || node.role === "row";
  if (!line) {
    for (const child of node.children) chromeText(child, out, omitted);
    return;
  }
  if (!hasWords(node)) {
    countControls(node, omitted);
    return;
  }
  const text = plainText(node, omitted);
  if (node.role === "heading")
    out.push(`${"#".repeat(Math.min(6, node.states.level ?? 2))} ${text}`);
  else if (node.role === "listitem") out.push(`- ${text}`);
  else out.push(text);
}

export interface PageText {
  // Chrome (site header, navigation, footer, sidebars) reduced to its text.
  markdown: string;
  // Everything, for searching: a query must never miss text that is on the page.
  full: string;
  scope: string;
}

export function pageMarkdown(model: PageModel): PageText {
  const omitted: Omitted = { links: 0, controls: 0 };
  const out: string[] = [];
  const full: string[] = [];
  toMarkdown(model.root, model.url, out, 0, { omitted, inContent: false });
  toMarkdown(model.root, model.url, full, 0, { inContent: false });
  const unlisted = [count(omitted.links, "link"), count(omitted.controls, "control")]
    .filter(Boolean)
    .join(" and ");
  const scope = unlisted
    ? `whole page; its header, navigation, footer and sidebars as text only (${unlisted} there not listed: find or snapshot shows them)`
    : "whole page";
  return { markdown: out.join("\n"), full: full.join("\n"), scope };
}

// Keeps the sections (split at headings) that mention any query term.
export function filterSections(markdown: string, query: string): string {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  if (terms.length === 0) return markdown;
  const sections: string[][] = [[]];
  for (const line of markdown.split("\n")) {
    if (/^#{1,6} /.test(line) && (sections.at(-1)?.length ?? 0) > 0) sections.push([]);
    sections.at(-1)?.push(line);
  }
  const matching = sections.filter((section) => {
    const text = section.join("\n").toLowerCase();
    return terms.some((term) => text.includes(term));
  });
  return matching.map((section) => section.join("\n")).join("\n\n");
}

export function paginate(
  text: string,
  offset: number,
  size = READ_PAGE_CHARS,
): { chunk: string; start: number; end: number; total: number } {
  const start = Math.max(0, Math.min(offset, text.length));
  let end = Math.min(text.length, start + size);
  if (end < text.length) {
    const newline = text.lastIndexOf("\n", end);
    if (newline > start + size / 2) end = newline;
  }
  return { chunk: text.slice(start, end), start, end, total: text.length };
}

export interface FindMatch {
  node: PageNode;
  context: string;
  position: "in view" | "above" | "below";
}

export function findNodes(
  model: PageModel,
  matcher: (text: string) => boolean,
  limit: number,
): { matches: FindMatch[]; total: number } {
  const matches: FindMatch[] = [];
  let total = 0;
  const visit = (node: PageNode, trail: string[]) => {
    const hit =
      (node.name !== "" && matcher(node.name)) ||
      (node.value !== undefined && node.value !== "" && matcher(node.value));
    if (node !== model.root && hit) {
      total++;
      if (matches.length < limit) {
        const y = node.box?.y ?? 0;
        matches.push({
          node,
          context: trail.slice(-2).join(" › "),
          position: node.inViewport ? "in view" : y < 0 ? "above" : "below",
        });
      }
    }
    const label =
      node.kind === "container" || node.role === "listitem" || node.role === "row"
        ? node.name
          ? `${node.role} "${node.name.slice(0, 40)}"`
          : node.role
        : undefined;
    for (const child of node.children) visit(child, label ? [...trail, label] : trail);
  };
  visit(model.root, []);
  return { matches, total };
}
