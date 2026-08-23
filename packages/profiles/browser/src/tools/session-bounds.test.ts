// B8: the audit trail is the tool session's own long-session bound (alongside the
// runtime journal in ../runtime/journal-bounds.test.ts). It carries no commitment
// state of its own — the ledger that must never forget an unreconciled commitment is
// `artifacts/commitment.ts`, covered there — so a plain FIFO bound is the correct and
// sufficient property to prove here: it stops growing, and it drops the oldest entry.
import { describe, expect, test } from "bun:test";
import { createHarness } from "./harness.ts";

describe("the audit trail stays bounded across a long session", () => {
  test("recording far past the cap never grows it further, and the oldest entries are dropped first", async () => {
    const harness = createHarness();
    try {
      for (let i = 0; i < 260; i++) {
        harness.session.note({
          tool: "browser_act",
          action: `step-${i}`,
          outcome: "completed",
        });
      }
      expect(harness.session.audit.length).toBe(200);
      expect(harness.session.audit[0]?.action).toBe("step-60");
      expect(harness.session.audit.at(-1)?.action).toBe("step-259");
      // Order is preserved within the retained window — nothing was reshuffled.
      const actions = harness.session.audit.map((entry) => entry.action);
      for (let i = 1; i < actions.length; i++) {
        const previous = Number((actions[i - 1] as string).split("-")[1]);
        const current = Number((actions[i] as string).split("-")[1]);
        expect(current).toBe(previous + 1);
      }
    } finally {
      await harness.shutdown();
    }
  });
});
