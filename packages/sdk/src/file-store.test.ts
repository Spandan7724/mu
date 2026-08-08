import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_VERSION, SessionTree } from "@mu/core";
import { FileSessionStore } from "./file-store.ts";

function tree(id: string): SessionTree {
  return new SessionTree({
    type: "session",
    version: SESSION_VERSION,
    id,
    createdAt: new Date(0).toISOString(),
    profile: "test",
    environment: {},
  });
}

describe("FileSessionStore", () => {
  test("opaque IDs round-trip without filename collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-file-store-"));
    const store = new FileSessionStore({ root });
    await store.save("a/b", tree("a/b"));
    await store.save("a?b", tree("a?b"));

    expect((await store.load("a/b"))?.header?.id).toBe("a/b");
    expect((await store.load("a?b"))?.header?.id).toBe("a?b");
    expect(new Set(await store.list())).toEqual(new Set(["a/b", "a?b"]));
    const files = (await readdir(root)).filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(2);
    expect(files.every((name) => !name.startsWith("v2-"))).toBe(true);
  });

  test("repairs directory and transcript permissions on Unix", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "mu-file-mode-"));
    const store = new FileSessionStore({ root });
    await store.save("private", tree("private"));

    const [file] = (await readdir(root)).filter((name) => name.endsWith(".jsonl"));
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, file as string))).mode & 0o777).toBe(0o600);
  });
});
