import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_VERSION, SessionTree, userMessage } from "@mu/core";
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

  test("deletes a session without affecting other sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-file-delete-"));
    const store = new FileSessionStore({ root });
    await store.save("keep", tree("keep"));
    await store.save("remove", tree("remove"));

    expect(await store.delete("remove")).toBe(true);
    expect(await store.delete("remove")).toBe(false);
    expect(await store.load("remove")).toBeUndefined();
    expect(await store.list()).toEqual(["keep"]);
  });

  const only = async (root: string) => {
    const [file] = (await readdir(root)).filter((name) => name.endsWith(".jsonl"));
    return join(root, file as string);
  };

  test("a grown session is appended to, not rewritten", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-file-append-"));
    const store = new FileSessionStore({ root });
    const session = tree("grow");
    session.appendMessage(userMessage("one"));
    await store.save("grow", session);
    const path = await only(root);
    const first = await stat(path);

    session.appendMessage(userMessage("two"));
    session.appendMessage(userMessage("three"));
    await store.save("grow", session);
    await store.save("grow", session);

    expect((await stat(path)).ino).toBe(first.ino);
    expect(await readFile(path, "utf8")).toBe(session.toJsonl());
    expect((await new FileSessionStore({ root }).load("grow"))?.toJsonl()).toBe(session.toJsonl());
  });

  test("a reopened session keeps appending", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-file-reopen-"));
    const session = tree("reopen");
    session.appendMessage(userMessage("one"));
    await new FileSessionStore({ root }).save("reopen", session);
    const path = await only(root);
    const first = await stat(path);

    const store = new FileSessionStore({ root });
    const loaded = (await store.load("reopen")) as SessionTree;
    loaded.appendMessage(userMessage("two"));
    await store.save("reopen", loaded);

    expect((await stat(path)).ino).toBe(first.ino);
    expect(await readFile(path, "utf8")).toBe(loaded.toJsonl());
  });

  test("history that is not a continuation of the file replaces it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-file-diverge-"));
    const store = new FileSessionStore({ root });
    const session = tree("diverge");
    const base = session.appendMessage(userMessage("one"));
    session.appendMessage(userMessage("two"));
    await store.save("diverge", session);
    const path = await only(root);

    const other = SessionTree.fromJsonl(session.toJsonl().split("\n").slice(0, 2).join("\n"));
    other.fork(base.id);
    other.appendMessage(userMessage("another branch"));
    other.appendMessage(userMessage("and more"));
    await store.save("diverge", other);
    expect(await readFile(path, "utf8")).toBe(other.toJsonl());

    other.setTitle("renamed");
    other.appendMessage(userMessage("after the rename"));
    await store.save("diverge", other);
    expect(await readFile(path, "utf8")).toBe(other.toJsonl());

    const shorter = SessionTree.fromJsonl(other.toJsonl().split("\n").slice(0, 2).join("\n"));
    await store.save("diverge", shorter);
    expect(await readFile(path, "utf8")).toBe(shorter.toJsonl());
  });

  test("a file changed by someone else is replaced, never appended to", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-file-foreign-"));
    const store = new FileSessionStore({ root });
    const session = tree("foreign");
    session.appendMessage(userMessage("one"));
    await store.save("foreign", session);
    const path = await only(root);

    await appendFile(
      path,
      '{"type":"custom","id":"x","parentId":null,"customType":"t","data":1}\n',
    );
    session.appendMessage(userMessage("two"));
    await store.save("foreign", session);
    expect(await readFile(path, "utf8")).toBe(session.toJsonl());

    await rm(path);
    session.appendMessage(userMessage("three"));
    await store.save("foreign", session);
    expect(await readFile(path, "utf8")).toBe(session.toJsonl());
  });

  test("concurrent saves leave the latest session intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-file-race-"));
    const store = new FileSessionStore({ root });
    const session = tree("race");
    const saves: Promise<void>[] = [];
    for (let index = 0; index < 20; index++) {
      session.appendMessage(userMessage(`message ${index}`));
      saves.push(store.save("race", session));
    }
    await Promise.all(saves);
    expect(await readFile(await only(root), "utf8")).toBe(session.toJsonl());
  });

  test("a last line cut short by a crash is dropped on load and healed by the next save", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-file-torn-"));
    const session = tree("torn");
    session.appendMessage(userMessage("one"));
    await new FileSessionStore({ root }).save("torn", session);
    const path = await only(root);
    await appendFile(path, '{"type":"message","id":"e9","parentId":');

    const store = new FileSessionStore({ root });
    const loaded = (await store.load("torn")) as SessionTree;
    expect(loaded.toJsonl()).toBe(session.toJsonl());
    loaded.appendMessage(userMessage("two"));
    await store.save("torn", loaded);
    expect(await readFile(path, "utf8")).toBe(loaded.toJsonl());
  });

  test("an append interrupted at any byte loads as a clean earlier state", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-file-crash-"));
    const session = tree("crash");
    session.appendMessage(userMessage("one"));
    const before = session.toJsonl();
    session.appendMessage(userMessage("two — with a multi-byte tail ✓"));
    session.appendMessage(userMessage("three"));
    const after = session.toJsonl();
    const writer = new FileSessionStore({ root });
    await writer.save("crash", session);
    const path = await only(root);
    const full = Buffer.from(after);
    const start = Buffer.byteLength(before);

    const seen = new Set<number>();
    for (let cut = start; cut <= full.length; cut++) {
      await writeFile(path, full.subarray(0, cut));
      const store = new FileSessionStore({ root });
      const loaded = (await store.load("crash")) as SessionTree;
      const text = loaded.toJsonl();
      expect(after.startsWith(text)).toBe(true);
      expect(text.startsWith(before)).toBe(true);
      seen.add(text.length);

      loaded.appendMessage(userMessage("next"));
      await store.save("crash", loaded);
      expect(await readFile(path, "utf8")).toBe(loaded.toJsonl());
    }
    // Only whole entries ever appear: none, the first, or both.
    expect(seen.size).toBe(3);
  });

  test("listing reads only each header", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-file-list-"));
    const store = new FileSessionStore({ root });
    const session = tree("listed");
    session.appendMessage(userMessage("x".repeat(200_000)));
    await store.save("listed", session);
    await appendFile(await only(root), "not json at all\n");

    expect(await store.list()).toEqual(["listed"]);
  });
});
