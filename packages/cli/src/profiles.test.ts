import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_VERSION, SessionTree } from "@mu/core";
import { codingProfile } from "@mu/profile-coding";
import { sessionStoreForProfile } from "@mu/cli-runtime";

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
