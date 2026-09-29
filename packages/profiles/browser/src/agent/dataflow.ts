// Notices when an action would carry text read on one site to a different site
// (a URL built from page data, page text typed into another site's form): the
// shape of a prompt-injection exfiltration. Heuristic by design; the approval it
// triggers, not this check, is the boundary.

// Shorter overlaps are ordinary words and phrases shared by any two pages.
const WINDOW = 20;
const STRIDE = 4;
const MAX_CORPUS = 400_000;
// A long query or fragment built for a site never seen in this session.
const LONG_DATA = 256;

export interface Leak {
  from: string;
  sample: string;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function decode(value: string): string {
  let decoded = value.replace(/\+/g, " ");
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

// Values too short for the window check that still identify something: email
// addresses, long numbers (codes, accounts), and letter-digit IDs.
const TOKEN =
  /[\w.+-]+@[\w-]+\.[\w.-]+|\b\d{6,}\b|\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/gi;
const MAX_TOKENS = 5_000;

function tokensIn(text: string): string[] {
  return (text.match(TOKEN) ?? []).map((token) => token.toLowerCase());
}

const printable = (text: string) =>
  text.length > 0 && /^[\x20-\x7e\t\n\r -￿]*$/.test(text) && !text.includes("�");

// A URL part as written, plus what it says if it is base64 or hex: re-encoding page
// text is the cheapest way around a plain-text check.
function readings(part: string): string[] {
  const out = [part];
  const compact = part.replace(/\s/g, "");
  if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(compact)) {
    const decoded = Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    if (printable(decoded)) out.push(decoded);
  }
  if (/^(?:[0-9a-f]{2}){8,}$/i.test(compact)) {
    const decoded = Buffer.from(compact, "hex").toString("utf8");
    if (printable(decoded)) out.push(decoded);
  }
  return out;
}

export class DataFlowGuard {
  private readonly corpora = new Map<string, string>();
  private readonly tokens = new Map<string, Set<string>>();
  private readonly links = new Set<string>();
  private user = "";

  // Page text the model was shown, by the host it came from.
  observe(host: string, text: string): void {
    if (!host || !text) return;
    const next = `${this.corpora.get(host) ?? ""}\n${normalize(text)}`;
    this.corpora.set(host, next.length > MAX_CORPUS ? next.slice(-MAX_CORPUS) : next);
    const seen = this.tokens.get(host) ?? new Set<string>();
    for (const token of tokensIn(text)) if (seen.size < MAX_TOKENS) seen.add(token);
    this.tokens.set(host, seen);
  }

  // A distinctive value from another host's pages inside `text`.
  private tokenLeak(text: string, targetHost: string): Leak | undefined {
    for (const token of tokensIn(text)) {
      if (this.user.includes(token)) continue;
      for (const [host, seen] of this.tokens) {
        if (host !== targetHost && seen.has(token)) return { from: host, sample: token };
      }
    }
    return undefined;
  }

  // Links seen on pages: following one is browsing, not building a URL from data.
  link(url: string): void {
    this.links.add(withoutFragment(url));
  }

  // What the user wrote may go anywhere.
  userSaid(text: string): void {
    this.user = normalize(text);
  }

  visited(host: string): boolean {
    return this.corpora.has(host);
  }

  // Text from a page on another host inside `value`, which is going to `targetHost`.
  leak(value: string, targetHost: string): Leak | undefined {
    const text = normalize(decode(value));
    if (text.length < WINDOW) return undefined;
    for (const [host, corpus] of this.corpora) {
      if (host === targetHost) continue;
      for (let i = 0; i + WINDOW <= text.length; i += STRIDE) {
        const window = text.slice(i, i + WINDOW);
        if (window.trim().length < WINDOW / 2 || this.user.includes(window)) continue;
        if (corpus.includes(window)) return { from: host, sample: window.trim() };
      }
    }
    return undefined;
  }

  // Why navigating to `url` would send data out, if it would.
  navigationLeak(url: string): string | undefined {
    if (this.links.has(withoutFragment(url))) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    const host = parsed.host;
    const parts = [
      ...parsed.pathname.split("/"),
      ...[...parsed.searchParams].flat(),
      parsed.hash.slice(1),
    ]
      .map(decode)
      .filter(Boolean);
    for (const part of parts) {
      for (const reading of readings(part)) {
        const found = this.leak(reading, host) ?? this.tokenLeak(reading, host);
        if (found) {
          const encoded = reading === part ? "" : " (encoded)";
          return `the URL carries text read on ${found.from}${encoded} ("${found.sample}…")`;
        }
      }
    }
    const found = this.leak(`${parsed.pathname} ${parsed.search} ${parsed.hash}`, host);
    if (found) return `the URL carries text read on ${found.from} ("${found.sample}…")`;
    const carried = parsed.search.length + parsed.hash.length;
    if (carried > LONG_DATA && !this.visited(host) && !this.user.includes(host.toLowerCase()))
      return `the URL sends ${carried} characters of data to ${host}, a site not visited in this session`;
    return undefined;
  }

  // Why typing `values` on the page at `pageUrl` would send data out, if it would.
  typingLeak(values: string[], pageUrl: string): string | undefined {
    const host = hostOf(pageUrl);
    for (const value of values) {
      const found = this.leak(value, host);
      if (found) return `the text includes content read on ${found.from} ("${found.sample}…")`;
    }
    return undefined;
  }
}
