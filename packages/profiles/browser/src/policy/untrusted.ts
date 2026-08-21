import type { BrowserDownload } from "../contracts/actions.ts";
import type { BrowserObservation } from "../contracts/observation.ts";

// BD11. Page text, accessibility names, frame content, filenames and downloaded
// content enter Mu only inside this wrapper. It is a class, not a string, so a value
// carrying page provenance cannot be passed where the policy layer expects a trusted
// string without an explicit unwrap that is visible at the call site — and it can
// never be the PolicyAuthority the widening functions demand.
export type UntrustedSource =
  | "page-text"
  | "accessible-name"
  | "frame-content"
  | "filename"
  | "download"
  | "tool-result";

export class UntrustedContent {
  readonly source: UntrustedSource;
  readonly text: string;
  readonly origin?: string | undefined;

  constructor(text: string, source: UntrustedSource, origin?: string) {
    this.source = source;
    this.text = text;
    this.origin = origin;
  }

  toString(): string {
    return renderUntrusted(this);
  }

  get [Symbol.toStringTag](): string {
    return "UntrustedContent";
  }
}

export function untrusted(
  text: string,
  source: UntrustedSource,
  origin?: string,
): UntrustedContent {
  return new UntrustedContent(text, source, origin);
}

export function isUntrusted(value: unknown): value is UntrustedContent {
  return value instanceof UntrustedContent;
}

const OPEN_TAG = /<(\/?)untrusted/gi;

/**
 * SECURITY §5: tool results are wrapped and tagged as untrusted observations. The
 * sentinel is neutralized inside the body so page text cannot close the wrapper early
 * and continue as if it were trusted narration.
 */
export function renderUntrusted(content: UntrustedContent): string {
  const body = content.text.replace(OPEN_TAG, (match) => match.replace("<", "&lt;"));
  const origin = content.origin === undefined ? "" : ` origin="${content.origin}"`;
  return `<untrusted source="${content.source}"${origin}>\n${body}\n</untrusted>`;
}

export class UntrustedValueError extends Error {
  constructor(what: string, source: UntrustedSource) {
    super(`${what} cannot come from ${source}; page-derived content never carries authority`);
    this.name = "UntrustedValueError";
  }
}

export function assertNotUntrusted(value: unknown, what: string): void {
  if (isUntrusted(value)) throw new UntrustedValueError(what, value.source);
}

export type InjectionKind =
  | "instruction-override"
  | "policy-change"
  | "origin-widening"
  | "safeguard-disable"
  | "takeover-suppression"
  | "commitment-coercion"
  | "secret-exfiltration"
  | "data-exfiltration"
  | "local-execution"
  | "software-install";

export interface InjectionFinding {
  kind: InjectionKind;
  evidence: string;
  source?: UntrustedSource | undefined;
  where?: string | undefined;
}

const PATTERNS: [InjectionKind, RegExp][] = [
  [
    "instruction-override",
    /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|original|user'?s?)\s+(?:instructions?|prompts?|rules?|task)/i,
  ],
  [
    "instruction-override",
    /\b(?:new|updated|revised)\s+(?:system\s+)?(?:instructions?|prompt)\b|\byou\s+are\s+now\s+(?:a|an|in)\b|\bsystem\s+prompt\b/i,
  ],
  [
    "policy-change",
    /\b(?:add|append|include|extend)\b[^.\n]{0,60}\b(?:allowed|permitted|trusted)\s+(?:origins?|domains?|sites?|hosts?)/i,
  ],
  [
    "policy-change",
    /\b(?:update|change|edit|modify|rewrite|set)\b[^.\n]{0,40}\b(?:permission|policy|policies|permissions|safety\s+rules?|allow\s*list|allowlist)\b/i,
  ],
  [
    "origin-widening",
    /\bthis\s+(?:site|domain|page|origin|host)\s+is\s+(?:trusted|safe|approved|whitelisted|allowlisted)\b|\byou\s+(?:are|have been)\s+authoriz\w+\s+to\s+(?:visit|navigate|browse)\b/i,
  ],
  [
    "safeguard-disable",
    /\b(?:disable|turn\s+off|bypass|circumvent|override|suppress)\b[^.\n]{0,40}\b(?:safeguard\w*|safety|check\w*|guard\w*|filter\w*|restriction\w*|confirmation\w*|approval\w*|policy)/i,
  ],
  [
    "safeguard-disable",
    /\b(?:without|no need to|don'?t|do not|skip)\s+(?:asking|ask|confirm\w*|approv\w*|permission|checking)/i,
  ],
  [
    "takeover-suppression",
    /\b(?:no|skip|without)\s+(?:human\s+)?(?:takeover|handoff|intervention)\b|\byou\s+(?:may|can|should)\s+(?:type|enter|fill)\s+(?:in\s+)?the\s+(?:password|passcode|otp|code|mfa)/i,
  ],
  [
    "takeover-suppression",
    /\b(?:solve|complete|bypass)\s+the\s+(?:captcha|recaptcha|hcaptcha|challenge)\b/i,
  ],
  [
    "commitment-coercion",
    /\b(?:just|simply|please)?\s*click\s+(?:the\s+)?(?:submit|buy|purchase|pay|delete|send|confirm|agree|accept)\b/i,
  ],
  [
    "commitment-coercion",
    /\b(?:submit|purchase|send|delete|order)\b[^.\n]{0,40}\b(?:automatically|without\s+(?:asking|confirmation|approval|review))/i,
  ],
  [
    "secret-exfiltration",
    /\b(?:reveal|show|print|share|send|report|disclose|paste|output|return)\b[^.\n]{0,50}\b(?:cookies?|session\s+tokens?|access\s+tokens?|api\s+keys?|credentials?|passwords?|authorization\s+header|local\s*storage|session\s*storage)\b/i,
  ],
  [
    "secret-exfiltration",
    /\bdocument\.cookie\b|\blocalStorage\.(?:getItem|[A-Za-z_])|\bBearer\s+[A-Za-z0-9._-]{10,}/i,
  ],
  [
    "data-exfiltration",
    /\b(?:upload|attach|send|email|post|transmit)\b[^.\n]{0,60}\b(?:resume|cv|passport|ssn|social\s+security|tax|bank|id\s+card|driver'?s\s+licen[cs]e|another\s+file|other\s+files?|all\s+(?:your|the)\s+files?)\b/i,
  ],
  [
    "data-exfiltration",
    /\b(?:list|enumerate|read)\b[^.\n]{0,40}\b(?:local\s+files?|your\s+files?|the\s+file\s*system|home\s+directory)\b/i,
  ],
  [
    "local-execution",
    /\b(?:run|execute|invoke)\b[^.\n]{0,40}\b(?:command|shell|terminal|script|bash|sh|zsh|powershell|cmd\.exe)\b|\b(?:curl|wget)\s+https?:\/\//i,
  ],
  [
    "software-install",
    /\b(?:install|download\s+and\s+run|npm\s+i(?:nstall)?|pip\s+install|apt(?:-get)?\s+install|brew\s+install)\b/i,
  ],
];

const MAX_EVIDENCE = 200;

function evidenceOf(text: string, match: RegExpMatchArray): string {
  const found = match[0] ?? "";
  const start = Math.max(0, (match.index ?? 0) - 20);
  const excerpt = text.slice(start, (match.index ?? 0) + found.length + 20).replace(/\s+/g, " ");
  return excerpt.length > MAX_EVIDENCE ? `${excerpt.slice(0, MAX_EVIDENCE)}…` : excerpt.trim();
}

// SECURITY §5: instructions found on a page are blocked and surfaced. This reports
// them; nothing downstream may act on the text either way, so a miss here weakens
// visibility, never the boundary itself.
export function detectInjection(value: UntrustedContent | string): InjectionFinding[] {
  const text = typeof value === "string" ? value : value.text;
  const source = typeof value === "string" ? undefined : value.source;
  const findings: InjectionFinding[] = [];
  const seen = new Set<InjectionKind>();
  for (const [kind, pattern] of PATTERNS) {
    const match = pattern.exec(text);
    if (match === null || seen.has(kind)) continue;
    seen.add(kind);
    findings.push({
      kind,
      evidence: evidenceOf(text, match),
      ...(source === undefined ? {} : { source }),
    });
  }
  return findings;
}

export function hasInjection(value: UntrustedContent | string): boolean {
  return detectInjection(value).length > 0;
}

function scan(
  findings: InjectionFinding[],
  text: string | undefined,
  source: UntrustedSource,
  where: string,
  origin?: string,
): void {
  if (text === undefined || text.length === 0) return;
  for (const finding of detectInjection(untrusted(text, source, origin))) {
    findings.push({ ...finding, where });
  }
}

/** Every field of an observation that a site controls is scanned, including frames. */
export function scanObservation(observation: BrowserObservation): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  const origin = observation.origin;
  scan(findings, observation.title, "page-text", "title", origin);
  scan(findings, observation.summary, "page-text", "summary", origin);
  scan(findings, observation.snapshot, "page-text", "snapshot", origin);
  for (const frame of observation.frames) {
    scan(findings, frame.name, "frame-content", `frame ${frame.id}`, frame.origin);
    scan(findings, frame.url, "frame-content", `frame ${frame.id} url`, frame.origin);
  }
  for (const element of observation.elements) {
    const where = `element ${element.ref}`;
    scan(findings, element.name, "accessible-name", where, origin);
    scan(findings, element.label, "accessible-name", where, origin);
    scan(findings, element.placeholder, "accessible-name", where, origin);
    scan(findings, element.description, "accessible-name", where, origin);
    for (const option of element.options ?? []) {
      scan(findings, option.label, "accessible-name", `${where} option`, origin);
    }
  }
  return findings;
}

/** SECURITY §7: a downloaded file's own name is untrusted content too. */
export function scanDownload(download: BrowserDownload): InjectionFinding[] {
  return detectInjection(untrusted(download.basename, "filename")).map((finding) => ({
    ...finding,
    where: "download basename",
  }));
}

export function describeInjection(findings: readonly InjectionFinding[]): string {
  if (findings.length === 0) return "no page-authored instructions detected";
  const kinds = [...new Set(findings.map((finding) => finding.kind))].join(", ");
  return `page content attempted to direct the agent (${kinds}); it was recorded as untrusted data and had no effect on policy`;
}
