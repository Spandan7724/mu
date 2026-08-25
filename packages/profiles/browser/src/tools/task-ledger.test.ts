import { describe, expect, test } from "bun:test";
import { BrowserTaskLedger } from "./task-ledger.ts";

describe("browser task ledger", () => {
  test("ordered results require document-order evidence and the requested count", () => {
    const ledger = new BrowserTaskLedger();
    ledger.begin("user-task-1");
    ledger.plan(
      [
        {
          id: "newest-models",
          description: "Identify the ten newest models in listed order",
          kind: "ordered-list",
          requiredCount: 10,
        },
      ],
      ["Open the directory", "Select newest", "Read ten model cards"],
    );
    ledger.record({
      id: "focused",
      kind: "observation",
      order: "relevance",
      range: { start: 0, end: 120, total: 400 },
      hasMore: true,
      sourceIncomplete: false,
    });
    ledger.attach("newest-models", "focused", 10);
    expect(ledger.state().status).toBe("active");

    ledger.record({
      id: "ordered",
      kind: "observation",
      order: "document",
      range: { start: 0, end: 120, total: 400 },
      hasMore: true,
      sourceIncomplete: false,
    });
    ledger.attach("newest-models", "ordered", 9);
    expect(ledger.state().status).toBe("active");
    ledger.attach("newest-models", "ordered", 10);
    expect(ledger.state().status).toBe("satisfied");
  });

  test("exhaustive work remains incomplete while source continuation exists", () => {
    const ledger = new BrowserTaskLedger();
    ledger.begin("user-task-2");
    ledger.plan(
      [{ id: "all-results", description: "Inspect every result", kind: "exhaustive" }],
      ["Traverse every semantic window"],
    );
    ledger.record({
      id: "partial",
      kind: "observation",
      order: "document",
      range: { start: 0, end: 100, total: 200 },
      hasMore: true,
      sourceIncomplete: false,
    });
    ledger.attach("all-results", "partial");
    expect(ledger.state().status).toBe("active");

    ledger.record({
      id: "last-window",
      kind: "observation",
      order: "document",
      range: { start: 100, end: 200, total: 200 },
      hasMore: false,
      sourceIncomplete: false,
    });
    ledger.attach("all-results", "last-window");
    expect(ledger.state().status).toBe("satisfied");
  });

  test("an exhaustive final window cannot hide a coverage gap", () => {
    const ledger = new BrowserTaskLedger();
    ledger.begin("user-task-gap");
    ledger.plan(
      [{ id: "all-results", description: "Inspect every result", kind: "exhaustive" }],
      ["Traverse every semantic window"],
    );
    ledger.record({
      id: "last-window",
      kind: "observation",
      order: "document",
      range: { start: 100, end: 200, total: 200 },
      hasMore: false,
      sourceIncomplete: false,
    });
    ledger.attach("all-results", "last-window");
    expect(ledger.state().status).toBe("active");
  });

  test("exhaustive virtualized work requires contiguous viewport coverage", () => {
    const ledger = new BrowserTaskLedger();
    ledger.begin("virtual-list");
    ledger.plan(
      [{ id: "all-results", description: "Inspect every rendered result", kind: "exhaustive" }],
      ["Traverse each viewport"],
    );
    for (const [id, start, end, incomplete] of [
      ["top", 0, 700, true],
      ["middle", 700, 1_400, true],
      ["bottom", 1_400, 2_000, false],
    ] as const) {
      ledger.record({
        id,
        kind: "observation",
        order: "document",
        range: { start: 0, end: 20, total: 20 },
        viewportRange: { start, end, total: 2_000 },
        hasMore: incomplete,
        sourceIncomplete: incomplete,
      });
      ledger.attach("all-results", id);
    }
    expect(ledger.state().status).toBe("satisfied");

    const skipped = new BrowserTaskLedger();
    skipped.begin("virtual-list-gap");
    skipped.plan(
      [{ id: "all-results", description: "Inspect every rendered result", kind: "exhaustive" }],
      ["Traverse each viewport"],
    );
    for (const [id, start, end, incomplete] of [
      ["top", 0, 700, true],
      ["bottom", 1_400, 2_000, false],
    ] as const) {
      skipped.record({
        id,
        kind: "observation",
        order: "document",
        range: { start: 0, end: 20, total: 20 },
        viewportRange: { start, end, total: 2_000 },
        hasMore: incomplete,
        sourceIncomplete: incomplete,
      });
      skipped.attach("all-results", id);
    }
    expect(skipped.state().status).toBe("active");
  });

  test("fabricated evidence and model-assigned completion are impossible", () => {
    const ledger = new BrowserTaskLedger();
    ledger.begin("user-task-3");
    ledger.plan([{ id: "claim", description: "Verify the claim", kind: "fact" }], ["Read it"]);
    expect(() => ledger.attach("claim", "invented-evidence")).toThrow("unknown or expired");
    expect(ledger.state().criteria[0]?.satisfied).toBe(false);
  });

  test("finish review is bounded and names unmet criteria", () => {
    const ledger = new BrowserTaskLedger();
    ledger.begin("user-task-4");
    ledger.plan([{ id: "claim", description: "Verify the claim", kind: "fact" }], ["Read it"]);
    expect(ledger.finishReminder()).toContain("claim: Verify the claim");
    expect(ledger.finishReminder()).toBeUndefined();
  });

  test("snapshot restores evidence, attachments, and review state", () => {
    const original = new BrowserTaskLedger();
    original.begin("user-task-restart");
    original.plan([{ id: "claim", description: "Verify it", kind: "fact" }], ["Read it"]);
    original.record({ id: "seen", kind: "observation", url: "https://example.test" });
    original.attach("claim", "seen");

    const restored = new BrowserTaskLedger();
    expect(restored.restore(JSON.parse(JSON.stringify(original.snapshot())))).toBe(true);
    expect(restored.snapshot()).toEqual(original.snapshot());
    expect(restored.state().status).toBe("satisfied");
  });

  test("restore rejects corrupt or oversized state without changing the ledger", () => {
    const ledger = new BrowserTaskLedger();
    ledger.begin("current");
    const before = ledger.snapshot();
    expect(ledger.restore({ ...before, version: 2 })).toBe(false);
    expect(ledger.restore({ ...before, steps: ["x".repeat(4_097)] })).toBe(false);
    expect(ledger.snapshot()).toEqual(before);
  });
});
