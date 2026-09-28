import type { Ref } from "./refs.ts";

export interface NodeStates {
  checked?: "true" | "false" | "mixed";
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  required?: boolean;
  focused?: boolean;
  invalid?: boolean;
  pressed?: boolean;
  readonly?: boolean;
  level?: number;
}

export type NodeKind = "interactive" | "text" | "container" | "frame";

export interface PageNode {
  kind: NodeKind;
  role: string;
  name: string;
  value?: string;
  states: NodeStates;
  url?: string;
  ref?: Ref;
  backendNodeId?: number;
  frameId: string;
  box?: { x: number; y: number; w: number; h: number };
  inViewport: boolean;
  editable?: "text" | "rich" | "secret" | "otp";
  // Full length of text this node's name was truncated from, when it was.
  textLength?: number;
  options?: string[];
  optionCount?: number;
  cursorOnly?: boolean;
  children: PageNode[];
}

export interface PageModel {
  documentId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number; pageHeight: number };
  root: PageNode;
  modal?: PageNode;
  // Interactive nodes left out of a viewport-scoped capture.
  offscreen: { above: number; below: number };
  frames: number;
  // The ref table was reset because the main document changed since the last capture.
  newDocument: boolean;
  // Frames that could not be captured (for example, still loading).
  frameErrors: string[];
}
