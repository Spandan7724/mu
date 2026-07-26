const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

const CONTROL_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

// Repairs malformed string literals: escapes raw control characters and
// doubles backslashes before invalid escape sequences.
export function repairJson(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i] as string;
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    if (ch === "\\") {
      const next = json[i + 1];
      if (next === undefined) {
        out += "\\\\";
        continue;
      }
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(json.slice(i + 2, i + 6))) {
        out += json.slice(i, i + 6);
        i += 5;
        continue;
      }
      if (next !== "u" && VALID_ESCAPES.has(next)) {
        out += `\\${next}`;
        i += 1;
        continue;
      }
      out += "\\\\";
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f) {
      out += CONTROL_ESCAPES[ch] ?? `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

export function parseJsonWithRepair<T = unknown>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    const repaired = repairJson(json);
    if (repaired !== json) return JSON.parse(repaired) as T;
    throw error;
  }
}

// Tolerant recursive-descent parser for truncated JSON. Returns as much of the
// value as can be recovered; never throws on truncation.

class PartialParser {
  pos = 0;
  constructor(private text: string) {}

  private ws(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos] as string)) this.pos++;
  }

  private peek(): string | undefined {
    return this.text[this.pos];
  }

  value(): unknown {
    this.ws();
    const ch = this.peek();
    if (ch === undefined) return undefined;
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    if (ch === '"') return this.string();
    if (ch === "t" || ch === "f" || ch === "n") return this.literal();
    if (ch === "-" || /[0-9]/.test(ch)) return this.number();
    return undefined;
  }

  private object(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    this.pos++; // {
    for (;;) {
      this.ws();
      if (this.peek() === undefined) return obj;
      if (this.peek() === "}") {
        this.pos++;
        return obj;
      }
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() !== '"') return obj;
      const keyStart = this.pos;
      const key = this.string();
      // Key string was truncated (never closed): drop the partial key.
      if (this.pos >= this.text.length && !this.closedString(keyStart)) return obj;
      this.ws();
      if (this.peek() !== ":") return obj;
      this.pos++; // :
      this.ws();
      if (this.peek() === undefined) return obj;
      const valStart = this.pos;
      const val = this.value();
      if (val !== undefined || this.consumedNull(valStart)) obj[key] = val ?? null;
    }
  }

  private array(): unknown[] {
    const arr: unknown[] = [];
    this.pos++; // [
    for (;;) {
      this.ws();
      if (this.peek() === undefined) return arr;
      if (this.peek() === "]") {
        this.pos++;
        return arr;
      }
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      const start = this.pos;
      const val = this.value();
      if (val === undefined && !this.consumedNull(start)) return arr;
      arr.push(val ?? null);
    }
  }

  private closedString(start: number): boolean {
    // Whether the string starting at `start` had a closing quote.
    let i = start + 1;
    while (i < this.text.length) {
      if (this.text[i] === "\\") i += 2;
      else if (this.text[i] === '"') return true;
      else i += 1;
    }
    return false;
  }

  private consumedNull(start: number): boolean {
    return this.text.slice(start, this.pos).trim().startsWith("null");
  }

  private string(): string {
    this.pos++; // "
    let out = "";
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch === "\\") {
        const next = this.text[this.pos + 1];
        if (next === undefined) {
          this.pos++;
          return out; // dangling escape at truncation point
        }
        if (next === "u") {
          const hex = this.text.slice(this.pos + 2, this.pos + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.pos += 6;
          } else {
            this.pos = this.text.length; // truncated unicode escape
            return out;
          }
          continue;
        }
        const map: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        out += map[next] ?? next;
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos++;
    }
    return out; // unterminated
  }

  private literal(): unknown {
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (word.startsWith(this.text.slice(this.pos, this.pos + word.length))) {
        const rest = this.text.slice(this.pos);
        if (word.startsWith(rest)) {
          // Truncated literal: accept the prefix as the full literal.
          this.pos = this.text.length;
          return value;
        }
        if (rest.startsWith(word)) {
          this.pos += word.length;
          return value;
        }
      }
    }
    this.pos = this.text.length;
    return undefined;
  }

  private number(): number | undefined {
    const match = /^-?[0-9]*\.?[0-9]*(?:[eE][+-]?[0-9]*)?/.exec(this.text.slice(this.pos));
    const raw = match?.[0] ?? "";
    this.pos += raw.length;
    const n = Number(raw);
    return Number.isNaN(n) ? undefined : n;
  }
}

export function parsePartialJson(text: string): unknown {
  return new PartialParser(text).value();
}

// Best-effort parse of streaming/truncated tool-call argument JSON.
// Always returns an object.
export function salvageToolArgs(partialJson: string | undefined): Record<string, unknown> {
  if (!partialJson || partialJson.trim() === "") return {};
  try {
    const parsed = parseJsonWithRepair<unknown>(partialJson);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    for (const candidate of [partialJson, repairJson(partialJson)]) {
      try {
        const parsed = parsePartialJson(candidate);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // fall through
      }
    }
    return {};
  }
}
