import { CURSOR, type Terminal } from "./terminal.ts";

const CLEAR_SCREEN_AND_SCROLLBACK = "\u001b[2J\u001b[H\u001b[3J";

export interface RenderFrame {
  readonly transcript: readonly string[];
  readonly managed: readonly string[];
  // Conservative flattened row at which changes may begin. The renderer
  // ignores this hint when the transcript segment identity changed.
  readonly dirtyFrom: number;
}

// Retains the complete physical screen as immutable segments. Ordinary tail changes
// are differential; a change above the visible viewport rebuilds the screen
// and terminal scrollback from the retained transcript.
export class FullScreenRenderer {
  private previous: RenderFrame | undefined;
  private viewportTop = 0;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: (() => RenderFrame) | undefined;
  private lastWidth: number;
  private lastHeight: number;

  constructor(
    private terminal: Terminal,
    private throttleMs = 24,
  ) {
    this.lastWidth = terminal.columns;
    this.lastHeight = terminal.rows;
  }

  render(frame: RenderFrame): void {
    this.requestRender(() => frame);
  }

  // Defers both component layout and terminal painting until the next frame.
  // Streaming providers can emit many deltas inside one frame interval; doing
  // the expensive layout before coalescing would still parse and wrap every
  // intermediate state even though none of them can reach the terminal.
  requestRender(produceFrame: () => RenderFrame): void {
    this.pending = produceFrame;
    if (this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      const produceNext = this.pending;
      this.pending = undefined;
      if (produceNext) this.paint(produceNext());
    }, this.throttleMs);
  }

  renderNow(frame: RenderFrame): void {
    this.cancelPending();
    this.paint(frame);
  }

  private paint(frame: RenderFrame): void {
    const widthChanged = this.terminal.columns !== this.lastWidth;
    const heightChanged = this.terminal.rows !== this.lastHeight;
    this.lastWidth = this.terminal.columns;
    this.lastHeight = this.terminal.rows;
    const previous = this.previous;
    const rowCount = frameRowCount(frame);

    if (!previous || widthChanged || heightChanged) {
      this.fullRender(frame);
      return;
    }

    const dirtyFrom =
      frame.transcript === previous.transcript
        ? Math.max(frame.transcript.length, frame.dirtyFrom)
        : 0;
    const firstChanged = firstChangedRow(previous, frame, dirtyFrom);
    if (firstChanged < 0) return;

    if (rowCount < frameRowCount(previous) || firstChanged < this.viewportTop) {
      this.fullRender(frame);
      return;
    }

    let body: string;
    if (firstChanged === frameRowCount(previous)) {
      body = `\r\n${drawFrom(frame, firstChanged)}`;
    } else {
      const moveUp = frameRowCount(previous) - 1 - firstChanged;
      body = `\r${CURSOR.up(moveUp)}${CURSOR.clearBelow}${drawFrom(frame, firstChanged)}`;
    }
    this.previous = frame;
    this.viewportTop = Math.max(0, rowCount - this.terminal.rows);
    this.terminal.frame(body);
  }

  private fullRender(frame: RenderFrame): void {
    this.previous = frame;
    this.viewportTop = Math.max(0, frameRowCount(frame) - this.terminal.rows);
    this.terminal.frame(CLEAR_SCREEN_AND_SCROLLBACK + drawFrom(frame, 0));
  }

  private cancelPending(): void {
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
    }
    this.pending = undefined;
  }

  clear(): void {
    this.cancelPending();
    this.previous = undefined;
    this.viewportTop = 0;
    this.terminal.frame(CLEAR_SCREEN_AND_SCROLLBACK);
  }

  get lineCount(): number {
    return this.previous ? frameRowCount(this.previous) : 0;
  }

  stop(): void {
    this.cancelPending();
  }
}

function frameRowCount(frame: RenderFrame): number {
  return frame.transcript.length + frame.managed.length;
}

function frameRow(frame: RenderFrame, index: number): string | undefined {
  return index < frame.transcript.length
    ? frame.transcript[index]
    : frame.managed[index - frame.transcript.length];
}

function drawFrom(frame: RenderFrame, start: number): string {
  if (start < frame.transcript.length) {
    return [...frame.transcript.slice(start), ...frame.managed].join("\r\n");
  }
  return frame.managed.slice(start - frame.transcript.length).join("\r\n");
}

function firstChangedRow(previous: RenderFrame, next: RenderFrame, start: number): number {
  const length = Math.max(frameRowCount(previous), frameRowCount(next));
  for (let index = start; index < length; index++) {
    if (frameRow(previous, index) !== frameRow(next, index)) return index;
  }
  return -1;
}
