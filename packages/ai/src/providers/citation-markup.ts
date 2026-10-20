// OpenAI's built-in web search can leave its internal citation markup in output
// text: U+E200, a directive name, U+E202-separated references, U+E201, e.g.
// "\ue200cite\ue202turn0view0\ue201". Those references mean nothing outside
// OpenAI's own interface and the private-use characters render invisibly, so the
// markup is removed (with the space it leaves doubled) as text streams in.
const START = "\ue200";
const END = "\ue201";
const SPAN = /^\ue200[a-z_]+(?:\ue202[^\ue200-\ue202]*)*\ue201$/;
// A start marker this far from any end marker is not markup.
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
      const end = input.indexOf(END);
      if (end === -1) {
        if (input.length > MAX_SPAN) {
          out += this.emit(input, at);
          at += input.length;
        } else {
          this.held = input;
        }
        break;
      }
      const span = input.slice(0, end + 1);
      if (SPAN.test(span)) {
        this.removed.push({ at, length: span.length });
        const before = (this.emitted + out).at(-1);
        this.dropSpace = before === undefined || before === " " || before === "\n";
      } else {
        out += this.emit(span, at);
      }
      at += span.length;
      input = input.slice(end + 1);
    }
    this.consumed = at;
    this.emitted = (this.emitted + out).slice(-1);
    return out;
  }

  // The end of the text: a start marker never closed is dropped with what follows.
  flush(): string {
    if (this.held) {
      this.removed.push({ at: this.consumed, length: this.held.length });
      this.consumed += this.held.length;
      this.held = "";
    }
    return "";
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
