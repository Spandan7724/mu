import { type ColorDepth, type SyntaxRole, styleText } from "./style.ts";

interface HighlightJs {
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    options: { language: string; ignoreIllegals: boolean },
  ): { value: string };
}

// highlight.js' published declarations force the DOM lib into every consumer,
// conflicting with Bun's async-iterable stream types. Keep this narrow runtime
// boundary typed locally; Bun still bundles the literal CommonJS import.
const hljs = require("highlight.js/lib/common") as HighlightJs;

const SCOPE_ROLES: Record<string, SyntaxRole> = {
  keyword: "keyword",
  built_in: "type",
  literal: "number",
  number: "number",
  regexp: "string",
  string: "string",
  comment: "comment",
  doctag: "comment",
  function: "function",
  title: "function",
  class: "type",
  type: "type",
  name: "keyword",
  attr: "variable",
  attribute: "variable",
  property: "variable",
  variable: "variable",
  params: "variable",
};

function scopeRole(scope: string | undefined): SyntaxRole | undefined {
  if (!scope) return undefined;
  if (SCOPE_ROLES[scope]) return SCOPE_ROLES[scope];
  const separator = scope.search(/[.-]/);
  return separator < 0 ? undefined : SCOPE_ROLES[scope.slice(0, separator)];
}

function activeRole(scopes: Array<string | undefined>): SyntaxRole | undefined {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const role = scopeRole(scopes[index]);
    if (role) return role;
  }
  return undefined;
}

function spanScope(tag: string): string | undefined {
  const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  const classValue = match?.[1] ?? match?.[2];
  return classValue
    ?.split(/\s+/)
    .find((name) => name.startsWith("hljs-"))
    ?.slice("hljs-".length);
}

function decodeEntity(source: string, index: number): { text: string; length: number } | undefined {
  const end = source.indexOf(";", index + 1);
  if (end < 0 || end - index > 10) return undefined;
  const entity = source.slice(index + 1, end);
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  const namedValue = named[entity];
  if (namedValue) return { text: namedValue, length: end - index + 1 };

  const numeric =
    entity.startsWith("#x") || entity.startsWith("#X")
      ? Number.parseInt(entity.slice(2), 16)
      : entity.startsWith("#")
        ? Number.parseInt(entity.slice(1), 10)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 0x10ffff) return undefined;
  return { text: String.fromCodePoint(numeric), length: end - index + 1 };
}

function renderHighlightedHtml(html: string, depth: ColorDepth): string {
  let output = "";
  let text = "";
  const scopes: Array<string | undefined> = [];

  const flush = () => {
    if (!text) return;
    const role = activeRole(scopes);
    const style = role ? { syntax: role } : { code: true };
    const lines = text.split("\n");
    for (const [lineIndex, line] of lines.entries()) {
      output += styleText(line, style, depth);
      if (lineIndex < lines.length - 1) output += "\n";
    }
    text = "";
  };

  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<span", index) && /[\s>]/.test(html[index + 5] ?? "")) {
      const end = html.indexOf(">", index + 5);
      if (end >= 0) {
        flush();
        scopes.push(spanScope(html.slice(index, end + 1)));
        index = end + 1;
        continue;
      }
    }
    if (html.startsWith("</span>", index)) {
      flush();
      scopes.pop();
      index += "</span>".length;
      continue;
    }
    if (html[index] === "&") {
      const entity = decodeEntity(html, index);
      if (entity) {
        text += entity.text;
        index += entity.length;
        continue;
      }
    }
    text += html[index] ?? "";
    index++;
  }
  flush();
  return output;
}

function fallback(code: string, depth: ColorDepth): string[] {
  return code.split("\n").map((line) => styleText(line, { code: true }, depth));
}

export function highlightCode(
  code: string,
  language: string | undefined,
  depth: ColorDepth,
): string[] {
  const normalized = language?.trim().toLowerCase();
  if (!normalized || !hljs.getLanguage(normalized)) return fallback(code, depth);
  try {
    const html = hljs.highlight(code, {
      language: normalized,
      ignoreIllegals: true,
    }).value;
    return renderHighlightedHtml(html, depth).split("\n");
  } catch {
    return fallback(code, depth);
  }
}
