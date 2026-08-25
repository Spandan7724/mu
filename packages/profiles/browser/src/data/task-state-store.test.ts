import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BrowserTaskLedger } from "../tools/task-ledger.ts";
import { BrowserTaskStateStore } from "./task-state-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; store: BrowserTaskStateStore }> {
  const root = await mkdtemp(join(tmpdir(), "mu-browser-task-state-"));
  roots.push(root);
  return { root, store: new BrowserTaskStateStore(join(root, "state")) };
}

function snapshot(authority: string) {
  const ledger = new BrowserTaskLedger();
  ledger.begin(authority);
  ledger.plan([{ id: "result", description: "Find the result", kind: "fact" }], ["Inspect"]);
  return ledger.snapshot();
}

describe("browser task state store", () => {
  test("round-trips private state", async () => {
    const { store } = await fixture();
    const value = snapshot("task one");
    await store.save("agent/session", value);
    expect(await store.load("agent/session")).toEqual(value);
    if (process.platform !== "win32") {
      expect((await stat(store.root)).mode & 0o777).toBe(0o700);
      expect((await stat(store.path("agent/session"))).mode & 0o777).toBe(0o600);
    }
  });

  test("hashes session ids so paths remain confined", async () => {
    const { store } = await fixture();
    const path = store.path("../../escape/secret");
    expect(dirname(path)).toBe(store.root);
    expect(basename(path)).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(path).not.toContain("secret");
  });

  test("corrupt state fails closed", async () => {
    const { store } = await fixture();
    await store.save("session", snapshot("valid"));
    await writeFile(store.path("session"), '{"version":1,"authorityId":"oops"}');
    expect(await store.load("session")).toBeUndefined();
  });

  test("atomic overwrite leaves one complete destination", async () => {
    const { store } = await fixture();
    await store.save("session", snapshot("first"));
    await store.save("session", snapshot("second"));
    expect((await store.load("session"))?.authorityId).toBe("second");
    expect(await readdir(store.root)).toEqual([basename(store.path("session"))]);
    const raw = await readFile(store.path("session"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
