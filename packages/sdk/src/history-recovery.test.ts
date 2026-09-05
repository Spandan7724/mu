import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "./file-store.ts";
import { historyScenario } from "./testing/history-scenario.ts";

describe("evidence recovery through the real loop", () => {
  test("compaction makes a non-reproducible observation unavailable without retrieval", async () => {
    const result = await historyScenario(false);
    expect(result.evidenceHiddenAfterCompaction).toBe(true);
    expect(result.summarizerSawAnswer).toBe(true);
    expect(result.recovered).toBe(false);
    expect(result.sourceReruns).toBe(1);
  });

  test("retrieval recovers the exact observation after compaction and on-disk resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-history-recovery-"));
    try {
      const result = await historyScenario(true, new FileSessionStore({ root }));
      expect(result.evidenceHiddenAfterCompaction).toBe(true);
      expect(result.summarizerSawAnswer).toBe(true);
      expect(result.recovered).toBe(true);
      expect(result.sourceReruns).toBe(0);
      expect(result.recoveryModelCalls).toBe(3);
      expect(result.retrievalChars).toBeLessThan(6_000);
      expect(result.compactedTokens).toBeLessThan(result.beforeTokens / 10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
