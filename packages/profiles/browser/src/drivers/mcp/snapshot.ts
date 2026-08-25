// Parses Playwright's accessibility snapshot into the flat, semantic element list
// CONTRACTS.md describes. Only roles, names, states and the sidecar's own refs are
// read: no CSS selector, DOM id or coordinate crosses this boundary (BD9/BD10).
//
// One snapshot line looks like:
//   - textbox "Plain text" [ref=e6]: Ada Lovelace
//   - combobox "Size" [ref=e22]:
//       - option "Medium" [selected]
//   - checkbox "Send me updates" [checked] [active] [ref=e37]

export interface SnapshotOption {
  label: string;
  selected: boolean;
}

export interface SnapshotNode {
  role: string;
  name?: string | undefined;
  ref?: string | undefined;
  // Frame refs are prefixed by the sidecar (`f1e2`); the prefix is the frame.
  framePrefix?: string | undefined;
  value?: string | undefined;
  attributes: Record<string, string | true>;
  options: SnapshotOption[];
  depth: number;
  parent?: SnapshotNode | undefined;
  box?: { x: number; y: number; width: number; height: number } | undefined;
}

const LINE = /^(\s*)-\s?(.*)$/;
const ROLE = /^([A-Za-z][A-Za-z0-9_-]*)/;
const NAME = /^\s*"((?:[^"\\]|\\.)*)"/;
const ATTRIBUTE = /^\s*\[([A-Za-z][A-Za-z0-9_-]*)(?:=([^\]]*))?\]/;
const FRAME_REF = /^(f\d+)e\d+$/;
const BOX = /^(-?\d+),(-?\d+),(\d+),(\d+)$/;

function unquoteEscapes(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unquoteEscapes(trimmed.slice(1, -1));
  }
  return trimmed;
}

interface ParsedLine {
  depth: number;
  node: SnapshotNode;
}

function parseLine(raw: string): ParsedLine | undefined {
  const line = LINE.exec(raw.replace(/\t/g, "  "));
  if (!line) return undefined;
  const depth = (line[1] ?? "").length;
  // A node whose text contains ": " is emitted as a single-quoted YAML scalar.
  let rest = (line[2] ?? "").replace(/^'(.*)'$/s, (_match, body: string) =>
    body.replace(/''/g, "'"),
  );
  const role = ROLE.exec(rest);
  if (!role?.[1]) return undefined;
  rest = rest.slice(role[1].length);

  let name: string | undefined;
  const named = NAME.exec(rest);
  if (named?.[1] !== undefined) {
    name = unquoteEscapes(named[1]);
    rest = rest.slice(named[0].length);
  }

  const attributes: Record<string, string | true> = {};
  for (;;) {
    const attribute = ATTRIBUTE.exec(rest);
    if (!attribute?.[1]) break;
    attributes[attribute[1]] = attribute[2] === undefined ? true : attribute[2];
    rest = rest.slice(attribute[0].length);
  }

  let value: string | undefined;
  const trailing = rest.trimStart();
  if (trailing.startsWith(":")) {
    const body = trailing.slice(1).trim();
    // `|` and `|-` introduce a block scalar whose lines are the node's children.
    if (body.length > 0 && body !== "|" && body !== "|-") value = stripQuotes(body);
  }

  const ref = typeof attributes.ref === "string" ? attributes.ref : undefined;
  const frame = ref === undefined ? undefined : FRAME_REF.exec(ref)?.[1];
  const rawBox = typeof attributes.box === "string" ? BOX.exec(attributes.box) : undefined;
  const box =
    rawBox === undefined || rawBox === null
      ? undefined
      : {
          x: Number(rawBox[1]),
          y: Number(rawBox[2]),
          width: Number(rawBox[3]),
          height: Number(rawBox[4]),
        };
  return {
    depth,
    node: {
      role: role[1],
      ...(name === undefined ? {} : { name }),
      ...(ref === undefined ? {} : { ref }),
      ...(frame === undefined || frame === null ? {} : { framePrefix: frame }),
      ...(value === undefined ? {} : { value }),
      ...(box === undefined ? {} : { box }),
      attributes,
      options: [],
      depth,
    },
  };
}

export function parseSnapshot(yaml: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  const stack: SnapshotNode[] = [];
  for (const raw of yaml.split("\n")) {
    if (raw.trim().length === 0) continue;
    const parsed = parseLine(raw);
    if (!parsed) continue;
    while (stack.length > 0 && (stack[stack.length - 1] as SnapshotNode).depth >= parsed.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parsed.node.parent = parent;
    // Options belong to the control above them, not to the flat element list.
    if (parsed.node.role === "option" && parent !== undefined) {
      parent.options.push({
        label: parsed.node.name ?? parsed.node.value ?? "",
        selected: parsed.node.attributes.selected !== undefined,
      });
      if (parsed.node.ref === undefined) {
        stack.push(parsed.node);
        continue;
      }
    }
    nodes.push(parsed.node);
    stack.push(parsed.node);
  }
  return nodes;
}

// The signature a page revision is keyed on. Values are excluded deliberately:
// typing into a field must not invalidate the reference that was just used, while
// a control appearing, moving or being relabelled must (BD9).
export function structuralSignature(nodes: readonly SnapshotNode[]): string {
  return nodes
    .filter((node) => node.ref !== undefined)
    .map((node) => `${node.ref}|${node.role}|${node.name ?? ""}`)
    .join("\n");
}

export function textSnapshot(nodes: readonly SnapshotNode[]): string {
  return nodes
    .map((node) => {
      const indent = " ".repeat(node.depth);
      const name = node.name === undefined ? "" : ` "${node.name}"`;
      const value = node.value === undefined ? "" : `: ${node.value}`;
      return `${indent}- ${node.role}${name}${value}`;
    })
    .join("\n");
}

const CONTEXT_ROLES = new Set(["article", "listitem", "row", "cell", "group"]);

/** Static text grouped with a control by the accessibility tree, not DOM proximity. */
export function contextualText(
  node: SnapshotNode,
  nodes: readonly SnapshotNode[],
): string | undefined {
  let root: SnapshotNode | undefined = CONTEXT_ROLES.has(node.role) ? node : undefined;
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (CONTEXT_ROLES.has(parent.role)) {
      root = parent;
      break;
    }
  }

  if (root === undefined) return undefined;

  const start = nodes.indexOf(root);
  if (start < 0) return undefined;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (let index = start; index < nodes.length; index += 1) {
    const entry = nodes[index] as SnapshotNode;
    if (index > start && entry.depth <= root.depth) break;
    for (const value of [entry.name, entry.ref === undefined ? entry.value : undefined]) {
      const text = value?.replace(/\s+/g, " ").trim();
      if (text === undefined || text.length === 0 || text === node.name || seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
    }
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}
