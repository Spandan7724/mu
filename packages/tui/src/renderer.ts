import { CURSOR, type Terminal } from "./terminal.ts";
import { terminalRows } from "./wrap.ts";

// Inline model: the transcript is committed to the terminal's own
// scrollback and never repainted; only a small bottom region is diffed and
// redrawn. That is what makes native scroll, copy and search keep working.
export class InlineRenderer {
  private current: string[] = [];
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: string[] | undefined;
  private lastWidth: number;

  constructor(
    private terminal: Terminal,
    private throttleMs = 24, // ~40fps
  ) {
    this.lastWidth = terminal.columns;
  }

  // Writes lines above the managed region: they scroll away like any other
  // terminal output and become part of history.
  commit(lines: string[], next?: string[]): void {
    if (lines.length === 0) return;
    const committed = this.rows(lines);
    const managed = next ? this.rows(next) : this.current;
    if (next) this.cancelPending();
    const body =
      this.clearRegion() + committed.map((line) => `${line}\n`).join("") + this.draw(managed);
    this.current = [...managed];
    this.lastWidth = this.terminal.columns;
    this.terminal.frame(body);
  }

  // Replaces the managed bottom region. Coalesced so a burst of stream deltas
  // costs one repaint, not one per delta.
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

  // Bypasses the throttle — used on resize and at shutdown.
  renderNow(lines: string[]): void {
    this.cancelPending();
    this.paint(lines);
  }

  private paint(lines: string[]): void {
    const widthChanged = this.terminal.columns !== this.lastWidth;
    if (widthChanged) this.lastWidth = this.terminal.columns;
    const rows = this.rows(lines);

    // Nothing to do when the region is identical and the terminal did not resize.
    if (!widthChanged && sameLines(this.current, rows)) return;

    const body = this.clearRegion() + this.draw(rows);
    this.current = [...rows];
    this.terminal.frame(body);
  }

  private rows(lines: string[]): string[] {
    return terminalRows(lines, this.terminal.columns);
  }

  private cancelPending(): void {
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
    }
    this.pending = undefined;
  }

  private clearRegion(): string {
    if (this.current.length === 0) return `\r${CURSOR.clearLine}`;
    // Move to the top of the region and clear everything below it.
    return `\r${CURSOR.up(this.current.length - 1)}${CURSOR.clearBelow}`;
  }

  private draw(lines: string[]): string {
    return lines.join("\n");
  }

  clear(): void {
    if (this.current.length === 0) return;
    this.terminal.frame(this.clearRegion());
    this.current = [];
  }

  get regionHeight(): number {
    return this.current.length;
  }

  stop(): void {
    this.cancelPending();
  }
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
