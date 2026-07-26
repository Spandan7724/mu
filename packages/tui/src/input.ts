// Input decoder: an escape-sequence state machine over raw stdin bytes.
// Handles bracketed paste (so a multi-line paste never submits), the kitty
// keyboard protocol, and paste-burst coalescing.

export interface Key {
  name: string; // "a", "return", "up", "escape", …
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  // Printable text this key produced, if any.
  text?: string;
}

export type InputEvent =
  | { type: "key"; key: Key }
  | { type: "paste"; text: string }
  | { type: "unknown"; raw: string };

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

const SIMPLE: Record<string, string> = {
  "\r": "return",
  "\n": "return",
  "\t": "tab",
  "\u007f": "backspace",
  "\b": "backspace",
  " ": "space",
};

const CSI_FINAL: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

const CSI_TILDE: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
};

function modifiersFrom(param: number | undefined): Pick<Key, "ctrl" | "alt" | "shift"> {
  // xterm encodes modifiers as 1 + bitmask (shift 1, alt 2, ctrl 4).
  const mask = (param ?? 1) - 1;
  return {
    shift: (mask & 1) !== 0,
    alt: (mask & 2) !== 0,
    ctrl: (mask & 4) !== 0,
  };
}

function plainKey(name: string, text?: string): Key {
  return { name, ctrl: false, alt: false, shift: false, ...(text !== undefined ? { text } : {}) };
}

// Stateful because a paste — or an escape sequence — can be split across reads.
export class InputDecoder {
  private buffer = "";
  private pasting = false;
  private pasteBuffer = "";

  push(chunk: string): InputEvent[] {
    this.buffer += chunk;
    const events: InputEvent[] = [];

    for (;;) {
      if (this.buffer.length === 0) break;

      if (this.pasting) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end === -1) {
          this.pasteBuffer += this.buffer;
          this.buffer = "";
          break;
        }
        this.pasteBuffer += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        this.pasting = false;
        events.push({ type: "paste", text: this.pasteBuffer });
        this.pasteBuffer = "";
        continue;
      }

      if (this.buffer.startsWith(PASTE_START)) {
        this.buffer = this.buffer.slice(PASTE_START.length);
        this.pasting = true;
        continue;
      }
      // A partial paste marker: wait for the rest rather than mis-decoding it.
      if (PASTE_START.startsWith(this.buffer)) break;

      const event = this.decodeOne();
      if (!event) break; // incomplete sequence
      events.push(event);
    }

    return events;
  }

  private decodeOne(): InputEvent | undefined {
    const buffer = this.buffer;
    const first = buffer[0] as string;

    if (first !== "\u001b") {
      this.buffer = buffer.slice(first.length === 1 ? 1 : first.length);
      // Take a whole code point (so astral characters survive).
      const char = String.fromCodePoint(buffer.codePointAt(0) ?? 0);
      this.buffer = buffer.slice(char.length);

      if (SIMPLE[char])
        return {
          type: "key",
          key: plainKey(SIMPLE[char] as string, char === " " ? " " : undefined),
        };
      const code = char.charCodeAt(0);
      if (code < 0x20) {
        // Ctrl+letter arrives as the control code itself.
        return {
          type: "key",
          key: { name: String.fromCharCode(code + 96), ctrl: true, alt: false, shift: false },
        };
      }
      return { type: "key", key: plainKey(char, char) };
    }

    // Lone ESC with nothing after it yet — could still become a sequence.
    if (buffer.length === 1) return undefined;

    if (buffer[1] === "[") {
      // The ESC prefix is already verified, so match the remainder — that
      // keeps the control character out of the pattern itself.
      const match = /^\[([0-9;:]*)([A-Za-z~])/.exec(buffer.slice(1));
      if (!match) return undefined; // incomplete CSI
      const [body, params = "", final = ""] = match;
      const raw = buffer.slice(0, 1 + body.length);
      this.buffer = buffer.slice(raw.length);
      const parts = params.split(";");
      const modifiers = modifiersFrom(Number(parts[1]));

      if (final === "~") {
        const name = CSI_TILDE[parts[0] ?? ""];
        return name ? { type: "key", key: { name, ...modifiers } } : { type: "unknown", raw };
      }
      // kitty protocol: CSI unicode-codepoint ; modifiers u
      if (final === "u") {
        const codePoint = Number(parts[0]);
        if (!Number.isNaN(codePoint)) {
          const char = String.fromCodePoint(codePoint);
          return {
            type: "key",
            key: {
              name: char,
              ...modifiers,
              ...(!modifiers.ctrl && !modifiers.alt ? { text: char } : {}),
            },
          };
        }
      }
      const name = CSI_FINAL[final];
      return name ? { type: "key", key: { name, ...modifiers } } : { type: "unknown", raw };
    }

    if (buffer[1] === "O") {
      const match = /^O([A-Za-z])/.exec(buffer.slice(1));
      if (!match) return undefined;
      const raw = buffer.slice(0, 1 + match[0].length);
      this.buffer = buffer.slice(raw.length);
      const name = CSI_FINAL[match[1] ?? ""];
      return name ? { type: "key", key: plainKey(name) } : { type: "unknown", raw };
    }

    // ESC followed by a character is Alt+that character.
    const char = String.fromCodePoint(buffer.codePointAt(1) ?? 0);
    this.buffer = buffer.slice(1 + char.length);
    if (char === "\u001b") return { type: "key", key: plainKey("escape") };
    return { type: "key", key: { name: char, ctrl: false, alt: true, shift: false } };
  }

  // Flushes a lone pending ESC as the Escape key. Call on an idle timer: a real
  // Escape press is indistinguishable from the start of a sequence until then.
  flushPendingEscape(): InputEvent | undefined {
    if (this.buffer === "\u001b") {
      this.buffer = "";
      return { type: "key", key: plainKey("escape") };
    }
    return undefined;
  }

  get pending(): string {
    return this.buffer;
  }
}

// Coalesces a burst of fast keystrokes (a paste into a terminal without
// bracketed-paste support) into one text event, so the editor is not redrawn
// per character.
export class PasteBurstDetector {
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private onFlush: (text: string) => void,
    private windowMs = 20,
    private threshold = 3,
  ) {}

  push(text: string): boolean {
    this.pending += text;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.windowMs);
    return this.pending.length >= this.threshold;
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const text = this.pending;
    this.pending = "";
    this.onFlush(text);
  }

  get buffered(): string {
    return this.pending;
  }
}
