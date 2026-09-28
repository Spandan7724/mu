import type { PageModel, PageNode } from "./model.ts";
import { describeNode, displayUrl } from "./render.ts";

export const READ_PAGE_CHARS = 12_000;

const SKIPPED_OUTSIDE_MAIN = new Set(["navigation", "banner", "contentinfo", "complementary"]);

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
    parts.push(
      ...interactive.slice(segments.length - 1).map((child) => inline(child, pageUrl)),
    );
    parts.push(...rest.map((child) => inline(child, pageUrl)));
    return parts.filter(Boolean).join(" ");
  }
  const own = node.name;
  const children = node.children.map((child) => inline(child, pageUrl)).filter(Boolean);
  return [own, ...children].filter(Boolean).join(" ");
}

function toMarkdown(node: PageNode, pageUrl: string, out: string[], listDepth: number): void {
  const children = () => {
    for (const child of node.children) toMarkdown(child, pageUrl, out, listDepth);
  };
  switch (node.role) {
    case "heading":
      out.push(`${"#".repeat(Math.min(6, node.states.level ?? 2))} ${inline(node, pageUrl)}`);
      return;
    case "listitem":
      out.push(`${"  ".repeat(Math.max(0, listDepth - 1))}- ${inline(node, pageUrl)}`);
      return;
    case "list":
      for (const child of node.children) toMarkdown(child, pageUrl, out, listDepth + 1);
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

function findMain(node: PageNode): PageNode | undefined {
  if (node.role === "main") return node;
  for (const child of node.children) {
    const found = findMain(child);
    if (found) return found;
  }
  return undefined;
}

export function pageMarkdown(model: PageModel): { markdown: string; scope: string } {
  const main = findMain(model.root);
  const out: string[] = [];
  if (main) {
    toMarkdown(main, model.url, out, 0);
    return { markdown: out.join("\n"), scope: "main content" };
  }
  for (const child of model.root.children) {
    if (!SKIPPED_OUTSIDE_MAIN.has(child.role)) toMarkdown(child, model.url, out, 0);
  }
  return { markdown: out.join("\n"), scope: "page (navigation, header and footer omitted)" };
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
