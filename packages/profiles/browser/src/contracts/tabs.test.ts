import { describe, expect, test } from "bun:test";
import { sampleTab } from "../testing/samples.ts";
import { attachedTabs, browserTabSchema, tabOutcomeSchema, tabRequestSchema } from "./tabs.ts";

const outcome = {
  ok: true,
  tabs: [sampleTab(), sampleTab({ id: "tab-2", active: false })],
  activeTabId: "tab-1",
  message: "2 tabs",
};

describe("tab request", () => {
  test("select and close name a tab; open may name a URL", () => {
    expect(tabRequestSchema.safeParse({ kind: "list" }).success).toBe(true);
    expect(tabRequestSchema.safeParse({ kind: "select", tabId: "tab-1" }).success).toBe(true);
    expect(tabRequestSchema.safeParse({ kind: "select" }).success).toBe(false);
    expect(tabRequestSchema.safeParse({ kind: "open" }).success).toBe(true);
    expect(tabRequestSchema.safeParse({ kind: "open", url: "file:///etc/passwd" }).success).toBe(
      false,
    );
  });
});

describe("tab outcome", () => {
  test("accepts a consistent listing", () => {
    expect(tabOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  test("at most one tab may be active", () => {
    const both = { ...outcome, tabs: [sampleTab(), sampleTab({ id: "tab-2" })] };
    expect(tabOutcomeSchema.safeParse(both).success).toBe(false);
  });

  test("activeTabId must name a listed tab", () => {
    expect(tabOutcomeSchema.safeParse({ ...outcome, activeTabId: "tab-9" }).success).toBe(false);
  });

  test("activeTabId must agree with the tab flagged active", () => {
    expect(tabOutcomeSchema.safeParse({ ...outcome, activeTabId: "tab-2" }).success).toBe(false);
  });

  test("two tabs may not share an id", () => {
    const duplicated = { ...outcome, tabs: [sampleTab(), sampleTab({ active: false })] };
    expect(tabOutcomeSchema.safeParse(duplicated).success).toBe(false);
  });

  test("a tab url is bounded and a tab origin is normalized", () => {
    expect(
      browserTabSchema.safeParse(sampleTab({ origin: "https://jobs.example.com/apply" })).success,
    ).toBe(false);
    expect(browserTabSchema.safeParse(sampleTab({ url: "x".repeat(5_000) })).success).toBe(false);
  });

  test("attached tabs are the ones the driver actually controls", () => {
    const tabs = [sampleTab(), sampleTab({ id: "tab-2", active: false, attached: false })];
    expect(attachedTabs(tabs).map((tab) => tab.id)).toEqual(["tab-1"]);
  });
});
