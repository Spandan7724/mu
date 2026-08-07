import type { AgentEvent, StreamDelta, ToolResultContent } from "@mu/core";
import type { ResolvedPolicy } from "@mu/protocol";
import type { BlobStore } from "./blobs.ts";

const STUB_HEAD_BYTES = 1024;

// The one event that must always arrive intact and immediately, under every
// policy (PROTOCOL.md §8.5). Everything in this file checks it first.
export function isExempt(event: AgentEvent): boolean {
  return event.type === "permission_asked";
}

function stubText(text: string, ref: string, bytes: number): ToolResultContent {
  return {
    type: "text",
    text: text.slice(0, STUB_HEAD_BYTES),
    truncated: true,
    blobRef: ref,
    bytes,
  } as ToolResultContent;
}

function budgetContent(
  content: ToolResultContent[],
  policy: ResolvedPolicy,
  blobs: BlobStore,
): ToolResultContent[] | undefined {
  const inlineBytes = JSON.stringify(content).length;
  const hasImage = content.some((block) => block.type === "image");
  const overBudget = inlineBytes > policy.maxInlineBytes;
  const stubImages = hasImage && policy.images === "stub";
  if (!overBudget && !stubImages) return undefined;

  const { ref, bytes } = blobs.put(content);
  if (overBudget) {
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return [stubText(text, ref, bytes)];
  }
  return content.map((block) =>
    block.type === "image" ? stubText(`[image ${block.mimeType}]`, ref, bytes) : block,
  );
}

// Tool results above the subscriber's inline budget become a stub carrying a
// blobRef. permission_asked is exempt: an approval decision made against a
// truncated command is exactly the failure this design exists to prevent.
export function applyBudget(
  event: AgentEvent,
  policy: ResolvedPolicy,
  blobs: BlobStore,
): AgentEvent {
  if (isExempt(event)) return event;
  if (event.type === "tool_execution_end") {
    const budgeted = budgetContent(event.result.content, policy, blobs);
    if (!budgeted) return event;
    return { ...event, result: { ...event.result, content: budgeted } };
  }
  if (event.type === "tool_execution_update") {
    const budgeted = budgetContent(event.partial, policy, blobs);
    return budgeted ? { ...event, partial: budgeted } : event;
  }
  return event;
}

type UpdateEvent = Extract<AgentEvent, { type: "message_update" }>;

function mergeable(a: StreamDelta, b: StreamDelta): boolean {
  if (a.kind !== b.kind || a.contentIndex !== b.contentIndex) return false;
  return a.kind === "text_delta" || a.kind === "thinking_delta" || a.kind === "toolcall_delta";
}

function merge(deltas: StreamDelta[]): StreamDelta {
  const first = deltas[0] as StreamDelta;
  if (deltas.length === 1) return first;
  if (first.kind === "text_delta" || first.kind === "thinking_delta") {
    const text = deltas
      .map((delta) => (delta.kind === first.kind ? (delta as { text: string }).text : ""))
      .join("");
    return { ...first, text } as StreamDelta;
  }
  const argsFragment = deltas
    .map((delta) => (delta.kind === "toolcall_delta" ? delta.argsFragment : ""))
    .join("");
  return { ...first, argsFragment } as StreamDelta;
}

// Collapses a run of buffered updates into as few as the deltas allow, keeping
// order and keeping the accumulating message that each run ended on. Nothing is
// dropped: every update carries the whole message, so the last one in a run
// already contains everything the ones before it did.
export function collapseUpdates(buffer: UpdateEvent[]): UpdateEvent[] {
  const out: UpdateEvent[] = [];
  let run: UpdateEvent[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const last = run[run.length - 1] as UpdateEvent;
    out.push({ ...last, delta: merge(run.map((update) => update.delta)) });
    run = [];
  };
  for (const update of buffer) {
    const previous = run[run.length - 1];
    if (previous && !mergeable(previous.delta, update.delta)) flushRun();
    run.push(update);
  }
  flushRun();
  return out;
}

export interface ShaperOptions {
  policy: ResolvedPolicy;
  blobs: BlobStore;
  emit: (event: AgentEvent) => void;
  // Injected so tests drive coalescing windows without real time.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

// Per-subscriber shaping. The kernel keeps emitting at full fidelity; what a
// listener costs is a property of who is listening (RD5).
export class Shaper {
  private buffer: UpdateEvent[] = [];
  private timer: unknown;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ShaperOptions) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  push(event: AgentEvent): void {
    const { policy } = this.options;
    if (policy.updates === "none" && !isExempt(event)) return;
    if (event.type === "task_output" && !policy.taskOutput) return;

    if (policy.updates === "coalesced" && event.type === "message_update") {
      this.buffer.push(event);
      if (this.timer === undefined) {
        this.timer = this.setTimer(() => {
          this.timer = undefined;
          this.drain();
        }, 1000 / policy.updateHz);
      }
      return;
    }

    // Anything not buffered flushes first, so coalescing can delay an update
    // but can never reorder one past the event that followed it.
    this.flush();
    this.options.emit(applyBudget(event, policy, this.options.blobs));
  }

  // Emits everything pending right now. Turn boundaries and every other
  // non-update event go through here before they are sent.
  flush(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.drain();
  }

  private drain(): void {
    if (this.buffer.length === 0) return;
    const collapsed = collapseUpdates(this.buffer);
    this.buffer = [];
    for (const update of collapsed) {
      this.options.emit(applyBudget(update, this.options.policy, this.options.blobs));
    }
  }

  close(): void {
    this.flush();
  }
}
