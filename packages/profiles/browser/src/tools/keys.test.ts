import { describe, expect, test } from "bun:test";
import { normalizeKey } from "./keys.ts";

describe("a key name is normalized before it reaches the browser", () => {
  // The live failure this exists for: the model pressed END and lost a turn to
  // `Unknown key: "END"`, which told it nothing it could have acted on.
  test("casing a model reasonably chooses is accepted", () => {
    for (const [written, expected] of [
      ["END", "End"],
      ["end", "End"],
      ["PAGEDOWN", "PageDown"],
      ["page down", "PageDown"],
      ["page_down", "PageDown"],
      ["ArrowDown", "ArrowDown"],
    ] as const) {
      expect({ written, key: normalizeKey(written).key }).toEqual({ written, key: expected });
    }
  });

  test("the names people actually use are aliases, not errors", () => {
    expect(normalizeKey("esc").key).toBe("Escape");
    expect(normalizeKey("return").key).toBe("Enter");
    expect(normalizeKey("ctrl+a").key).toBe("Control+a");
    expect(normalizeKey("cmd+Shift+p").key).toBe("Meta+Shift+p");
  });

  // A single character is the one place case is the whole meaning.
  test("a literal character keeps its case", () => {
    expect(normalizeKey("A").key).toBe("A");
    expect(normalizeKey("a").key).toBe("a");
  });

  test("something genuinely unrecognized is refused with the vocabulary", () => {
    const result = normalizeKey("Frobnicate");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("PageDown");
  });
});
