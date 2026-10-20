import { describe, expect, test } from "bun:test";
import { CitationMarkupFilter, stripCitationMarkup } from "./citation-markup.ts";

// The exact text a live Codex session produced.
const raw =
  "default to Mercury 3. \ue200cite\ue202turn0view0\ue202turn0view2\ue201 I’m also checking reasoning controls.";
const clean = "default to Mercury 3. I’m also checking reasoning controls.";

describe("citation markup", () => {
  test("is removed with the doubled space, however the deltas split it", () => {
    expect(stripCitationMarkup(raw)).toBe(clean);
    for (let split = 0; split <= raw.length; split++) {
      for (let second = split; second <= raw.length; second += 7) {
        const filter = new CitationMarkupFilter();
        const out =
          filter.push(raw.slice(0, split)) +
          filter.push(raw.slice(split, second)) +
          filter.push(raw.slice(second)) +
          filter.flush();
        expect(out).toBe(clean);
      }
    }
  });

  test("text that only resembles markup is kept", () => {
    expect(stripCitationMarkup("icons \ue200 and \ue201 stay")).toBe(
      "icons \ue200 and \ue201 stay",
    );
    expect(stripCitationMarkup("\ue200Not A Name\ue201")).toBe("\ue200Not A Name\ue201");
    const long = `\ue200cite${"x".repeat(2_000)}`;
    expect(stripCitationMarkup(long)).toBe(long);
  });

  test("a lone marker is ordinary text: never held back or dropped with what follows", () => {
    const icon = "\ue200";
    const reply = `Build ${icon} passed, and the rest of the reply follows without any end marker.`;
    const filter = new CitationMarkupFilter();
    expect(filter.push(reply)).toBe(reply);
    expect(filter.flush()).toBe("");

    expect(stripCitationMarkup(`Done ${icon}`)).toBe(`Done ${icon}`);
    expect(stripCitationMarkup(`${icon} ok \ue200cite\ue202turn0view0\ue201 next`)).toBe(
      `${icon} ok next`,
    );

    const split = new CitationMarkupFilter();
    expect(split.push(`Status ${icon}`)).toBe("Status ");
    expect(split.push(" green")).toBe(`${icon} green`);
    expect(split.flush()).toBe("");
  });

  test("a span at the start or the end leaves no stray space, and an unclosed one is dropped", () => {
    expect(stripCitationMarkup("\ue200cite\ue202a\ue201 Start.")).toBe("Start.");
    expect(stripCitationMarkup("End.\ue200cite\ue202a\ue201")).toBe("End.");
    expect(stripCitationMarkup("End. \ue200cite\ue202turn0")).toBe("End. ");
  });

  test("offsets into the raw text map onto the filtered text", () => {
    const filter = new CitationMarkupFilter();
    expect(filter.push(raw) + filter.flush()).toBe(clean);
    const after = raw.indexOf("I’m");
    expect(filter.mapIndex(after)).toBe(clean.indexOf("I’m"));
    // Inside the removed span: where the span was.
    expect(filter.mapIndex(raw.indexOf("\ue200") + 3)).toBe(clean.indexOf("I’m"));
    expect(filter.mapIndex(0)).toBe(0);
  });
});
