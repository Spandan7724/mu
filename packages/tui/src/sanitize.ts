// Terminal-output sanitizer. Everything untrusted — model text, tool output,
// file paths, command strings, diff content — passes through here before it
// reaches the terminal.
//
// Untrusted text can otherwise carry OSC 52 (writes the user's clipboard),
// OSC 8 (deceptive hyperlinks), cursor/clear sequences (output spoofing) and
// DCS/APC payloads. We therefore strip control sequences outright rather than
// trying to enumerate the dangerous ones.

const ESC = "\u001b";

// Only SGR (colour/style) is ever preserved, and only when we emitted it.
// Matched against the sequence body (ESC already consumed).
const SGR = /^\[[0-9;]*m$/;

export interface SanitizeOptions {
  // Keep SGR sequences already present in the text. Used for strings mu
  // styled itself; never for content that came from a model or a subprocess.
  allowStyling?: boolean;
}

export function sanitizeTerminalText(text: string, options: SanitizeOptions = {}): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const char = text[i] as string;

    if (char === ESC) {
      const next = text[i + 1];

      // CSI: ESC [ params final. Keep only SGR, and only when allowed.
      if (next === "[") {
        const match = /^\[[0-9;:?]*[ -/]*[@-~]/.exec(text.slice(i + 1));
        if (match) {
          if (options.allowStyling && SGR.test(match[0])) out += ESC + match[0];
          i += 1 + match[0].length;
          continue;
        }
        i += 2; // malformed/split — drop the introducer
        continue;
      }

      // OSC / DCS / APC / PM / SOS carry payloads terminated by BEL or ST.
      if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
        const rest = text.slice(i + 2);
        const bel = rest.indexOf("\u0007");
        const st = rest.indexOf(`${ESC}\\`);
        const end =
          bel === -1 && st === -1
            ? rest.length
            : bel === -1
              ? st + 2
              : st === -1
                ? bel + 1
                : Math.min(bel + 1, st + 2);
        i += 2 + end;
        continue;
      }

      // Any other escape (including a lone trailing ESC) is dropped.
      i += next === undefined ? 1 : 2;
      continue;
    }

    const code = char.codePointAt(0) ?? 0;
    // Keep newline and tab; drop every other C0 control, DEL and C1.
    if (char === "\n" || char === "\t") {
      out += char;
    } else if (code === 0x0d) {
      // A bare CR would let content overwrite the line it was printed on.
      out += "";
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += "";
    } else {
      out += char;
    }
    i += char.length;
  }

  return out;
}

// Convenience for the common case: text from a model or a subprocess.
export function sanitizeUntrusted(text: string): string {
  return sanitizeTerminalText(text, { allowStyling: false });
}
