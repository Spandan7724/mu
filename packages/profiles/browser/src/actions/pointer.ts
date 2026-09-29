import type { Tab } from "../browser/tabs.ts";
import { isCdpError } from "../cdp/connection.ts";
import type { CdpSession } from "../cdp/session.ts";
import type { Protocol } from "../cdp/types.ts";
import type { ResolvedRef } from "../page/resolve.ts";

export type MouseButton = "left" | "right" | "middle";
export type Modifier = "Alt" | "Control" | "Meta" | "Shift";

export interface Point {
  x: number;
  y: number;
}

// Chrome delivers mouse moves on the next animation frame, so a window the
// compositor is not drawing (another workspace, minimized) never acks them.
// A following press or release flushes the queued move, so only pure hovers
// depend on the ack.
const MOVE_ACK_MS = 500;

async function dispatchMove(
  session: CdpSession,
  params: Omit<Protocol.Input.DispatchMouseEventRequest, "type">,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    await session.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", ...params },
      { signal, timeoutMs: MOVE_ACK_MS },
    );
    return true;
  } catch (error) {
    if (isCdpError(error, "timeout")) return false;
    throw error;
  }
}

export interface Occluder {
  ref?: string;
  role: string;
  name: string;
  inside: { ref?: string; role: string; name: string }[];
}

const MODIFIER_BITS: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

export function modifierMask(modifiers: Modifier[] = []): number {
  return modifiers.reduce((mask, modifier) => mask | MODIFIER_BITS[modifier], 0);
}

// Offset of a session's viewport inside the main viewport (non-zero only for OOPIFs).
export async function sessionOffset(
  tab: Tab,
  frameId: string,
  signal?: AbortSignal,
): Promise<Point> {
  let x = 0;
  let y = 0;
  let current = tab.frames.get(frameId);
  for (let depth = 0; current && current.session !== tab.session && depth < 8; depth++) {
    // Find the root frame of this session: its parent lives in another session.
    let root = current;
    for (;;) {
      const parent = root.parentId ? tab.frames.get(root.parentId) : undefined;
      if (!parent || parent.session !== root.session) break;
      root = parent;
    }
    const parent = root.parentId ? tab.frames.get(root.parentId) : undefined;
    if (!parent) break;
    const owner = await parent.session.send(
      "DOM.getFrameOwner",
      { frameId: root.frameId },
      { signal, timeoutMs: 3_000 },
    );
    const box = await parent.session.send(
      "DOM.getBoxModel",
      { backendNodeId: owner.backendNodeId },
      { signal, timeoutMs: 3_000 },
    );
    x += box.model.content[0] ?? 0;
    y += box.model.content[1] ?? 0;
    current = parent;
  }
  return { x, y };
}

interface Quad {
  points: number[];
  area: number;
}

function quadArea(points: number[]): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = [points[i * 2] ?? 0, points[i * 2 + 1] ?? 0];
    const next = (i + 1) % 4;
    const [x2, y2] = [points[next * 2] ?? 0, points[next * 2 + 1] ?? 0];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

// A visible point on the element in its session's viewport coordinates, or undefined.
export async function clickablePoint(
  target: ResolvedRef,
  viewport: { width: number; height: number },
  signal?: AbortSignal,
): Promise<Point | undefined> {
  await target.session
    .send(
      "DOM.scrollIntoViewIfNeeded",
      { backendNodeId: target.backendNodeId },
      { signal, timeoutMs: 3_000 },
    )
    .catch(() => {});
  const result = await target.session
    .send(
      "DOM.getContentQuads",
      { backendNodeId: target.backendNodeId },
      { signal, timeoutMs: 3_000 },
    )
    .catch(() => undefined);
  const quads: Quad[] = (result?.quads ?? [])
    .map((points) => ({ points, area: quadArea(points) }))
    .filter((quad) => quad.area > 1);
  if (quads.length === 0) return undefined;
  const clip = (points: number[]) => {
    const xs = [points[0], points[2], points[4], points[6]].map(Number);
    const ys = [points[1], points[3], points[5], points[7]].map(Number);
    const left = Math.max(0, Math.min(...xs));
    const right = Math.min(viewport.width, Math.max(...xs));
    const top = Math.max(0, Math.min(...ys));
    const bottom = Math.min(viewport.height, Math.max(...ys));
    return {
      left,
      right,
      top,
      bottom,
      area: Math.max(0, right - left) * Math.max(0, bottom - top),
    };
  };
  const best = quads.map((quad) => clip(quad.points)).sort((a, b) => b.area - a.area)[0];
  if (!best || best.area <= 0) return undefined;
  return { x: (best.left + best.right) / 2, y: (best.top + best.bottom) / 2 };
}

// Checks that the point hits the element (or its label), reporting what covers it otherwise.
export async function hitTest(
  target: ResolvedRef,
  point: Point,
  refOf: (frameId: string, backendNodeId: number) => string | undefined,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; occluder: Occluder }> {
  const refFor = (backendNodeId: number | undefined) =>
    backendNodeId === undefined ? undefined : refOf(target.frameId, backendNodeId);
  const location = await target.session
    .send(
      "DOM.getNodeForLocation",
      { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false },
      { signal, timeoutMs: 3_000 },
    )
    .catch(() => undefined);
  if (!location) return { ok: true };
  if (location.backendNodeId === target.backendNodeId) return { ok: true };
  const hit = await target.session
    .send(
      "DOM.resolveNode",
      { backendNodeId: location.backendNodeId, objectGroup: "mu-action" },
      { signal, timeoutMs: 3_000 },
    )
    .catch(() => undefined);
  if (!hit?.object.objectId) return { ok: true };
  const verdict = await target.session.send(
    "Runtime.callFunctionOn",
    {
      objectId: target.objectId,
      functionDeclaration: HIT_TEST,
      arguments: [{ objectId: hit.object.objectId }],
      returnByValue: false,
    },
    { signal, timeoutMs: 3_000 },
  );
  const props = verdict.result.objectId
    ? await target.session.send(
        "Runtime.getProperties",
        { objectId: verdict.result.objectId, ownProperties: true },
        { signal, timeoutMs: 3_000 },
      )
    : undefined;
  const value = (name: string) => props?.result.find((prop) => prop.name === name)?.value;
  if (value("ok")?.value !== false) return { ok: true };
  const describe = async (objectId: string | undefined) => {
    if (!objectId) return undefined;
    const described = await target.session
      .send("DOM.describeNode", { objectId }, { signal, timeoutMs: 3_000 })
      .catch(() => undefined);
    return described?.node.backendNodeId;
  };
  const info = JSON.parse(String(value("info")?.value ?? "{}")) as {
    role?: string;
    name?: string;
    inside?: { role: string; name: string }[];
  };
  const coverRef = refFor(await describe(value("cover")?.objectId));
  const insideIds = value("insideEls")?.objectId
    ? await target.session.send(
        "Runtime.getProperties",
        { objectId: value("insideEls")?.objectId as string, ownProperties: true },
        { signal, timeoutMs: 3_000 },
      )
    : undefined;
  const inside = await Promise.all(
    (info.inside ?? []).map(async (item, index) => {
      const element = insideIds?.result.find((prop) => prop.name === String(index))?.value
        ?.objectId;
      const ref = refFor(await describe(element));
      return { ...item, ...(ref ? { ref } : {}) };
    }),
  );
  return {
    ok: false,
    occluder: {
      role: info.role ?? "element",
      name: info.name ?? "",
      inside,
      ...(coverRef ? { ref: coverRef } : {}),
    },
  };
}

// `this` is the target, `hit` the element at the point. Containment is checked
// across shadow roots; labels count as the control they label.
const HIT_TEST = `function (hit) {
  var target = this;
  function composedContains(outer, inner) {
    for (var node = inner; node; node = node.parentNode || node.host) if (node === outer) return true;
    return false;
  }
  if (composedContains(target, hit) || composedContains(hit, target)) return { ok: true };
  var label = hit.closest && hit.closest("label");
  if (label && (label.control === target || composedContains(label, target))) return { ok: true };
  if (target.labels) for (var i = 0; i < target.labels.length; i++) if (composedContains(target.labels[i], hit)) return { ok: true };
  var interactive = "a[href],button,input,select,textarea,[role=button],[role=link],[onclick],[tabindex]";
  var cover = hit;
  for (var n = hit; n && n !== document.body; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
    var style = getComputedStyle(n);
    if (n.getAttribute && (n.getAttribute("role") === "dialog" || n.getAttribute("aria-modal") === "true" || n.getAttribute("aria-label") || n.tagName === "DIALOG" || style.position === "fixed" || style.position === "sticky")) { cover = n; break; }
    if (n.matches && n.matches(interactive)) { cover = n; break; }
  }
  var role = cover.getAttribute("role") || cover.tagName.toLowerCase();
  var name = cover.getAttribute("aria-label") || (cover.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  var insideEls = Array.prototype.slice.call(cover.querySelectorAll ? cover.querySelectorAll("button,a[href],[role=button]") : [], 0, 4);
  var inside = insideEls.map(function (el) {
    return { role: el.getAttribute("role") || (el.tagName === "A" ? "link" : "button"), name: (el.getAttribute("aria-label") || el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40) };
  });
  return { ok: false, cover: cover, insideEls: insideEls, info: JSON.stringify({ role: role, name: name, inside: inside }) };
}`;

export async function mouseClick(
  session: CdpSession,
  point: Point,
  options: {
    button?: MouseButton;
    clickCount?: number;
    modifiers?: Modifier[];
    signal?: AbortSignal | undefined;
  } = {},
): Promise<void> {
  const button = options.button ?? "left";
  const modifiers = modifierMask(options.modifiers);
  const send = { signal: options.signal, timeoutMs: 5_000 };
  const base = { x: point.x, y: point.y, modifiers };
  await dispatchMove(session, base, options.signal);
  const clicks = options.clickCount ?? 1;
  for (let count = 1; count <= clicks; count++) {
    await session.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", ...base, button, buttons: BUTTON_BITS[button], clickCount: count },
      send,
    );
    await session.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", ...base, button, buttons: 0, clickCount: count },
      send,
    );
  }
}

// False when the window is not being drawn and the hover never reached the page.
export async function mouseMove(
  session: CdpSession,
  point: Point,
  signal?: AbortSignal,
): Promise<boolean> {
  return dispatchMove(session, { x: point.x, y: point.y }, signal);
}

// Presses at `from`, moves in steps, releases at `to`. HTML5 drag-and-drop is
// intercepted and replayed as drag events; pointer-driven drags get the moves.
export async function mouseDrag(
  session: CdpSession,
  from: Point,
  to: Point,
  signal?: AbortSignal,
): Promise<"html5" | "pointer"> {
  const send = { signal, timeoutMs: 5_000 };
  await session.send("Input.setInterceptDrags", { enabled: true }, send);
  let dragData: Protocol.Input.DragData | undefined;
  const off = session.on("Input.dragIntercepted", (event) => {
    dragData = event.data;
  });
  try {
    await dispatchMove(session, from, signal);
    await session.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 },
      send,
    );
    const steps = 8;
    for (let step = 1; step <= steps; step++) {
      const point = {
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      };
      await dispatchMove(session, { ...point, button: "left", buttons: 1 }, signal);
      if (dragData) break;
    }
    if (dragData) {
      for (const type of ["dragEnter", "dragOver", "drop"] as const) {
        await session.send(
          "Input.dispatchDragEvent",
          { type, x: to.x, y: to.y, data: dragData },
          send,
        );
      }
      await session.send(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 },
        send,
      );
      return "html5";
    }
    await session.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 },
      send,
    );
    return "pointer";
  } finally {
    off();
    await session.send("Input.setInterceptDrags", { enabled: false }, send).catch(() => {});
  }
}
