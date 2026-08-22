// The fixtures below are verbatim `@playwright/mcp` 0.0.79 responses captured from
// a live Chrome 151 session against the loopback fixture. They are what keeps the
// parser honest when no browser is present.
import { describe, expect, test } from "bun:test";
import { parseSidecarResponse, parseTabList } from "./response.ts";
import { parseSnapshot, structuralSignature } from "./snapshot.ts";

const SNAPSHOT_RESPONSE = [
  "### Page",
  "- Page URL: http://127.0.0.1:45775/fields/all",
  "- Page Title: Every field type",
  "- Console: 1 errors, 0 warnings",
  "### Snapshot",
  "```yaml",
  "- generic [ref=e1]:",
  '  - heading "Every field type" [level=1] [ref=e2]',
  "  - paragraph [ref=e3]: One control of every type this product claims to drive.",
  "  - generic [ref=e4]:",
  "    - generic [ref=e5]: Plain text",
  '    - textbox "Plain text" [ref=e6]: Ada Lovelace',
  '    - generic [ref=e17]: Password',
  '    - textbox "Password" [ref=e18]',
  '    - combobox "Size" [ref=e22]:',
  '      - option "Select a size"',
  '      - option "Small"',
  '      - option "Medium" [selected]',
  '    - checkbox "Send me updates" [checked] [active] [ref=e37]',
  "    - text: Send me updates",
  '    - switch "Enable notifications" [ref=e47]: "Off"',
  '    - button "Save answers" [ref=e50]',
  "```",
].join("\n");

const NAVIGATE_RESPONSE = [
  "### Ran Playwright code",
  "```js",
  "await page.goto('http://127.0.0.1:45775/fields/all');",
  "```",
  "### Page",
  "- Page URL: http://127.0.0.1:45775/fields/all",
  "- Page Title: Every field type",
  "- Console: 1 errors, 0 warnings",
  "### Snapshot",
  "- [Snapshot](C:\\Users\\Spandan\\AppData\\Local\\Temp\\mu-out\\page-2026-08-22T08-04-54-179Z.yml)",
  "### Events",
  "- New console entries: .playwright-mcp\\console-2026-08-22T08-04-54-179Z.log#L1-L2",
].join("\n");

describe("sidecar response parsing", () => {
  test("reads the page identity and the inline snapshot, and nothing else", () => {
    const response = parseSidecarResponse(SNAPSHOT_RESPONSE);
    expect(response.url).toBe("http://127.0.0.1:45775/fields/all");
    expect(response.title).toBe("Every field type");
    expect(response.snapshot).toContain('textbox "Plain text"');
    expect(response.savedPaths).toEqual([]);
  });

  test("a saved-snapshot link is recognised as a path and never becomes the snapshot", () => {
    const response = parseSidecarResponse(NAVIGATE_RESPONSE);
    expect(response.snapshot).toBeUndefined();
    expect(response.savedPaths.length).toBeGreaterThan(0);
    expect(response.url).toBe("http://127.0.0.1:45775/fields/all");
  });

  test("the generated Playwright source is never carried forward", () => {
    const response = parseSidecarResponse(NAVIGATE_RESPONSE);
    expect(response.result).toBeUndefined();
    expect(response.snapshot ?? "").not.toContain("page.goto");
  });

  test("a download event is read as a bare basename", () => {
    const response = parseSidecarResponse(
      ["### Events", "- Downloaded file offer.pdf to /tmp/out/offer.pdf"].join("\n"),
    );
    expect(response.downloads).toEqual(["offer.pdf"]);
  });

  test("tab lists are read positionally with the current tab flagged", () => {
    const tabs = parseTabList(
      [
        "### Result",
        "- 0: (current) [Every field type](http://127.0.0.1:45775/fields/all)",
        "- 1: [Popup window](http://127.0.0.1:45775/dialogs/popup)",
      ].join("\n"),
    );
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toMatchObject({ index: 0, current: true, title: "Every field type" });
    expect(tabs[1]).toMatchObject({ index: 1, current: false });
  });
});

describe("accessibility snapshot parsing", () => {
  const nodes = parseSnapshot(parseSidecarResponse(SNAPSHOT_RESPONSE).snapshot ?? "");
  const byRef = (ref: string) => nodes.find((node) => node.ref === ref);

  test("roles, names, refs and values survive the round trip", () => {
    expect(byRef("e6")).toMatchObject({
      role: "textbox",
      name: "Plain text",
      value: "Ada Lovelace",
    });
    expect(byRef("e18")).toMatchObject({ role: "textbox", name: "Password" });
    expect(byRef("e18")?.value).toBeUndefined();
    expect(byRef("e2")?.attributes.level).toBe("1");
  });

  test("state flags are read as flags", () => {
    expect(byRef("e37")?.attributes.checked).toBe(true);
    expect(byRef("e37")?.attributes.active).toBe(true);
    expect(byRef("e50")?.attributes.checked).toBeUndefined();
  });

  test("options belong to their control and are not free-standing elements", () => {
    expect(byRef("e22")?.options).toEqual([
      { label: "Select a size", selected: false },
      { label: "Small", selected: false },
      { label: "Medium", selected: true },
    ]);
    expect(nodes.filter((node) => node.role === "option" && node.ref !== undefined)).toEqual([]);
  });

  test("a quoted trailing value is unquoted", () => {
    expect(byRef("e47")?.value).toBe("Off");
  });

  test("frame-prefixed refs carry their frame", () => {
    const framed = parseSnapshot(['- iframe [ref=e5]:', '  - textbox "Name" [ref=f1e2]'].join("\n"));
    expect(framed.find((node) => node.ref === "f1e2")?.framePrefix).toBe("f1");
    expect(framed.find((node) => node.ref === "e5")?.framePrefix).toBeUndefined();
  });

  test("the structural signature ignores values but not structure", () => {
    const before = structuralSignature(nodes);
    const filled = parseSnapshot(
      (parseSidecarResponse(SNAPSHOT_RESPONSE).snapshot ?? "").replace(
        "Ada Lovelace",
        "Grace Hopper",
      ),
    );
    expect(structuralSignature(filled)).toBe(before);
    const relabelled = parseSnapshot(
      (parseSidecarResponse(SNAPSHOT_RESPONSE).snapshot ?? "").replace(
        "Save answers",
        "Send to employer",
      ),
    );
    expect(structuralSignature(relabelled)).not.toBe(before);
  });
});
