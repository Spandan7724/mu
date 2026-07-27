import { CURSOR, type Terminal } from "./terminal.ts";
import { terminalRows } from "./wrap.ts";

const CLEAR_SCREEN_AND_SCROLLBACK = "\u001b[2J\u001b[H\u001b[3J";

// Retains the complete rendered screen as mutable rows. Ordinary tail changes
// are differential; a change above the visible viewport rebuilds the screen
// and terminal scrollback from the retained transcript.
export class FullScreenRenderer {
  private previous: string[] = [];
  private viewportTop = 0;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: string[] | undefined;
  private lastWidth: number;
  private lastHeight: number;

  constructor(
    private terminal: Terminal,
    private throttleMs = 24,
  ) {
    this.lastWidth = terminal.columns;
    this.lastHeight = terminal.rows;
  }

  render(lines: string[]): void {
    this.pending = lines;
    if (this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      const next = this.pending;
      this.pending = undefined;
      if (next) this.paint(next);
    }, this.throttleMs);
  }

  renderNow(lines: string[]): void {
    this.cancelPending();
    this.paint(lines);
  }

  private paint(lines: string[]): void {
    const widthChanged = this.terminal.columns !== this.lastWidth;
    const heightChanged = this.terminal.rows !== this.lastHeight;
    this.lastWidth = this.terminal.columns;
    this.lastHeight = this.terminal.rows;
    const rows = terminalRows(lines, this.terminal.columns);

    if (this.previous.length === 0 || widthChanged || heightChanged) {
      this.fullRender(rows);
      return;
    }

    const firstChanged = firstChangedRow(this.previous, rows);
    if (firstChanged < 0) return;

    if (rows.length < this.previous.length || firstChanged < this.viewportTop) {
      this.fullRender(rows);
      return;
    }

    let body: string;
    if (firstChanged === this.previous.length) {
      body = `\r\n${this.draw(rows.slice(firstChanged))}`;
    } else {
      const moveUp = this.previous.length - 1 - firstChanged;
      body = `\r${CURSOR.up(moveUp)}${CURSOR.clearBelow}${this.draw(rows.slice(firstChanged))}`;
    }
    this.previous = [...rows];
    this.viewportTop = Math.max(0, rows.length - this.terminal.rows);
    this.terminal.frame(body);
  }

  private fullRender(rows: string[]): void {
    this.previous = [...rows];
    this.viewportTop = Math.max(0, rows.length - this.terminal.rows);
    this.terminal.frame(CLEAR_SCREEN_AND_SCROLLBACK + this.draw(rows));
  }

  private draw(lines: string[]): string {
    return lines.join("\r\n");
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
    this.previous = [];
    this.viewportTop = 0;
    this.terminal.frame(CLEAR_SCREEN_AND_SCROLLBACK);
  }

  get lineCount(): number {
    return this.previous.length;
  }

  stop(): void {
    this.cancelPending();
  }
}

function firstChangedRow(previous: string[], next: string[]): number {
  const length = Math.max(previous.length, next.length);
  for (let index = 0; index < length; index++) {
    if (previous[index] !== next[index]) return index;
  }
  return -1;
}
