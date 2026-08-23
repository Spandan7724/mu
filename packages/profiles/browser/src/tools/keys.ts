// Key names, normalized once so a model does not have to guess a browser's casing.
//
// The bridge takes Playwright's spelling and rejects anything else outright, so a
// model that reasonably writes "END", "page down" or "ctrl+a" loses a turn to an
// error that tells it nothing it could have known. A single character is passed
// through untouched, because there case is the whole meaning: "A" is not "a".

const NAMED_KEYS = [
  "Backquote",
  "Minus",
  "Equal",
  "Backslash",
  "Backspace",
  "Tab",
  "Delete",
  "Escape",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Enter",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "Space",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "ContextMenu",
  "NumLock",
  "Pause",
  "PrintScreen",
  "ScrollLock",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
] as const;

const ALIASES: Record<string, string> = {
  esc: "Escape",
  return: "Enter",
  del: "Delete",
  ins: "Insert",
  ctrl: "Control",
  cmd: "Meta",
  command: "Meta",
  option: "Alt",
  win: "Meta",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  pgup: "PageUp",
  pgdn: "PageDown",
  spacebar: "Space",
};

const CANONICAL = new Map<string, string>([
  ...NAMED_KEYS.map((key) => [key.toLowerCase(), key] as const),
  ...Object.entries(ALIASES).map(([alias, key]) => [alias, key] as const),
]);

/** Every accepted name, for a tool description and for an error worth reading. */
export const KEY_NAMES: readonly string[] = NAMED_KEYS;

export interface KeyNormalization {
  ok: boolean;
  key: string;
  message?: string;
}

function normalizePart(part: string): string | undefined {
  const trimmed = part.trim();
  if (trimmed.length === 0) return undefined;
  // One character is a literal keystroke, and its case is significant.
  if ([...trimmed].length === 1) return trimmed;
  return CANONICAL.get(trimmed.toLowerCase().replace(/[ _-]/g, ""));
}

export function normalizeKey(key: string): KeyNormalization {
  const parts = key.split("+");
  const normalized: string[] = [];
  for (const part of parts) {
    const canonical = normalizePart(part);
    if (canonical === undefined) {
      return {
        ok: false,
        key,
        message: `"${key}" is not a key this browser recognizes. Use one of: ${KEY_NAMES.join(", ")}, a single character, or a combination such as Control+a.`,
      };
    }
    normalized.push(canonical);
  }
  return { ok: true, key: normalized.join("+") };
}
