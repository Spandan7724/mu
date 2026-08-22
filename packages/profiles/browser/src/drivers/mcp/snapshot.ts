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
}

const LINE = /^(\s*)-\s?(.*)$/;
const ROLE = /^([A-Za-z][A-Za-z0-9_-]*)/;
const NAME = /^\s*"((?:[^"\\]|\\.)*)"/;
const ATTRIBUTE = /^\s*\[([A-Za-z][A-Za-z0-9_-]*)(?:=([^\]]*))?\]/;
const FRAME_REF = /^(f\d+)e\d+$/;

function unescape(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescape(trimmed.slice(1, -1));
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
  let rest = line[2] ?? "";
  const role = ROLE.exec(rest);
  if (!role?.[1]) return undefined;
  rest = rest.slice(role[1].length);

  let name: string | undefined;
  const named = NAME.exec(rest);
  if (named?.[1] !== undefined) {
    name = unescape(named[1]);
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
  return {
    depth,
    node: {
      role: role[1],
      ...(name === undefined ? {} : { name }),
      ...(ref === undefined ? {} : { ref }),
      ...(frame === undefined || frame === null ? {} : { framePrefix: frame }),
      ...(value === undefined ? {} : { value }),
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
