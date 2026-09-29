import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import type { RefMeta } from "../page/refs.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";
import { classify, matchesCommitLexicon } from "./classify.ts";

setDefaultTimeout(30_000);

const button = (name: string, extra: Partial<RefMeta> = {}): RefMeta => ({
  role: "button",
  name,
  ...extra,
});

function scope(tool: string, args: Record<string, unknown>, metas: Record<string, RefMeta>) {
  return classify({ tool, args, meta: (ref) => metas[ref] }).scope;
}

describe("consequential-action classifier", () => {
  test("commit lexicon", () => {
    for (const name of [
      "Send",
      "Place order",
      "Delete",
      "Save changes",
      "Buy now",
      "Pay $42.00",
      "Confirm purchase",
      "Unsubscribe",
      "Sign up",
      "Post",
      "Publish",
      "Book now",
      "Transfer funds",
      "Discard draft",
      "I agree",
    ]) {
      expect(matchesCommitLexicon(name)).toBe(true);
    }
    for (const name of [
      "Search",
      "Next",
      "Cancel",
      "Close",
      "Compose",
      "Add to cart",
      "Filters",
      "Show more",
      "Sender",
      "Bookmarks",
      "Settings",
    ]) {
      expect(matchesCommitLexicon(name)).toBe(false);
    }
  });

  test("click: lexicon, POST submit buttons and destructive dialogs; declaration always wins", () => {
    const metas = {
      e1: button("Send"),
      e2: button("Search"),
      e3: button("Continue", { form: { post: true, submit: true } }),
      e4: button("Continue", { form: { post: false, submit: true } }),
      e5: button("Yes", { dialogTitle: "Delete account?" }),
      e6: button("Cancel", { dialogTitle: "Delete account?" }),
    };
    expect(scope("click", { ref: "e1" }, metas)).toBe("browser:commit");
    expect(scope("click", { ref: "e2" }, metas)).toBe("browser:interact");
    expect(scope("click", { ref: "e3" }, metas)).toBe("browser:commit");
    expect(scope("click", { ref: "e4" }, metas)).toBe("browser:interact");
    expect(scope("click", { ref: "e5" }, metas)).toBe("browser:commit");
    expect(scope("click", { ref: "e6" }, metas)).toBe("browser:interact");
    expect(scope("click", { ref: "e2", commit: true }, metas)).toBe("browser:commit");
    expect(scope("click_xy", { x: 1, y: 2 }, metas)).toBe("browser:interact");
    expect(scope("click_xy", { x: 1, y: 2, commit: true }, metas)).toBe("browser:commit");
    expect(scope("select", { ref: "e2", options: ["x"] }, metas)).toBe("browser:interact");
  });

  test("Enter submits forms; secrets are their own scope", () => {
    const metas = {
      q: {
        role: "searchbox",
        name: "Search",
        editable: "text" as const,
        form: { post: false, submitLabel: "Search" },
      },
      msg: {
        role: "textbox",
        name: "Comment",
        editable: "text" as const,
        form: { post: false, submitLabel: "Post comment" },
      },
      pw: { role: "textbox", name: "Password", editable: "secret" as const },
      otp: { role: "textbox", name: "Code", editable: "otp" as const },
    };
    expect(scope("type", { ref: "q", text: "mugs", submit: true }, metas)).toBe("browser:interact");
    expect(scope("type", { ref: "msg", text: "hi", submit: true }, metas)).toBe("browser:commit");
    expect(scope("type", { ref: "msg", text: "hi" }, metas)).toBe("browser:interact");
    expect(scope("press", { keys: "Enter", ref: "msg" }, metas)).toBe("browser:commit");
    expect(scope("press", { keys: "Tab", ref: "msg" }, metas)).toBe("browser:interact");
    expect(scope("type", { ref: "pw", text: "hunter2" }, metas)).toBe("browser:secret");
    expect(scope("type", { ref: "otp", text: "123456" }, metas)).toBe("browser:secret");
    expect(scope("fill_form", { fields: [{ ref: "pw", value: "x" }] }, metas)).toBe(
      "browser:secret",
    );
    expect(
      scope(
        "fill_form",
        { fields: [{ ref: "q", value: "x" }], submitRef: "e1" },
        { ...metas, e1: button("Place order") },
      ),
    ).toBe("browser:commit");
  });
});

describeWithBrowser("classifier on fixture pages", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  const tool = (name: string) => {
    const found = profile.toolset.find((candidate) => candidate.name === name);
    if (!found) throw new Error(name);
    return found;
  };
  const textOf = async (name: string, args: Record<string, unknown>) =>
    ((await tool(name).execute("x", args, new AbortController().signal)) as ToolResult).content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  const ref = (text: string, role: string, name: string) =>
    new RegExp(`- ${role} "${name}"[^\\n]*?\\[ref=([a-z0-9]+)\\]`).exec(text)?.[1] as string;

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

  test("mail, shop and account pages: buttons that must ask, and ones that must not", async () => {
    const mail = await textOf("navigate", { url: site.url("mail-mock") });
    expect(tool("click").permissionScope?.({ ref: ref(mail, "button", "Compose") })).toBe(
      "browser:interact",
    );
    const composed = await textOf("click", { ref: ref(mail, "button", "Compose") });
    expect(tool("click").permissionScope?.({ ref: ref(composed, "button", "Send") })).toBe(
      "browser:commit",
    );
    expect(tool("click").permissionScope?.({ ref: ref(composed, "button", "Discard draft") })).toBe(
      "browser:commit",
    );
    const shop = await textOf("navigate", { url: site.url("shop-mock") });
    expect(tool("click").permissionScope?.({ ref: ref(shop, "button", "Search") })).toBe(
      "browser:interact",
    );
    expect(
      tool("click").permissionScope?.({ ref: ref(shop, "button", "Add Classic Mug to cart") }),
    ).toBe("browser:interact");
    const cart = await textOf("navigate", { url: `${site.url("shop-mock")}#cart` });
    const placeOrder = ref(cart, "button", "Place order");
    expect(tool("click").permissionScope?.({ ref: placeOrder })).toBe("browser:commit");
    const details = await tool("click").permissionDetails?.({
      ref: placeOrder,
      reason: "user asked",
    });
    expect(details?.description).toStartWith("Consequential browser action on 127.0.0.1");
    expect(details?.preview?.kind === "text" && details.preview.lines.join("\n")).toContain(
      'action: click button "Place order"',
    );
    const form = await textOf("navigate", { url: site.url("form-basic") });
    const password = ref(form, "textbox", "Password");
    expect(tool("type").permissionScope?.({ ref: password, text: "s3cret" })).toBe(
      "browser:secret",
    );
    const secretDetails = await tool("type").permissionDetails?.({ ref: password, text: "s3cret" });
    const shown =
      secretDetails?.preview?.kind === "text" ? secretDetails.preview.lines.join("\n") : "";
    expect(shown).toContain("••••");
    expect(shown).not.toContain("s3cret");
  });
});
