import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { permissionPreviewLines, type ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import type { RefMeta } from "../page/refs.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";
import { classify, commitStrength, matchesCommitLexicon } from "./classify.ts";

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

  test("links that open a form do not ask; links that act, and buttons, still do", () => {
    const metas = {
      e1: button("Apply Now for MASRUSR291884", { link: true }),
      e2: button("Register", { link: true }),
      e3: button("Unsubscribe", { link: true }),
      e4: button("Delete account", { link: true }),
      e5: button("Apply"),
      e6: button("Apply now", { link: true }),
      e7: button("Reply", { role: "link" }),
      e8: button("Reply"),
    };
    expect(scope("click", { ref: "e1" }, metas)).toBe("browser:interact");
    expect(scope("click", { ref: "e2" }, metas)).toBe("browser:interact");
    expect(scope("click", { ref: "e3" }, metas)).toBe("browser:commit");
    expect(scope("click", { ref: "e4" }, metas)).toBe("browser:commit");
    expect(scope("click", { ref: "e5" }, metas)).toBe("browser:commit");
    expect(scope("click", { ref: "e6", commit: true }, metas)).toBe("browser:commit");
    expect(scope("click", { ref: "e7" }, metas)).toBe("browser:interact");
    expect(scope("click", { ref: "e8" }, metas)).toBe("browser:commit");
  });

  test("prices in a button, and proceeding on checkout or payment pages, count as consequential", () => {
    const metas = {
      e1: button("Continue – $19.99"),
      e2: button("Place order ₹1,299"),
      e3: button("Continue"),
      e4: button("Next"),
      e5: button("Back"),
      e6: button("Add 2 items"),
    };
    const at = (url: string, title = "Shop") => ({ url, title });
    const scopeAt = (ref: string, page: { url: string; title: string }) =>
      classify({
        tool: "click",
        args: { ref },
        meta: (id) => metas[id as keyof typeof metas],
        page,
      }).scope;
    expect(scopeAt("e1", at("https://shop.test/cart"))).toBe("browser:commit");
    expect(scopeAt("e2", at("https://shop.test/cart"))).toBe("browser:commit");
    expect(scopeAt("e3", at("https://shop.test/checkout/payment"))).toBe("browser:commit");
    expect(scopeAt("e4", at("https://shop.test/step/3", "Billing details"))).toBe("browser:commit");
    expect(scopeAt("e3", at("https://jobs.test/apply?step=2"))).toBe("browser:interact");
    expect(scopeAt("e5", at("https://shop.test/checkout/payment"))).toBe("browser:interact");
    expect(scopeAt("e6", at("https://shop.test/checkout"))).toBe("browser:interact");
  });

  test("only the action that finishes the job reads as final", () => {
    const shop = { url: "https://www.saucedemo.com/inventory.html", title: "Swag Labs" };
    const overview = {
      url: "https://www.saucedemo.com/checkout-step-two.html",
      title: "Swag Labs",
    };
    const step = { url: "https://www.saucedemo.com/checkout-step-one.html", title: "Swag Labs" };
    const done = { url: "https://www.saucedemo.com/checkout-complete.html", title: "Swag Labs" };
    expect(commitStrength(["Login"], { url: "https://www.saucedemo.com/", title: "" })).toBe(
      "step",
    );
    expect(commitStrength(["Add to cart"], shop)).toBe("step");
    expect(commitStrength(["Remove"], shop)).toBe("step");
    expect(commitStrength(["Checkout"], shop)).toBe("step");
    expect(commitStrength(["Continue"], step, overview)).toBe("step");
    expect(commitStrength(["Finish"], overview)).toBe("final");
    expect(commitStrength(["Finish"], shop)).toBe("step");
    expect(commitStrength(["Reset App State"], shop, done)).toBe("final");
    expect(
      commitStrength(["Send"], { url: "https://mail.google.com/mail/u/0/", title: "Inbox" }),
    ).toBe("final");
    expect(commitStrength(["Place order ₹1,299"], shop)).toBe("final");
    expect(commitStrength(["Pay $12.00"], shop)).toBe("final");
    expect(commitStrength(["Cancel"], overview)).toBe("step");
    expect(commitStrength([undefined, "Submit application"], shop)).toBe("final");
    expect(commitStrength(["Continue"], step, { url: step.url, title: "Order confirmed" })).toBe(
      "step",
    );
  });

  test("Enter only submits plain fields of forms with a submit button", () => {
    const metas: Record<string, RefMeta> = {
      to: { role: "combobox", name: "To recipients", editable: "text", form: { post: true } },
      toWithButton: {
        role: "combobox",
        name: "To",
        editable: "text",
        form: { post: true, submitLabel: "Send" },
      },
      body: {
        role: "textbox",
        name: "Message Body",
        editable: "rich",
        form: { post: true, submitLabel: "Send" },
      },
      noButton: { role: "textbox", name: "Subject", editable: "text", form: { post: true } },
      login: {
        role: "textbox",
        name: "Email",
        editable: "text",
        form: { post: true, submitLabel: "Continue" },
      },
    };
    expect(scope("type", { ref: "to", text: "a@b.c", submit: true }, metas)).toBe(
      "browser:interact",
    );
    expect(scope("type", { ref: "toWithButton", text: "a@b.c", submit: true }, metas)).toBe(
      "browser:interact",
    );
    expect(scope("press", { keys: "Enter", ref: "body" }, metas)).toBe("browser:interact");
    expect(scope("press", { keys: "Enter", ref: "noButton" }, metas)).toBe("browser:interact");
    expect(scope("press", { keys: "Enter", ref: "login" }, metas)).toBe("browser:commit");
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
    expect(permissionPreviewLines(details?.preview).join("\n")).toContain(
      'action: click button "Place order"',
    );
    const form = await textOf("navigate", { url: site.url("form-basic") });
    const password = ref(form, "textbox", "Password");
    expect(tool("type").permissionScope?.({ ref: password, text: "s3cret" })).toBe(
      "browser:secret",
    );
    const secretDetails = await tool("type").permissionDetails?.({ ref: password, text: "s3cret" });
    const shown = permissionPreviewLines(secretDetails?.preview).join("\n");
    expect(shown).toContain("••••");
    expect(shown).not.toContain("s3cret");
  });
});
