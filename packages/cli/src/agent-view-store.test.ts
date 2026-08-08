import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedSessionRecord } from "./agent-view-state.ts";
import {
  AgentViewRosterStore,
  acquireSessionOwnership,
  agentViewPaths,
  ownershipPath,
  releaseSessionOwnership,
} from "./agent-view-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "mu-agents-test-"));
  roots.push(value);
  return value;
}

describe("agent-view persistence", () => {
  test("roster writes are private, validated, and round-trip ordinary session ids", async () => {
    const paths = agentViewPaths(await root());
    const store = new AgentViewRosterStore(paths);
    const record = createManagedSessionRecord({
      sessionId: "session/with punctuation",
      scope: "scope",
      prompt: "do work",
      cwd: "/work",
      profile: "coding",
    });
    await store.save([record]);
    expect(await store.load()).toEqual([record]);
    if (process.platform !== "win32") {
      expect((await stat(paths.roster)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
    }
  });

  test("live ownership conflicts and token-checked release cannot unlock another owner", async () => {
    const paths = agentViewPaths(await root());
    const owner = await acquireSessionOwnership(paths, "s1");
    await expect(acquireSessionOwnership(paths, "s1")).rejects.toThrow("already owned");
    expect(
      await releaseSessionOwnership(paths, { sessionId: "s1", token: crypto.randomUUID() }),
    ).toBe(false);
    expect(await releaseSessionOwnership(paths, owner)).toBe(true);
  });

  test("stale ownership requires explicit recovery", async () => {
    const paths = agentViewPaths(await root());
    const owner = await acquireSessionOwnership(paths, "s1");
    const path = ownershipPath(paths, "s1");
    const data = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, `${JSON.stringify({ ...data, supervisorPid: 2_147_483_647 })}\n`);
    await expect(acquireSessionOwnership(paths, "s1")).rejects.toThrow("stale ownership");
    const recovered = await acquireSessionOwnership(paths, "s1", { recoverStale: true });
    expect(recovered.token).not.toBe(owner.token);
  });

  test("simultaneous ownership acquisition has exactly one winner", async () => {
    const paths = agentViewPaths(await root());
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireSessionOwnership(paths, "raced-session")),
    );
    const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
    expect(winners).toHaveLength(1);
    if (winners[0]?.status === "fulfilled") {
      expect(await releaseSessionOwnership(paths, winners[0].value)).toBe(true);
    }
  });
});
