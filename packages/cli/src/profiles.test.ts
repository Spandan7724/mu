import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_VERSION, SessionTree } from "@mu/core";
import { codingProfile } from "@mu/profile-coding";
import { resolveProfile, sessionStoreForProfile } from "./profiles.ts";

describe("profile session persistence", () => {
  test("file-backed stores use the profile scope across process instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-session-workspace-"));
    const sessionRoot = await mkdtemp(join(tmpdir(), "mu-session-store-"));
    const profile = await codingProfile({ root });
    const first = await sessionStoreForProfile(profile, sessionRoot);
    const tree = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: "saved-session",
      createdAt: "2026-07-27T00:00:00.000Z",
      profile: profile.name,
      environment: {},
    });
    await first.save("saved-session", tree);

    const second = await sessionStoreForProfile(await codingProfile({ root }), sessionRoot);
    expect(await second.list()).toEqual(["saved-session"]);
    expect((await second.load("saved-session"))?.header?.id).toBe("saved-session");
  });
});

describe("built-in profiles", () => {
  test("resolves the browser profile with a per-browser-profile session scope", async () => {
    const profile = await resolveProfile("browser", { browserProfile: "work" });
    expect(profile.name).toBe("browser");
    expect(await profile.scope?.()).toBe("browser-work");
  });
});

describe("session scopes", () => {
  test("browser sessions are stored and listed separately from coding sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-scope-workspace-"));
    const sessionRoot = await mkdtemp(join(tmpdir(), "mu-scope-store-"));
    const coding = await sessionStoreForProfile(await codingProfile({ root }), sessionRoot);
    const browser = await sessionStoreForProfile(
      await resolveProfile("browser", { home: root, browserProfile: "work" }),
      sessionRoot,
    );
    const tree = (id: string, profile: string) =>
      new SessionTree({
        type: "session",
        version: SESSION_VERSION,
        id,
        createdAt: "2026-09-29T00:00:00.000Z",
        profile,
        environment: {},
      });
    await coding.save("coding-1", tree("coding-1", "coding"));
    await browser.save("browser-1", tree("browser-1", "browser"));
    expect(await coding.list()).toEqual(["coding-1"]);
    expect(await browser.list()).toEqual(["browser-1"]);
    const other = await sessionStoreForProfile(
      await resolveProfile("browser", { home: root, browserProfile: "personal" }),
      sessionRoot,
    );
    expect(await other.list()).toEqual([]);
  });
});
