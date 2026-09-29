import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { PermissionRequest } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, optionsFromProfile } from "mu";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(60_000);

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  content: [{ type: "toolCall" as const, id, name, arguments: args }],
});

describeWithBrowser("approved consequential actions that never ran", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;

  beforeAll(async () => {
    site = startFixtureSite();
    profile = await browserProfile({
      home,
      headless: true,
      keepOpen: false,
      vision: "off",
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
  });
  afterAll(async () => {
    await profile.browser.shutdown({ close: true });
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("a retry after clearing the covering banner is not asked again; a later repeat is", async () => {
    const send = { ref: "e2", commit: true, reason: "send it" };
    const provider = new FakeProvider([
      call("c1", "navigate", { url: site.url("modal") }),
      call("c2", "click", send),
      call("c3", "click", { ref: "e5" }),
      call("c4", "click", { ...send, reason: "retry" }),
      call("c5", "click", send),
      { content: [{ type: "text", text: "Done." }] },
    ]);
    const requests: PermissionRequest[] = [];
    const agent = new Agent(
      await optionsFromProfile(profile, "fake/fake-1", {
        provider,
        model: fakeModel,
        onPermission: async (request) => {
          requests.push(request);
          return "allow";
        },
      }),
    );
    const result = await agent.run("Press the hidden button");
    const clicks = result.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => (message.details as { kind?: string } | undefined)?.kind);
    expect(clicks[1]).toBe("occluded");
    expect(clicks[3]).toBeUndefined();
    expect(requests.filter((request) => request.permission === "browser:commit").length).toBe(2);
    await agent.shutdown();
  });
});
