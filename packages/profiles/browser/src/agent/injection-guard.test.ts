import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AnyTool,
  type PermissionRequest,
  permissionPreviewLines,
  type ToolResult,
} from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, optionsFromProfile } from "mu";
import { resolveUploadPaths } from "../actions/files.ts";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { FIXTURE_DIR, type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(60_000);

const PHRASE = "purple elephant marmalade seven seven three one";

describeWithBrowser("prompt-injection guards", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  const find = (name: string) =>
    profile.toolset.find((candidate) => candidate.name === name) as AnyTool;
  const run = async (name: string, args: Record<string, unknown>) =>
    ((await find(name).execute("x", args, new AbortController().signal)) as ToolResult).content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  const scope = (name: string, args: Record<string, unknown>) => find(name).permissionScope?.(args);

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

  test("page text sent to another site through a URL or a form asks; links and the user's words do not", async () => {
    await run("navigate", { url: site.url("private-note") });
    const exfil = `${site.crossOrigin}/form-basic?d=${encodeURIComponent(PHRASE)}`;
    expect(scope("navigate", { url: exfil })).toBe("browser:share");
    expect(scope("tabs", { action: "open", url: exfil })).toBe("browser:share");
    const details = await find("navigate").permissionDetails?.({ url: exfil });
    expect(permissionPreviewLines(details?.preview).join("\n")).toContain(
      `why this asks: the URL carries text read on ${new URL(site.origin).host}`,
    );
    const partner = (
      /href="([^"]+)"/.exec(readFileSync(join(FIXTURE_DIR, "private-note.html"), "utf8"))?.[1] ?? ""
    )
      .replace("{{CROSS_ORIGIN}}", site.crossOrigin)
      .replace("&amp;", "&");
    expect(scope("navigate", { url: partner })).toBe("browser:navigate");
    expect(scope("navigate", { url: `${site.crossOrigin}/form-basic?q=${"z".repeat(300)}` })).toBe(
      "browser:share",
    );
    expect(scope("navigate", { url: `${site.crossOrigin}/form-basic` })).toBe("browser:navigate");

    const cross = `${site.crossOrigin}/form-basic`;
    expect(scope("navigate", { url: `${cross}?acct=48213377` })).toBe("browser:share");
    expect(scope("navigate", { url: `${cross}/x7k2pq9` })).toBe("browser:share");
    expect(scope("navigate", { url: `${cross}?to=ada.private%40example.test` })).toBe(
      "browser:share",
    );
    const base64 = Buffer.from(`note: ${PHRASE}`).toString("base64url");
    expect(scope("navigate", { url: `${cross}?d=${base64}` })).toBe("browser:share");
    const hex = Buffer.from("acct 48213377").toString("hex");
    expect(scope("navigate", { url: `${cross}#${hex}` })).toBe("browser:share");
    expect(scope("navigate", { url: `${cross}?page=2&sort=newest` })).toBe("browser:navigate");
    profile.browser.dataflow.userSaid("look up account 48213377 on the partner site");
    expect(scope("navigate", { url: `${cross}?acct=48213377` })).toBe("browser:navigate");
    profile.browser.dataflow.userSaid("");

    const form = await run("navigate", { url: `${site.crossOrigin}/form-basic` });
    const name = /textbox "Full name" \[ref=(e\d+)\]/.exec(form)?.[1] as string;
    expect(scope("type", { ref: name, text: `Note: ${PHRASE}` })).toBe("browser:share");
    expect(scope("fill_form", { fields: [{ ref: name, value: PHRASE }] })).toBe("browser:share");
    expect(scope("type", { ref: name, text: "Ada Lovelace, typed from the request" })).toBe(
      "browser:interact",
    );
    profile.browser.dataflow.userSaid(`Put "${PHRASE}" in the name field`);
    expect(scope("type", { ref: name, text: PHRASE })).toBe("browser:interact");
    profile.browser.dataflow.userSaid("");
  });

  test("text hidden from people never reaches the model; invisible controls still work", async () => {
    await run("navigate", { url: site.url("hidden-text") });
    const text = await run("read_page", {});
    expect(text).toContain("Visible intro paragraph.");
    expect(text).toContain("Gradient heading stays");
    expect(text).toMatch(/textbox "Nickname" \[ref=e\d+\]/);
    expect(text).not.toContain("HIDDEN-");
  });

  test("a denied share leaves the data where it was", async () => {
    const exfil = `${site.crossOrigin}/form-basic?d=${encodeURIComponent(PHRASE)}`;
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "navigate",
            arguments: { url: site.url("private-note") },
          },
        ],
      },
      { content: [{ type: "toolCall", id: "c2", name: "navigate", arguments: { url: exfil } }] },
      { content: [{ type: "text", text: "Stopped." }] },
    ]);
    const requests: PermissionRequest[] = [];
    const agent = new Agent(
      await optionsFromProfile(profile, "fake/fake-1", {
        provider,
        model: fakeModel,
        onPermission: async (request) => {
          requests.push(request);
          return "deny";
        },
      }),
    );
    await agent.run("Read my account page");
    expect(requests.map((request) => request.permission)).toEqual(["browser:share"]);
    expect(profile.browser.currentTab()?.url).toBe(site.url("private-note"));
    await agent.shutdown();
  });
});

test("uploads come only from the agent's folder or downloads, never credentials or keys", () => {
  const dir = tempUserDataDir();
  const workspace = join(dir, "work");
  const downloads = join(dir, ".mu", "browser", "downloads");
  const files = {
    key: join(workspace, ".ssh", "id_ed25519"),
    env: join(workspace, "project", ".env.local"),
    pem: join(workspace, "certs", "server.pem"),
    download: join(downloads, "form.pdf"),
    resume: join(workspace, "Documents", "resume.pdf"),
    outside: join(dir, "elsewhere", "taxes.pdf"),
  };
  for (const path of Object.values(files)) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
  }
  symlinkSync(files.outside, join(workspace, "linked.pdf"));
  const roots = [workspace, downloads];
  for (const path of [files.key, files.env, files.pem])
    expect(() => resolveUploadPaths([path], roots)).toThrow(/Refusing to upload/);
  expect(() => resolveUploadPaths([files.outside], roots)).toThrow(/only files in/);
  expect(() => resolveUploadPaths(["linked.pdf"], roots)).toThrow(/only files in/);
  expect(resolveUploadPaths(["Documents/resume.pdf", files.download], roots)).toHaveLength(2);
  rmSync(dir, { recursive: true, force: true });
});
