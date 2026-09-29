import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PermissionRequest } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, FileSessionStore, optionsFromProfile } from "mu";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(60_000);

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  content: [{ type: "toolCall" as const, id, name, arguments: args }],
});

describeWithBrowser("secrets never reach observations, prompts or the session file", () => {
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

  test("a prefilled password and a typed one are scrubbed everywhere but the model's own call", async () => {
    const typed = "s3cret-pass-771";
    const provider = new FakeProvider([
      call("c1", "navigate", { url: site.url("form-basic") }),
      call("c2", "fill_form", {
        fields: [
          { ref: "e4", value: "Ada" },
          { ref: "e7", value: typed },
        ],
      }),
      call("c3", "read_page", {}),
      call("c4", "click", { ref: "e14" }),
      call("c5", "find", { text: "password" }),
      { content: [{ type: "text", text: "Submitted." }] },
    ]);
    const requests: PermissionRequest[] = [];
    const store = new FileSessionStore({ root: join(home, "sessions"), scope: "browser-test" });
    const agent = new Agent(
      await optionsFromProfile(profile, "fake/fake-1", {
        provider,
        model: fakeModel,
        session: store,
        onPermission: async (request) => {
          requests.push(request);
          return "allow";
        },
      }),
    );
    const result = await agent.run("Log in with my password and submit the form");
    expect(result.text).toBe("Submitted.");
    expect(requests.map((request) => request.permission)).toEqual([
      "browser:secret",
      "browser:commit",
    ]);
    const shown = JSON.stringify(requests);
    expect(shown).not.toContain(typed);
    expect(shown).not.toContain("hunter2");

    const toolText = result.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => JSON.stringify(message))
      .join("\n");
    expect(toolText).toContain("[page] Submitted");
    expect(toolText).not.toContain(typed);
    expect(toolText).not.toContain("hunter2");
    expect(toolText).toContain("••••");

    const dir = join(home, "sessions", "browser-test");
    const jsonl = readdirSync(dir)
      .map((file) => readFileSync(join(dir, file), "utf8"))
      .join("\n");
    expect(jsonl).not.toContain("hunter2");
    expect(jsonl).toContain(typed);
    // The model's own tool-call arguments are the only place the typed value may appear.
    const withoutCallArguments = jsonl
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        JSON.stringify(JSON.parse(line), (key, value) =>
          key === "arguments" ? "[call arguments]" : value,
        ),
      )
      .join("\n");
    expect(withoutCallArguments).not.toContain(typed);
    await agent.shutdown();
  });
});
