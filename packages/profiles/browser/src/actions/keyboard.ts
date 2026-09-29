import type { CdpSession } from "../cdp/session.ts";
import type { Modifier } from "./pointer.ts";
import { modifierMask } from "./pointer.ts";

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, KeyDefinition> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};

const ALIASES: Record<string, string> = {
  return: "enter",
  esc: "escape",
  del: "delete",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  pgup: "pageup",
  pgdn: "pagedown",
  spacebar: "space",
};

const MODIFIER_NAMES: Record<string, Modifier | "Mod"> = {
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  win: "Meta",
  mod: "Mod",
  cmdorctrl: "Mod",
};

const MODIFIER_KEYS: Record<Modifier, KeyDefinition> = {
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
};

export interface KeyCombo {
  modifiers: Modifier[];
  key: KeyDefinition;
  label: string;
}

function characterKey(char: string): KeyDefinition {
  const upper = char.toUpperCase();
  if (/^[a-z]$/i.test(char)) {
    return { key: char, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: char };
  }
  if (/^[0-9]$/.test(char))
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char };
  return { key: char, code: "", keyCode: 0, text: char };
}

// "Mod+Shift+K", "ctrl+a", "Enter", "PageDown" → a normalized combo.
// `Mod` is Meta on macOS and Control elsewhere.
export function parseKeys(input: string, platform: NodeJS.Platform = process.platform): KeyCombo {
  const parts = input
    .trim()
    .split(/\s*\+\s*/)
    .filter((part) => part.length > 0);
  if (input.trim() === "+") parts.splice(0, parts.length, "+");
  if (parts.length === 0) throw new Error("press needs a key such as Enter or Mod+A");
  const modifiers: Modifier[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_NAMES[part.toLowerCase()];
    if (!modifier) throw new Error(`Unknown modifier "${part}" in "${input}"`);
    const resolved = modifier === "Mod" ? (platform === "darwin" ? "Meta" : "Control") : modifier;
    if (!modifiers.includes(resolved)) modifiers.push(resolved);
  }
  const last = parts.at(-1) as string;
  const lower = last.toLowerCase();
  let key: KeyDefinition | undefined = NAMED[ALIASES[lower] ?? lower];
  if (!key && /^f([1-9]|1[0-2])$/.test(lower)) {
    const number = Number(lower.slice(1));
    key = { key: `F${number}`, code: `F${number}`, keyCode: 111 + number };
  }
  if (!key && MODIFIER_NAMES[lower]) {
    const modifier = MODIFIER_NAMES[lower] as Modifier | "Mod";
    key =
      MODIFIER_KEYS[modifier === "Mod" ? (platform === "darwin" ? "Meta" : "Control") : modifier];
  }
  if (!key && [...last].length === 1) {
    const char = modifiers.includes("Shift") && /^[a-z]$/.test(last) ? last.toUpperCase() : last;
    key = characterKey(char);
  }
  if (!key) throw new Error(`Unknown key "${last}" in "${input}"`);
  const label = [...modifiers, key.key === " " ? "Space" : key.key].join("+");
  return { modifiers, key, label };
}

// macOS needs editing commands for shortcuts that native text fields handle.
function macCommands(combo: KeyCombo): string[] | undefined {
  if (!combo.modifiers.includes("Meta") || combo.modifiers.length !== 1) return undefined;
  const commands: Record<string, string> = {
    a: "selectAll",
    c: "copy",
    x: "cut",
    v: "paste",
    z: "undo",
  };
  const command = commands[combo.key.key.toLowerCase()];
  return command ? [command] : undefined;
}

export async function pressCombo(
  session: CdpSession,
  combo: KeyCombo,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const send = { signal, timeoutMs: 5_000 };
  const held: Modifier[] = [];
  for (const modifier of combo.modifiers) {
    held.push(modifier);
    const key = MODIFIER_KEYS[modifier];
    await session.send(
      "Input.dispatchKeyEvent",
      {
        type: "rawKeyDown",
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        modifiers: modifierMask(held),
      },
      send,
    );
  }
  const modifiers = modifierMask(combo.modifiers);
  const printable =
    combo.key.text !== undefined && !combo.modifiers.some((m) => m === "Control" || m === "Meta");
  const commands = platform === "darwin" ? macCommands(combo) : undefined;
  await session.send(
    "Input.dispatchKeyEvent",
    {
      type: printable ? "keyDown" : "rawKeyDown",
      key: combo.key.key,
      code: combo.key.code,
      windowsVirtualKeyCode: combo.key.keyCode,
      modifiers,
      ...(printable && combo.key.text
        ? { text: combo.key.text, unmodifiedText: combo.key.text }
        : {}),
      ...(commands ? { commands } : {}),
    },
    send,
  );
  await session.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      key: combo.key.key,
      code: combo.key.code,
      windowsVirtualKeyCode: combo.key.keyCode,
      modifiers,
    },
    send,
  );
  for (const modifier of [...held].reverse()) {
    held.pop();
    const key = MODIFIER_KEYS[modifier];
    await session.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        modifiers: modifierMask(held),
      },
      send,
    );
  }
}

// One key event pair per character, for fields that listen to key events.
export async function typeKeystrokes(
  session: CdpSession,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const char of text) {
    if (char === "\n") {
      await pressCombo(session, parseKeys("Enter"), signal);
      continue;
    }
    const key = characterKey(char);
    const send = { signal, timeoutMs: 5_000 };
    await session.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key: key.key,
        ...(key.code ? { code: key.code } : {}),
        windowsVirtualKeyCode: key.keyCode,
        text: char,
        unmodifiedText: char,
      },
      send,
    );
    await session.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: key.key,
        ...(key.code ? { code: key.code } : {}),
        windowsVirtualKeyCode: key.keyCode,
      },
      send,
    );
  }
}
