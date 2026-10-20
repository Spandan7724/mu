// OpenAI's built-in web search can leave its internal citation markup in output
// text: U+E200, a directive name, U+E202-separated references, U+E201, e.g.
// "\ue200cite\ue202turn0view0\ue201". Those references mean nothing outside
// OpenAI's own interface and the private-use characters render invisibly, so the
// markup is removed (with the space it leaves doubled) as text streams in.
const START = "\ue200";
const END = "\ue201";
// As much of a span as can be markup: a name, then separator-led references.
const PREFIX = /^\ue200[a-z_]*(?:\ue202[A-Za-z0-9_.-]*)*/;
// Text unfinished at the end of a message is dropped only when it is plainly
// markup; anything else, such as a font icon at U+E200, is ordinary text.
const UNFINISHED = /^\ue200[a-z_]+\ue202/;
const NAMED = /^\ue200[a-z_]/;
const MAX_SPAN = 1_024;

export class CitationMarkupFilter {
  // Text from an unmatched start marker, held until it can be judged.
  private held = "";
  // Raw characters consumed before `held`.
  private consumed = 0;
  private emitted = "";
  private dropSpace = false;
  // Removed raw ranges, so offsets into the raw text can be mapped.
  private readonly removed: { at: number; length: number }[] = [];

  push(delta: string): string {
    let input = this.held + delta;
    let at = this.consumed;
    this.held = "";
    let out = "";
    for (;;) {
      const start = input.indexOf(START);
      if (start === -1) {
        out += this.emit(input, at);
        at += input.length;
        break;
      }
      out += this.emit(input.slice(0, start), at);
      at += start;
      input = input.slice(start);
      const prefix = PREFIX.exec(input)?.[0] ?? START;
      const next = input[prefix.length];
      if (next === undefined && prefix.length <= MAX_SPAN) {
        // Could still become markup; wait for more text.
        this.held = input;
        break;
      }
      if (next === END && NAMED.test(prefix)) {
        const span = prefix.length + 1;
        this.removed.push({ at, length: span });
        const before = (this.emitted + out).at(-1);
        this.dropSpace = before === undefined || before === " " || before === "\n";
        at += span;
        input = input.slice(span);
        continue;
      }
      // Not markup: the marker is text, and scanning resumes right after it.
      out += this.emit(START, at);
      at += 1;
      input = input.slice(1);
    }
    this.consumed = at;
    this.emitted = (this.emitted + out).slice(-1);
    return out;
  }

  // The end of the text: unfinished markup is dropped; any other held text is emitted.
  flush(): string {
    const held = this.held;
    this.held = "";
    if (!held) return "";
    if (UNFINISHED.test(held)) {
      this.removed.push({ at: this.consumed, length: held.length });
      this.consumed += held.length;
      return "";
    }
    const out = this.emit(held, this.consumed);
    this.consumed += held.length;
    this.emitted = (this.emitted + out).slice(-1);
    return out;
  }

  // Where a raw-text offset lands in the filtered text.
  mapIndex(raw: number): number {
    let shift = 0;
    for (const range of this.removed) {
      if (range.at >= raw) break;
      shift += Math.min(range.length, raw - range.at);
    }
    return raw - shift;
  }

  private emit(text: string, at: number): string {
    if (!this.dropSpace || text === "") return text;
    this.dropSpace = false;
    if (!text.startsWith(" ")) return text;
    this.removed.push({ at, length: 1 });
    return text.slice(1);
  }
}

export function stripCitationMarkup(text: string): string {
  const filter = new CitationMarkupFilter();
  return filter.push(text) + filter.flush();
}
