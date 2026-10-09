import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, optionsFromProfile } from "mu";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(60_000);

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  content: [{ type: "toolCall" as const, id, name, arguments: args }],
});

describeWithBrowser("context retention end to end", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  beforeAll(async () => {
    site = startFixtureSite();
    profile = await browserProfile({
      home,
      headless: true,
      keepOpen: false,
      vision: "on",
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
  });
  afterAll(async () => {
    await profile.browser.shutdown({ close: true });
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("after several actions the model sees one full observation and one screenshot", async () => {
    const provider = new FakeProvider([
      call("a1", "navigate", { url: site.url("form-basic") }),
      call("a2", "type", { ref: "e4", text: "Ada" }),
      call("a3", "navigate", { url: site.url("custom-select") }),
      call("a4", "click", { ref: "e1" }),
      call("a5", "navigate", { url: site.url("long") }),
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = new Agent(
      await optionsFromProfile(profile, "fake/fake-1", {
        provider,
        model: { ...fakeModel, modalities: ["text", "image"] },
        onPermission: async () => "allow",
      }),
    );
    await agent.run("look around");
    const final = provider.requests.at(-1);
    const results = (final?.messages ?? []).filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(5);
    const full = results.filter((message) =>
      message.content.some(
        (block) => block.type === "text" && block.text.includes("<page_content"),
      ),
    );
    const images = results.flatMap((message) =>
      message.content.filter((block) => block.type === "image"),
    );
    expect(full).toHaveLength(1);
    expect(full[0]?.toolCallId).toBe("a5");
    expect(images).toHaveLength(1);
    const summaries = results
      .slice(0, 4)
      .map((message) =>
        message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
      );
    expect(summaries[0]).toMatch(/^navigated to .*form-basic \(page: http:\/\/.*form-basic\)$/);
    expect(summaries[1]).toMatch(/^typed "Ada" into textbox "Full name" \[e4\]/);
    expect(summaries[3]).toMatch(/^clicked clickable "Select size ▾" \[e1\]/);
    for (const summary of summaries) expect(summary.length).toBeLessThan(250);
    await agent.shutdown();
  });
});

describeWithBrowser("per-tab retention", () => {
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

  test("each open tab keeps its latest page state; older states of a tab collapse", async () => {
    const provider = new FakeProvider([
      call("b1", "navigate", { url: site.url("form-basic") }),
      call("b2", "tabs", { action: "open", url: site.url("long") }),
      call("b3", "scroll", { direction: "down" }),
      call("b4", "tabs", { action: "switch", tabId: "t1" }),
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = new Agent(
      await optionsFromProfile(profile, "fake/fake-1", { provider, model: fakeModel }),
    );
    await agent.run("compare two pages");
    const results = (provider.requests.at(-1)?.messages ?? []).filter(
      (message) => message.role === "toolResult",
    );
    const full = results
      .filter((message) =>
        message.content.some(
          (block) => block.type === "text" && block.text.includes("<page_content"),
        ),
      )
      .map((message) => message.toolCallId);
    expect(full).toEqual(["b3", "b4"]);
    await agent.shutdown();
  });
});

describeWithBrowser("live-tab cap", () => {
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

  test("only the three most recently observed tabs stay in full; a closed tab's slot is reused", async () => {
    const provider = new FakeProvider([
      call("c1", "navigate", { url: site.url("form-basic") }),
      call("c2", "tabs", { action: "open", url: site.url("long") }),
      call("c3", "tabs", { action: "open", url: site.url("shadow") }),
      call("c4", "tabs", { action: "open", url: site.url("modal") }),
      call("c5", "tabs", { action: "close", tabId: "t4" }),
      call("c6", "tabs", { action: "open", url: site.url("custom-select") }),
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = new Agent(
      await optionsFromProfile(profile, "fake/fake-1", { provider, model: fakeModel }),
    );
    await agent.run("read many pages");
    const live = (request: number) =>
      (provider.requests[request]?.messages ?? [])
        .filter(
          (message) =>
            message.role === "toolResult" &&
            message.content.some(
              (block) => block.type === "text" && block.text.includes("<page_content"),
            ),
        )
        .map((message) => (message.role === "toolResult" ? message.toolCallId : ""));
    // After four tabs: the first tab's page collapsed, the latest three remain.
    expect(live(4)).toEqual(["c2", "c3", "c4"]);
    // Closing t4 re-observes the tab it lands on; the next new tab takes t4's slot.
    expect(live(6)).not.toContain("c4");
    expect(live(6).length).toBeLessThanOrEqual(3);
    expect(live(6)).toContain("c6");
    await agent.shutdown();
  });
});
