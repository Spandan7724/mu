import { describe, expect, test } from "bun:test";
import type { ToolResult } from "@mu/core";
import { REDACTED } from "../contracts/secret.ts";
import { SAMPLE_ORIGIN, SAMPLE_TAB_ID, SAMPLE_URL } from "../testing/samples.ts";
import { BROWSER_TOOL_NAMES, browserToolRenderers } from "./cells.ts";

function result(text: string, details?: unknown): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
  };
}

function render(toolName: string, args: unknown, tool?: ToolResult): string {
  const renderer = browserToolRenderers[toolName];
  if (renderer === undefined) throw new Error(`no renderer for ${toolName}`);
  return renderer
    .render({ toolName, args, ...(tool === undefined ? {} : { result: tool }) })
    .join("\n");
}

describe("cells use user-level verbs, not browser internals", () => {
  test("observe", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.observe,
      {},
      result("Application form", {
        title: "Application",
        url: SAMPLE_URL,
        origin: SAMPLE_ORIGIN,
        frame: "application",
        revision: 3,
        controlCount: 18,
      }),
    );
    expect(rendered).toContain("observed · Application · 18 controls");
    expect(rendered).toContain(SAMPLE_URL);
    expect(rendered).toContain("frame · application");
    expect(rendered).toContain("revision 3");
  });

  test("navigate names requested, final and redirects", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.navigate,
      {},
      result("Opened", {
        url: "https://careers.example.com/apply",
        finalUrl: "https://careers.example.com/apply/step-1",
        redirects: ["https://careers.example.com/r/1"],
        revision: 4,
      }),
    );
    expect(rendered).toContain("opened · https://careers.example.com/apply/step-1");
    expect(rendered).toContain("requested");
    expect(rendered).toContain("redirects");
  });

  test("fill names the field and its provenance, never its value", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.act,
      { action: "fill" },
      result("Filled Email", {
        fieldLabel: "Email",
        provenance: "resume.pdf",
        validation: "accepted",
        origin: SAMPLE_ORIGIN,
      }),
    );
    expect(rendered).toContain("filled · Email");
    expect(rendered).toContain("source · resume.pdf");
    expect(rendered).toContain("validation · accepted");
  });

  test("select names the resulting value and the available option", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.act,
      { action: "select" },
      result("Selected", { fieldLabel: "Country", selected: "India", option: "India" }),
    );
    expect(rendered).toContain("selected · Country: India");
    expect(rendered).toContain("available option · India");
  });

  test("upload names the document and says it is not a submission", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.upload,
      {},
      result("Attached", {
        fieldLabel: "Resume",
        documents: [
          {
            documentId: "doc-resume",
            basename: "resume.pdf",
            mimeType: "application/pdf",
            bytes: 12_345,
          },
        ],
      }),
    );
    expect(rendered).toContain("attached · resume.pdf");
    expect(rendered).toContain("doc-resume");
    expect(rendered).toContain("12.1 kB");
    expect(rendered).toContain("not submitting the form");
  });

  test("wait names the condition, the deadline and the last state", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.wait,
      {},
      result("Waiting", {
        condition: "confirmation text",
        deadlineMs: 15_000,
        lastObserved: "the form is still on screen",
      }),
    );
    expect(rendered).toContain("waiting · confirmation text");
    expect(rendered).toContain("deadline 15000ms");
    expect(rendered).toContain("last observed");
  });

  test("tabs lists what Mu controls and which is active", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.tabs,
      {},
      result("2 tabs", {
        tabs: [
          { id: SAMPLE_TAB_ID, title: "Apply", url: SAMPLE_URL, active: true, attached: true },
          {
            id: "tab-2",
            title: "Offer",
            url: `${SAMPLE_ORIGIN}/offer`,
            active: false,
            attached: true,
          },
        ],
      }),
    );
    expect(rendered).toContain("tabs · 2 controlled");
    expect(rendered).toContain("active · Apply");
    expect(rendered).toContain("background · Offer");
  });

  test("takeover says what is waiting and how to come back", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.takeover,
      {},
      result("Sign in, then resume.", {
        takeoverReason: "login",
        origin: SAMPLE_ORIGIN,
        url: `${SAMPLE_ORIGIN}/login`,
      }),
    );
    expect(rendered).toContain("waiting for you in the browser · login");
    expect(rendered).toContain(`${SAMPLE_ORIGIN}/login`);
    expect(rendered).toContain("/browser resume");
  });

  test("no cell uses Playwright or selector vocabulary", () => {
    const rendered = [
      render(BROWSER_TOOL_NAMES.observe, {}, result("x", { title: "Apply", controlCount: 2 })),
      render(BROWSER_TOOL_NAMES.act, { action: "click" }, result("x", { fieldLabel: "Continue" })),
    ].join("\n");
    for (const word of ["playwright", "selector", "xpath", "locator", "cdp", "dom"]) {
      expect(rendered.toLowerCase()).not.toContain(word);
    }
  });
});

describe("a submit cell never claims success before evidence", () => {
  test("confirmed says so and names the receipt", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.submit,
      {},
      result("Submitted", {
        title: "Application",
        finalUrl: `${SAMPLE_ORIGIN}/apply/confirmation`,
        receiptStatus: "confirmed",
        receiptId: "receipt-1",
        approvalScope: "browser:submit",
        approvalGrant: "allow-once",
        evidence: ["external id APP-4711"],
      }),
    );
    expect(rendered).toContain("submitted · Application · confirmed");
    expect(rendered).toContain("the site confirmed the action");
    expect(rendered).toContain("approval · browser:submit · you allowed this once");
    expect(rendered).toContain("receipt receipt-1");
  });

  test("unconfirmed and unknown read differently and neither is retried", () => {
    const unconfirmed = render(
      BROWSER_TOOL_NAMES.submit,
      {},
      result("Submitted", {
        receiptStatus: "unconfirmed",
      }),
    );
    const unknown = render(
      BROWSER_TOOL_NAMES.submit,
      {},
      result("Submitted", {
        receiptStatus: "unknown",
      }),
    );
    expect(unconfirmed).toContain("submitted, unconfirmed");
    expect(unconfirmed).toContain("no sufficient confirmation");
    expect(unknown).toContain("connection was lost");
    expect(unconfirmed).not.toBe(unknown);
    for (const rendered of [unconfirmed, unknown]) {
      expect(rendered).toContain("will not repeat this action");
    }
  });

  test("a task-scoped grant is named as task-scoped, never as always", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.submit,
      {},
      result("Submitted", {
        receiptStatus: "confirmed",
        approvalScope: "browser:submit",
        approvalGrant: "allow-task",
      }),
    );
    expect(rendered).toContain("you allowed this for the task");
    expect(rendered).not.toContain("always");
  });
});

describe("no secret reaches a cell, compact or expanded", () => {
  test("a token in a tool result is scrubbed", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.observe,
      {},
      result("authorization: Bearer sk-live-01234567890abcdef", {
        title: "Account",
        warnings: ["cookie: session_id=abcdef0123456789"],
      }),
    );
    expect(rendered).not.toContain("sk-live-01234567890abcdef");
    expect(rendered).not.toContain("abcdef0123456789");
    expect(rendered).toContain(REDACTED);
  });

  test("a card number in a page summary is scrubbed", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.submit,
      {},
      result("Charging card 4111 1111 1111 1111", {
        title: "Checkout",
        receiptStatus: "confirmed",
      }),
    );
    expect(rendered).not.toContain("4111 1111 1111 1111");
  });

  test("an inline screenshot is described, never inlined", () => {
    const rendered = render(BROWSER_TOOL_NAMES.observe, {}, {
      content: [
        { type: "text", text: "Application" },
        { type: "image", data: "iVBORw0KGgoAAAANSUhEUg", mimeType: "image/png" },
      ],
    } as ToolResult);
    expect(rendered).not.toContain("iVBORw0KGgoAAAANSUhEUg");
  });
});

describe("cells degrade honestly when a tool supplies no structured detail", () => {
  test("the result's own first line becomes the head", () => {
    const rendered = render(BROWSER_TOOL_NAMES.observe, {}, result("Careers page\nmore detail"));
    expect(rendered).toContain("observed · Careers page");
  });

  test("a malformed details payload is ignored rather than trusted", () => {
    const rendered = render(
      BROWSER_TOOL_NAMES.observe,
      {},
      result("Careers page", {
        controlCount: "lots",
      }),
    );
    expect(rendered).toContain("observed · Careers page");
    expect(rendered).not.toContain("lots");
  });

  test("a missing result still renders a cell rather than nothing", () => {
    expect(render(BROWSER_TOOL_NAMES.wait, {}).length).toBeGreaterThan(0);
  });

  test("every rendered line is free of terminal escapes and raw newlines", () => {
    const renderer = browserToolRenderers[BROWSER_TOOL_NAMES.observe];
    const lines = renderer?.render({
      toolName: BROWSER_TOOL_NAMES.observe,
      args: {},
      result: result(`Careers${String.fromCharCode(27)}[31m page`, { title: "Careers\npage" }),
    });
    for (const line of lines ?? []) {
      expect(line).not.toContain(String.fromCharCode(27));
      expect(line).not.toContain("\n");
    }
  });
});
