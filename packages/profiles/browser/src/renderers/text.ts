// Line primitives for every browser surface, plus the gate that stands between a
// rendered line and the screen. STYLES.md: lowercase chrome, `·` separators, no
// boxes, units on numbers. Profile renderers emit plain strings — the terminal owns
// colour — so every state here is carried by a word, never by a hue (DESIGN
// §Accessibility).
import { containsAnyValue, redactText } from "../artifacts/redaction.ts";
import { isCredentialLabel } from "../contracts/redaction.ts";
import { REDACTED } from "../contracts/secret.ts";

export const SEPARATOR = " · ";

/** A rendered surface is read at a glance; past this it stops being one. */
export const RENDER_LIMITS = {
  maxLineChars: 400,
  maxListItems: 8,
  maxWarnings: 5,
  maxCellLines: 24,
} as const;

export class RenderRedactionError extends Error {
  constructor(what: string) {
    super(`${what} still contains a value that must never be rendered`);
    this.name = "RenderRedactionError";
  }
}

export function joinParts(parts: readonly (string | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .map((part) => part.trim())
    .join(SEPARATOR);
}

/**
 * Collapses the control characters a page can smuggle into an accessible name.
 * A newline inside a label would otherwise forge an extra row in a card, and an
 * escape sequence would reach the terminal as chrome the profile never wrote.
 */
export function flatten(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

export function clampLine(value: string, max = RENDER_LIMITS.maxLineChars): string {
  const flat = flatten(value);
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

/** `… +N more` rather than a silent truncation (STYLES.md: truncation is honest). */
export function boundedList(
  values: readonly string[],
  max = RENDER_LIMITS.maxListItems,
): string[] {
  if (values.length <= max) return values.map((value) => clampLine(value));
  const shown = values.slice(0, max).map((value) => clampLine(value));
  return [...shown, `… +${values.length - max} more`];
}

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** SECURITY §11: a sha256 identifies a file in a preview; the whole digest is noise. */
export function shaPrefix(sha256: string): string {
  return sha256.slice(0, 12);
}

/**
 * A field whose name is credential-shaped is not rendered at all — not its value,
 * not the name. The name alone would say the agent touched a takeover boundary it
 * should never have reached (SECURITY §8).
 */
export function isRenderableFieldName(name: string): boolean {
  return !isCredentialLabel(name);
}

export function partitionRenderableFields(names: readonly string[]): {
  renderable: string[];
  suppressed: number;
} {
  const renderable: string[] = [];
  let suppressed = 0;
  for (const name of names) {
    if (isRenderableFieldName(name)) renderable.push(name);
    else suppressed += 1;
  }
  return { renderable, suppressed };
}

/**
 * The single exit through which every browser line reaches a user. It scrubs the
 * caller's own restricted values and then the generic secret shapes — a token, a
 * cookie, a bearer header, a card number — whichever tool result or page produced
 * the string.
 */
export function redactLines(lines: readonly string[], values: readonly string[] = []): string[] {
  return lines.map((line) => clampLine(redactText(line, values)));
}

/**
 * Last line of defence, mirroring buildReceipt: rendering a value that must stay
 * hidden is the leak the redaction exists to prevent, so it fails loudly rather
 * than shipping the line.
 */
export function assertNoSecretInLines(
  lines: readonly string[],
  values: readonly string[],
  what: string,
): void {
  if (values.length > 0 && containsAnyValue(lines.join("\n"), values)) {
    throw new RenderRedactionError(what);
  }
}

export function safeLines(
  lines: readonly string[],
  values: readonly string[],
  what: string,
): string[] {
  const redacted = redactLines(lines, values);
  assertNoSecretInLines(redacted, values, what);
  return redacted;
}

export { REDACTED };
