import { describe, expect, test } from "bun:test";
import { formatKeybindings, KEYBINDING_GROUPS } from "./keybindings.ts";

describe("KEYBINDING_GROUPS", () => {
  test("every binding documented in app.ts's key handling is present", () => {
    const all = KEYBINDING_GROUPS.flatMap((group) => group.bindings.map((b) => b.keys));
    // Global, always-on shortcuts.
    for (const key of ["ctrl+c", "ctrl+o", "ctrl+t", "ctrl+j"]) {
      expect(all).toContain(key);
    }
    // The two universal newline paths, and the protocol-dependent one.
    expect(all.some((k) => k.includes("shift+enter"))).toBe(true);
    expect(all.some((k) => k.includes("\\ then enter"))).toBe(true);
    // Composer mode-entry characters.
    expect(all.some((k) => k.includes("/"))).toBe(true);
    expect(all).toContain("@");
    expect(all.some((k) => k.startsWith("!"))).toBe(true);
  });

  test("no group is empty and every binding has a non-empty description", () => {
    expect(KEYBINDING_GROUPS.length).toBeGreaterThan(0);
    for (const group of KEYBINDING_GROUPS) {
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.bindings.length).toBeGreaterThan(0);
      for (const binding of group.bindings) {
        expect(binding.keys.length).toBeGreaterThan(0);
        expect(binding.description.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("formatKeybindings", () => {
  test("renders a heading, every group title, and every binding's keys", () => {
    const text = formatKeybindings();
    expect(text.startsWith("Keybindings")).toBe(true);
    for (const group of KEYBINDING_GROUPS) {
      expect(text).toContain(group.title);
      for (const binding of group.bindings) {
        expect(text).toContain(binding.keys);
        expect(text).toContain(binding.description);
      }
    }
  });

  test("groups are separated by a blank line", () => {
    const text = formatKeybindings();
    expect(text).toContain("\n\n");
  });
});
