import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_RETENTION,
  type ArtifactEntry,
  type ArtifactKind,
  planRetention,
} from "./retention.ts";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function entries(count: number, bytes = 100): ArtifactEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `artifact-${index}.png`,
    bytes,
    createdAt: NOW - (count - index) * 1_000,
  }));
}

const LIMITS = { maxCount: 3, maxBytes: 1_000, maxAgeMs: DAY };

describe("retention planning", () => {
  test("nothing is evicted while every limit holds", () => {
    const plan = planRetention(entries(3), LIMITS, NOW);
    expect(plan.evict).toHaveLength(0);
    expect(plan.keep).toHaveLength(3);
  });

  test("the oldest go first when the count is exceeded", () => {
    const plan = planRetention(entries(6), LIMITS, NOW);
    expect(plan.keep.map((entry) => entry.name)).toEqual([
      "artifact-3.png",
      "artifact-4.png",
      "artifact-5.png",
    ]);
    expect(plan.evict.map((entry) => entry.name)).toEqual([
      "artifact-0.png",
      "artifact-1.png",
      "artifact-2.png",
    ]);
  });

  test("the byte budget evicts even when the count is fine", () => {
    const plan = planRetention(entries(3, 600), LIMITS, NOW);
    expect(plan.keep).toHaveLength(1);
    expect(plan.evict).toHaveLength(2);
    expect(plan.keep.reduce((total, entry) => total + entry.bytes, 0)).toBeLessThanOrEqual(
      LIMITS.maxBytes,
    );
  });

  test("age expires an artifact no matter how few there are", () => {
    const stale: ArtifactEntry[] = [
      { name: "old.png", bytes: 10, createdAt: NOW - 3 * DAY },
      { name: "fresh.png", bytes: 10, createdAt: NOW - 60_000 },
    ];
    const plan = planRetention(stale, LIMITS, NOW);
    expect(plan.evict.map((entry) => entry.name)).toEqual(["old.png"]);
  });

  test("age expires the newest artifact too", () => {
    const plan = planRetention(
      [{ name: "only.png", bytes: 10, createdAt: NOW - 5 * DAY }],
      LIMITS,
      NOW,
    );
    expect(plan.keep).toHaveLength(0);
    expect(plan.evict).toHaveLength(1);
  });

  test("the newest artifact is never evicted for count or size", () => {
    const plan = planRetention(
      [
        { name: "old.png", bytes: 10, createdAt: NOW - 2_000 },
        { name: "huge.png", bytes: 10_000, createdAt: NOW - 1_000 },
      ],
      LIMITS,
      NOW,
    );
    expect(plan.keep.map((entry) => entry.name)).toEqual(["huge.png"]);
  });

  test("an empty directory plans nothing", () => {
    const plan = planRetention([], LIMITS, NOW);
    expect(plan.keep).toHaveLength(0);
    expect(plan.evict).toHaveLength(0);
  });

  test("every artifact kind is bounded in all three dimensions", () => {
    const kinds: ArtifactKind[] = ["screenshot", "observation", "download", "log", "receipt"];
    for (const kind of kinds) {
      const limits = ARTIFACT_RETENTION[kind];
      expect(limits.maxCount).toBeGreaterThan(0);
      expect(limits.maxBytes).toBeGreaterThan(0);
      expect(limits.maxAgeMs).toBeGreaterThan(0);
      expect(Number.isFinite(limits.maxCount + limits.maxBytes + limits.maxAgeMs)).toBe(true);
    }
  });

  test("receipts outlive the noisier artifacts", () => {
    expect(ARTIFACT_RETENTION.receipt.maxAgeMs).toBeGreaterThan(
      ARTIFACT_RETENTION.screenshot.maxAgeMs,
    );
  });
});
