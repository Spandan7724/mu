// Model-facing renderings of an MCP server's tools. Measured in docs/mcp-exposure:
// bare one-line signatures matched full JSON schemas in accuracy at a fraction of the
// tokens, and a name index for large servers kept accuracy while cutting open cost ~10×.

export interface CatalogTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [key: string]: unknown };
}

export interface ServerCatalog {
  serverInfo?: { name?: string; title?: string; version?: string };
  instructions?: string;
  tools: CatalogTool[];
  resources: boolean;
  fetchedAt: number;
}

// biome-ignore lint/suspicious/noExplicitAny: JSON Schema is open-ended
type Schema = Record<string, any>;

// Servers whose signatures exceed this open as a name index; signatures come from mcp_describe.
export const LARGE_SERVER_TOKENS = 1000;
const INDEX_INSTRUCTION_CHARS = 1200;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function firstSentence(text: string | undefined, max: number): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

function typeExpr(schema: Schema | undefined, depth: number): string {
  if (!schema || typeof schema !== "object") return "any";
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return schema.enum.map((v: unknown) => JSON.stringify(v)).join("|");
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union))
    return [...new Set(union.map((s: Schema) => typeExpr(s, depth)))].join("|");
  if (Array.isArray(schema.type)) {
    return schema.type.map((t: string) => typeExpr({ ...schema, type: t }, depth)).join("|");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = typeExpr(schema.items, depth);
      return item.includes("|") ? `(${item})[]` : `${item}[]`;
    }
    case "object":
    case undefined: {
      const props = schema.properties as Record<string, Schema> | undefined;
      if (!props || Object.keys(props).length === 0 || depth >= 2) return "object";
      const required = new Set<string>(schema.required ?? []);
      return `{${Object.entries(props)
        .map(
          ([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${typeExpr(value, depth + 1)}`,
        )
        .join(", ")}}`;
    }
    default:
      return "any";
  }
}

export function signature(tool: CatalogTool): string {
  const schema = tool.inputSchema as Schema;
  const props = (schema?.properties ?? {}) as Record<string, Schema>;
  const required = new Set<string>(schema?.required ?? []);
  const entries = Object.entries(props);
  const ordered = [
    ...entries.filter(([k]) => required.has(k)),
    ...entries.filter(([k]) => !required.has(k)),
  ];
  const args = ordered.map(
    ([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${typeExpr(value, 1)}`,
  );
  const description = firstSentence(tool.description, 160);
  return `${tool.name}(${args.join(", ")})${description ? ` — ${description}` : ""}`;
}

export function isLargeServer(catalog: ServerCatalog): boolean {
  return estimateTokens(catalog.tools.map(signature).join("\n")) > LARGE_SERVER_TOKENS;
}

const RESOURCE_NOTE =
  'This server also has resources: mcp_call with tool "resources/list" (no arguments) or "resources/read" ({"uri": …}).';

export function openText(server: string, catalog: ServerCatalog): string {
  const large = isLargeServer(catalog);
  const raw = catalog.instructions?.trim() ?? "";
  const instructions =
    large && raw.length > INDEX_INSTRUCTION_CHARS
      ? `${raw.slice(0, INDEX_INSTRUCTION_CHARS)}…`
      : raw;
  const lines = [
    large
      ? `Server ${server} (${catalog.tools.length} tool${catalog.tools.length === 1 ? "" : "s"}). Get the signatures of the tools you need with mcp_describe, then call them with mcp_call.`
      : `Server ${server} (${catalog.tools.length} tool${catalog.tools.length === 1 ? "" : "s"}). Call these with mcp_call.`,
  ];
  if (instructions) lines.push(`Instructions:\n${instructions}`);
  if (catalog.tools.length === 0) lines.push("This server has no tools.");
  else if (large) lines.push(`Tools: ${catalog.tools.map((tool) => tool.name).join(", ")}`);
  else lines.push(catalog.tools.map(signature).join("\n"));
  if (catalog.resources) lines.push(RESOURCE_NOTE);
  return lines.join("\n\n");
}

export function describeText(server: string, catalog: ServerCatalog, names: string[]): string {
  if (names.length === 0) return "No tools requested.";
  return names
    .map((name) => {
      const tool = catalog.tools.find((candidate) => candidate.name === name);
      return tool ? signature(tool) : `${name}: no such tool on ${server}`;
    })
    .join("\n");
}

function typeOk(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

// Structural checks only (required, type, enum, nested), so a call the server would
// reject for shape comes back with the schema instead of a round trip.
export function validateArgs(
  value: unknown,
  schema: Schema | undefined,
  path = "arguments",
): string[] {
  if (!schema || typeof schema !== "object") return [];
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    return union.some((s: Schema) => validateArgs(value, s, path).length === 0)
      ? []
      : [`${path} matches none of the allowed shapes`];
  }
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) return [`${path} must be ${types.join(" or ")}`];
  }
  const errors: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.some((v: unknown) => v === value)) {
    errors.push(
      `${path} must be one of ${schema.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}`,
    );
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) errors.push(`${path}.${key} is required`);
    }
    for (const [key, sub] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) {
      if (record[key] !== undefined)
        errors.push(...validateArgs(record[key], sub, `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items && !Array.isArray(schema.items)) {
    value.forEach((item, i) => {
      errors.push(...validateArgs(item, schema.items, `${path}[${i}]`));
    });
  }
  return errors;
}

// One line per server for the always-present listing.
export function listingLine(
  server: string,
  options: { description?: string; catalog?: ServerCatalog; note?: string },
): string {
  const instructions = options.catalog?.instructions
    ?.split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join(" ");
  const about = firstSentence(options.description ?? instructions, 140);
  const parts = [`- ${server}:`];
  if (about) parts.push(about);
  if (options.catalog) {
    const names = options.catalog.tools.map((tool) => tool.name);
    parts.push(
      names.length === 0
        ? "(no tools)"
        : `Tools: ${names.slice(0, 8).join(", ")}${names.length > 8 ? `, … ${names.length} tools` : ""}`,
    );
  } else {
    parts.push("(not connected yet; mcp_open connects it)");
  }
  if (options.note) parts.push(`(${options.note})`);
  return parts.join(" ");
}
