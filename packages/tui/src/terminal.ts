// Terminal control. Cleanup-on-crash is installed FIRST, before raw mode is
// ever enabled: a terminal left in raw mode with a hidden cursor is the worst
// failure a TUI can inflict, and it must survive an uncaught throw or a signal.

const SHOW_CURSOR = "\u001b[?25h";
const HIDE_CURSOR = "\u001b[?25l";
const BEGIN_SYNC = "\u001b[?2026h";
const END_SYNC = "\u001b[?2026l";
const BRACKETED_PASTE_ON = "\u001b[?2004h";
const BRACKETED_PASTE_OFF = "\u001b[?2004l";

export interface TerminalIo {
  write: (data: string) => void;
  columns: number;
  rows: number;
  isTty: boolean;
  setRawMode?: (raw: boolean) => void;
  onResize?: (handler: () => void) => () => void;
}

export function nodeTerminalIo(): TerminalIo {
  const stdout = process.stdout;
  const stdin = process.stdin;
  return {
    write: (data) => void stdout.write(data),
    get columns() {
      return stdout.columns ?? 80;
    },
    get rows() {
      return stdout.rows ?? 24;
    },
    isTty: Boolean(stdout.isTTY && stdin.isTTY),
    setRawMode: (raw) => {
      if (stdin.isTTY) stdin.setRawMode(raw);
    },
    onResize: (handler) => {
      stdout.on("resize", handler);
      return () => void stdout.off("resize", handler);
    },
  };
}

export class Terminal {
  private active = false;
  private cleanupHandlers: (() => void)[] = [];
  private restoreOnce = () => this.restore();

  constructor(private io: TerminalIo = nodeTerminalIo()) {}

  get columns(): number {
    return this.io.columns;
  }

  get rows(): number {
    return this.io.rows;
  }

  get isTty(): boolean {
    return this.io.isTty;
  }

  // Install teardown before touching terminal state, so any path out of the
  // process restores the terminal.
  start(): void {
    if (this.active) return;

    process.on("exit", this.restoreOnce);
    process.on("SIGINT", this.restoreOnce);
    process.on("SIGTERM", this.restoreOnce);
    process.on("uncaughtException", this.onFatal);
    process.on("unhandledRejection", this.onFatal);
    this.cleanupHandlers.push(() => {
      process.off("exit", this.restoreOnce);
      process.off("SIGINT", this.restoreOnce);
      process.off("SIGTERM", this.restoreOnce);
      process.off("uncaughtException", this.onFatal);
      process.off("unhandledRejection", this.onFatal);
    });

    this.active = true;
    this.io.setRawMode?.(true);
    this.io.write(HIDE_CURSOR + BRACKETED_PASTE_ON);
  }

  private onFatal = (error: unknown) => {
    this.restore();
    // Report after restoring, so the message is readable.
    process.stderr.write(`\nmu crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  };

  restore(): void {
    if (!this.active) return;
    this.active = false;
    this.io.write(BRACKETED_PASTE_OFF + SHOW_CURSOR);
    this.io.setRawMode?.(false);
    for (const cleanup of this.cleanupHandlers.splice(0)) cleanup();
  }

  // Synchronized output: the terminal renders the whole frame at once instead
  // of tearing halfway through a repaint.
  frame(body: string): void {
    this.io.write(BEGIN_SYNC + body + END_SYNC);
  }

  write(data: string): void {
    this.io.write(data);
  }

  onResize(handler: () => void): () => void {
    return this.io.onResize?.(handler) ?? (() => {});
  }
}

export const CURSOR = {
  up: (n: number) => (n > 0 ? `\u001b[${n}A` : ""),
  down: (n: number) => (n > 0 ? `\u001b[${n}B` : ""),
  toColumn: (n: number) => `\u001b[${n}G`,
  clearLine: "\u001b[2K",
  clearBelow: "\u001b[J",
};
