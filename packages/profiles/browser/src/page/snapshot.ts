import type { FrameInfo } from "../browser/frames.ts";
import type { Tab } from "../browser/tabs.ts";
import { isCdpError } from "../cdp/connection.ts";
import type { Protocol } from "../cdp/types.ts";
import { CAPTURE_SCRIPT } from "./capture-script.ts";
import type { NodeKind, NodeStates, PageModel, PageNode } from "./model.ts";

interface RawNode {
  p: number;
  k: "i" | "t" | "c" | "f";
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  v: 0 | 1;
  role?: string;
  lvl?: number;
  t?: string;
  len?: number;
  e?: number;
  ed?: "text" | "rich" | "secret" | "otp";
  val?: string;
  href?: string;
  // Interactive only by heuristic: "c" clickable (onclick / cursor:pointer), "f" focusable (tabindex).
  cur?: "c" | "f";
  opts?: string[];
  optCount?: number;
  cx?: number;
  cy?: number;
  post?: 0 | 1;
  sub?: 1;
  fsub?: string;
  dlg?: string;
  // Current value of a password/one-time-code field: used for redaction only, never rendered.
  sv?: string;
}

interface RawInfo {
  url: string;
  title: string;
  vw: number;
  vh: number;
  sx: number;
  sy: number;
  pw: number;
  ph: number;
  modal: number;
  nodes: RawNode[];
}

interface FrameCapture {
  frame: FrameInfo;
  info: RawInfo;
  elements: string[];
}

export interface CaptureOptions {
  scope?: "viewport" | "full";
  signal?: AbortSignal | undefined;
  // Extra CSS px above and below the viewport that still count as visible.
  margin?: number;
  maxText?: number;
}

const OBJECT_GROUP = "mu-capture";
// Set by the capture script where an interactive child sits inside a text block.
const INLINE_MARK = String.fromCharCode(1);
const MASK = "••••";

const KINDS: Record<RawNode["k"], NodeKind> = {
  i: "interactive",
  t: "text",
  c: "container",
  f: "frame",
};

const AX_ROLE_ALIASES: Record<string, string> = {
  PopUpButton: "combobox",
  DisclosureTriangle: "button",
  LabelText: "label",
  Iframe: "iframe",
  IframePresentational: "iframe",
  RootWebArea: "document",
  StaticText: "text",
  textField: "textbox",
  image: "img",
  Date: "date",
  DateTime: "datetime",
  InputTime: "time",
  ColorWell: "color",
  Canvas: "canvas",
  Video: "video",
  Audio: "audio",
};

const WEAK_AX_ROLES = new Set(["generic", "none", "presentation", "", "text", "paragraph"]);

async function runCapture(
  frame: FrameInfo,
  worlds: (frameId: string) => Promise<number>,
  script: string,
  signal: AbortSignal | undefined,
): Promise<FrameCapture> {
  const options = { signal, timeoutMs: 5_000 };
  const contextId = await worlds(frame.frameId);
  const evaluated = await frame.session.send(
    "Runtime.evaluate",
    { expression: script, contextId, objectGroup: OBJECT_GROUP, returnByValue: false },
    options,
  );
  if (evaluated.exceptionDetails || !evaluated.result.objectId) {
    throw new Error(
      `capture failed in ${frame.url}: ${evaluated.exceptionDetails?.exception?.description ?? evaluated.exceptionDetails?.text ?? "no result"}`,
    );
  }
  const props = await frame.session.send(
    "Runtime.getProperties",
    { objectId: evaluated.result.objectId, ownProperties: true },
    options,
  );
  const infoText = props.result.find((prop) => prop.name === "info")?.value?.value as string;
  const elsId = props.result.find((prop) => prop.name === "els")?.value?.objectId;
  const elements: string[] = [];
  if (elsId) {
    const list = await frame.session.send(
      "Runtime.getProperties",
      { objectId: elsId, ownProperties: true },
      options,
    );
    for (const prop of list.result) {
      if (/^\d+$/.test(prop.name) && prop.value?.objectId) {
        elements[Number(prop.name)] = prop.value.objectId;
      }
    }
  }
  return { frame, info: JSON.parse(infoText) as RawInfo, elements };
}

function axStates(node: Protocol.Accessibility.AXNode | undefined): NodeStates {
  const states: NodeStates = {};
  for (const property of node?.properties ?? []) {
    const value = property.value.value as unknown;
    switch (property.name) {
      case "checked":
        if (value === "true" || value === "false" || value === "mixed") states.checked = value;
        else if (typeof value === "boolean") states.checked = value ? "true" : "false";
        break;
      case "pressed":
        if (value === true || value === "true" || value === "mixed") states.pressed = true;
        break;
      case "expanded":
        states.expanded = value === true || value === "true";
        break;
      case "selected":
        if (value === true || value === "true") states.selected = true;
        break;
      case "disabled":
        if (value === true || value === "true") states.disabled = true;
        break;
      case "required":
        if (value === true || value === "true") states.required = true;
        break;
      case "focused":
        if (value === true || value === "true") states.focused = true;
        break;
      case "readonly":
        if (value === true || value === "true") states.readonly = true;
        break;
      case "invalid":
        if (value && value !== "false") states.invalid = true;
        break;
      case "level":
        if (typeof value === "number") states.level = value;
        break;
    }
  }
  return states;
}

function roleFor(raw: RawNode, ax: Protocol.Accessibility.AXNode | undefined): string {
  const axRole = ax && !ax.ignored ? String(ax.role?.value ?? "") : "";
  const role = AX_ROLE_ALIASES[axRole] ?? axRole;
  if (raw.cur && (WEAK_AX_ROLES.has(role) || !role))
    return raw.cur === "f" ? "focusable" : "clickable";
  if (role && !WEAK_AX_ROLES.has(role)) return role;
  if (raw.role) return raw.role;
  if (raw.k === "i") {
    if (raw.ed === "rich") return "textbox";
    if (raw.tag === "a") return "link";
    if (raw.tag === "select") return "combobox";
    if (raw.tag === "input" || raw.tag === "textarea") return "textbox";
    return "button";
  }
  if (raw.k === "f") return "iframe";
  return role || "text";
}

function valueFor(raw: RawNode, ax: Protocol.Accessibility.AXNode | undefined): string | undefined {
  if (raw.ed === "secret" || raw.ed === "otp") {
    const present = ax?.value?.value !== undefined && String(ax.value.value) !== "";
    return present ? MASK : undefined;
  }
  if (raw.ed === "rich") return raw.val || undefined;
  const value = ax?.value?.value;
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function buildNode(
  raw: RawNode,
  frame: FrameInfo,
  ax: Protocol.Accessibility.AXNode | undefined,
  offset: { x: number; y: number },
  inViewport: boolean,
): PageNode {
  const role = roleFor(raw, ax);
  const axName = ax && !ax.ignored ? String(ax.name?.value ?? "").trim() : "";
  const text = raw.t ?? "";
  const plain = text.replaceAll(INLINE_MARK, " ").replace(/\s+/g, " ").trim();
  const name = raw.k === "t" ? plain : raw.k === "c" ? axName || plain : axName || text;
  const states = axStates(ax && !ax.ignored ? ax : undefined);
  if (raw.lvl) states.level = raw.lvl;
  const node: PageNode = {
    kind: KINDS[raw.k],
    role,
    name: name.replace(/\s+/g, " ").trim(),
    states,
    frameId: frame.frameId,
    box: { x: raw.x + offset.x, y: raw.y + offset.y, w: raw.w, h: raw.h },
    inViewport,
    children: [],
  };
  const value = valueFor(raw, ax);
  if (value !== undefined && value !== node.name) node.value = value;
  if (ax?.backendDOMNodeId) node.backendNodeId = ax.backendDOMNodeId;
  if (raw.href) node.url = raw.href;
  if (raw.ed) node.editable = raw.ed;
  if (raw.len !== undefined && raw.t !== undefined && raw.len > raw.t.length) {
    node.textLength = raw.len;
  }
  if (raw.opts) {
    node.options = raw.opts;
    if (raw.optCount !== undefined) node.optionCount = raw.optCount;
  }
  if (raw.cur) node.cursorOnly = true;
  if (raw.post !== undefined) {
    node.form = {
      post: raw.post === 1,
      ...(raw.sub ? { submit: true } : {}),
      ...(raw.fsub ? { submitLabel: raw.fsub } : {}),
    };
  }
  if (raw.dlg) node.dialogTitle = raw.dlg;
  if (raw.k === "t" && text.includes(INLINE_MARK)) {
    node.segments = text.split(INLINE_MARK).map((part) => part.replace(/\s+/g, " "));
  }
  return node;
}

// A link that leads to another page, as opposed to a script or in-page anchor.
function isPageLink(url: string, pageUrl: string): boolean {
  if (!/^https?:/.test(url)) return false;
  const [target = "", hash] = url.split("#");
  return hash === undefined || target !== pageUrl.split("#")[0];
}

export async function capturePage(tab: Tab, options: CaptureOptions = {}): Promise<PageModel> {
  const scope = options.scope ?? "viewport";
  const { signal } = options;
  const script = `(${CAPTURE_SCRIPT})(${JSON.stringify({
    margin: options.margin ?? 200,
    maxText: options.maxText ?? 300,
  })})`;
  const frames = tab.frames.list().filter((frame) => !frame.session.detached);
  const mainFrameId = tab.frames.mainFrameId;
  if (!mainFrameId) throw new Error("page has no main frame yet");
  const worlds = (frameId: string) => tab.frames.isolatedWorld(frameId, signal);
  const frameErrors: string[] = [];
  const captures = new Map<string, FrameCapture>();
  await Promise.all(
    frames.map(async (frame) => {
      try {
        captures.set(frame.frameId, await runCapture(frame, worlds, script, signal));
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isCdpError(error, "context-gone")) {
          tab.frames.forgetWorlds(frame.frameId);
          try {
            captures.set(frame.frameId, await runCapture(frame, worlds, script, signal));
            return;
          } catch {}
        }
        if (frame.frameId === mainFrameId) throw error;
        frameErrors.push(
          `${frame.url || frame.frameId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }),
  );
  const main = captures.get(mainFrameId);
  if (!main) throw new Error("could not capture the main frame");

  // Owner <iframe> of every captured child frame, resolved in its parent frame.
  const ownerOf = new Map<string, number>();
  const frameNodeBackend = new Map<string, Map<number, number>>();
  await Promise.all(
    [...captures.values()].map(async (capture) => {
      const frame = capture.frame;
      const backendIds = new Map<number, number>();
      frameNodeBackend.set(frame.frameId, backendIds);
      await Promise.all(
        capture.info.nodes.map(async (raw, index) => {
          if (raw.k !== "f" || raw.e === undefined) return;
          const objectId = capture.elements[raw.e];
          if (!objectId) return;
          const described = await frame.session
            .send("DOM.describeNode", { objectId }, { signal, timeoutMs: 3_000 })
            .catch(() => undefined);
          if (described) backendIds.set(index, described.node.backendNodeId);
        }),
      );
      if (frame.frameId === mainFrameId || !frame.parentId) return;
      const parent = tab.frames.get(frame.parentId);
      if (!parent) return;
      const owner = await parent.session
        .send("DOM.getFrameOwner", { frameId: frame.frameId }, { signal, timeoutMs: 3_000 })
        .catch(() => undefined);
      if (owner) ownerOf.set(frame.frameId, owner.backendNodeId);
    }),
  );

  // Frame offsets and visibility, resolved top-down.
  interface Placement {
    x: number;
    y: number;
    visible: boolean;
    owner?: number;
  }
  const placement = new Map<string, Placement>();
  placement.set(mainFrameId, { x: 0, y: 0, visible: true });
  const place = (frameId: string, depth = 0): Placement | undefined => {
    const known = placement.get(frameId);
    if (known) return known;
    if (depth > 8) return undefined;
    const frame = tab.frames.get(frameId);
    const ownerBackend = ownerOf.get(frameId);
    if (!frame?.parentId || ownerBackend === undefined) return undefined;
    const parentPlacement = place(frame.parentId, depth + 1);
    const parentCapture = captures.get(frame.parentId);
    const ids = frameNodeBackend.get(frame.parentId);
    if (!parentPlacement || !parentCapture || !ids) return undefined;
    for (const [index, backendNodeId] of ids) {
      if (backendNodeId !== ownerBackend) continue;
      const raw = parentCapture.info.nodes[index] as RawNode;
      const result = {
        x: parentPlacement.x + (raw.cx ?? raw.x),
        y: parentPlacement.y + (raw.cy ?? raw.y),
        visible: parentPlacement.visible && raw.v === 1,
        owner: index,
      };
      placement.set(frameId, result);
      return result;
    }
    return undefined;
  };
  for (const frameId of captures.keys()) place(frameId);

  const modalIndex = main.info.modal;
  const inModal = (capture: FrameCapture, index: number): boolean => {
    if (capture !== main || modalIndex < 0) return false;
    for (let cursor = index; cursor >= 0; cursor = (capture.info.nodes[cursor] as RawNode).p) {
      if (cursor === modalIndex) return true;
    }
    return false;
  };

  // Accessibility data for the nodes that will render.
  const axByFrame = new Map<string, Map<number, Protocol.Accessibility.AXNode>>();
  await Promise.all(
    [...captures.values()].map(async (capture) => {
      const frame = capture.frame;
      const framePlacement = placement.get(frame.frameId);
      const axMap = new Map<number, Protocol.Accessibility.AXNode>();
      axByFrame.set(frame.frameId, axMap);
      await Promise.all(
        capture.info.nodes.map(async (raw, index) => {
          if (raw.e === undefined) return;
          const renders =
            scope === "full" ||
            raw.k === "f" ||
            inModal(capture, index) ||
            (raw.v === 1 && framePlacement?.visible === true);
          if (!renders) return;
          const objectId = capture.elements[raw.e];
          if (!objectId) return;
          const result = await frame.session
            .send(
              "Accessibility.getPartialAXTree",
              { objectId, fetchRelatives: false },
              { signal, timeoutMs: 3_000 },
            )
            .catch(() => undefined);
          const ax = result?.nodes.find((node) => node.backendDOMNodeId !== undefined);
          if (ax) axMap.set(index, ax);
        }),
      );
      void frame.session
        .send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }, { timeoutMs: 2_000 })
        .catch(() => {});
    }),
  );

  // Assemble one tree, with child frames nested under their owner <iframe>.
  const root: PageNode = {
    kind: "container",
    role: "document",
    name: main.info.title,
    states: {},
    frameId: mainFrameId,
    inViewport: true,
    children: [],
  };
  const built = new Map<string, PageNode[]>();
  let modal: PageNode | undefined;
  let above = 0;
  let below = 0;
  for (const capture of captures.values()) {
    const framePlacement = placement.get(capture.frame.frameId);
    if (!framePlacement) continue;
    const axMap = axByFrame.get(capture.frame.frameId) ?? new Map();
    const nodes: PageNode[] = [];
    capture.info.nodes.forEach((raw, index) => {
      const inViewport = framePlacement.visible && raw.v === 1;
      nodes[index] = buildNode(
        raw,
        capture.frame,
        axMap.get(index),
        framePlacement,
        inViewport || inModal(capture, index),
      );
    });
    built.set(capture.frame.frameId, nodes);
    if (capture === main && modalIndex >= 0) modal = nodes[modalIndex];
  }
  const keep = (node: PageNode | undefined) =>
    node !== undefined && (scope === "full" || node.inViewport);
  for (const capture of captures.values()) {
    const nodes = built.get(capture.frame.frameId);
    const framePlacement = placement.get(capture.frame.frameId);
    if (!nodes || !framePlacement) continue;
    let container: PageNode[];
    if (capture === main) container = root.children;
    else {
      const parentFrame = capture.frame.parentId;
      const owner = parentFrame ? built.get(parentFrame)?.[framePlacement.owner ?? -1] : undefined;
      if (!owner) continue;
      container = owner.children;
    }
    capture.info.nodes.forEach((raw, index) => {
      const node = nodes[index] as PageNode;
      if (!keep(node)) {
        if (raw.k === "i" && capture === main) {
          if (raw.y + raw.h <= 0) above++;
          else below++;
        }
        return;
      }
      let parentIndex = raw.p;
      while (parentIndex >= 0 && !keep(nodes[parentIndex])) {
        parentIndex = (capture.info.nodes[parentIndex] as RawNode).p;
      }
      (parentIndex >= 0 ? (nodes[parentIndex] as PageNode).children : container).push(node);
    });
  }

  const secrets: string[] = [];
  for (const capture of captures.values()) {
    for (const raw of capture.info.nodes) if (raw.sv) secrets.push(raw.sv);
  }
  const mainFrame = tab.frames.get(mainFrameId);
  const documentId = `${mainFrameId}:${mainFrame?.loaderId ?? ""}`;
  const newDocument = tab.refs.beginDocument(documentId, mainFrameId);
  const assign = (node: PageNode) => {
    if (
      node.backendNodeId !== undefined &&
      (node.kind === "interactive" || (node.kind === "container" && node.name !== ""))
    ) {
      node.ref = tab.refs.refFor(node.frameId, node.backendNodeId);
      const name = node.name.length > 60 ? `${node.name.slice(0, 59)}…` : node.name;
      tab.refs.setLabel(node.ref, name ? `${node.role} ${JSON.stringify(name)}` : node.role);
      if (node.url) tab.links.add(node.url);
      tab.refs.setMeta(node.ref, {
        role: node.role,
        name: node.name,
        ...(node.editable ? { editable: node.editable } : {}),
        ...(node.form ? { form: node.form } : {}),
        ...(node.dialogTitle ? { dialogTitle: node.dialogTitle } : {}),
        ...(node.url && isPageLink(node.url, tab.url) ? { link: true } : {}),
      });
    }
    for (const child of node.children) assign(child);
  };
  assign(root);
  if (modal && !modal.ref && modal.backendNodeId !== undefined) {
    modal.ref = tab.refs.refFor(modal.frameId, modal.backendNodeId);
  }
  return {
    documentId,
    url: main.info.url,
    title: main.info.title,
    viewport: {
      width: main.info.vw,
      height: main.info.vh,
      scrollX: main.info.sx,
      scrollY: main.info.sy,
      pageHeight: main.info.ph,
    },
    root,
    ...(modal ? { modal } : {}),
    offscreen: { above, below },
    frames: captures.size,
    secrets,
    newDocument,
    frameErrors,
  };
}
