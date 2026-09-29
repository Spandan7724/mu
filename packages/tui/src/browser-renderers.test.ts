import { expect, test } from "bun:test";
import type { ToolResultMessage } from "@mu/core";
import { browserRenderers } from "./browser-renderers.ts";
import { RendererRegistry } from "./registry.ts";

const ctx = { width: 120, depth: "none" as const };

function result(details: unknown, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "click",
    content: [
      {
        type: "text",
        text: 'clicked button "Send" [e14]\n\n[page] Inbox\n<page_content untrusted="true">\n- button "Compose" [ref=e2]\n</page_content>',
      },
    ],
    details,
    isError,
    timestamp: 1,
  };
}

test("an action renders as one row: verb, target, host, duration", () => {
  const registry = new RendererRegistry();
  registry.registerAll(browserRenderers);
  const lines = registry.render(
    {
      toolName: "click",
      args: { ref: "e14" },
      result: result({
        ok: true,
        summary: 'clicked button "Send" [e14]',
        details: { url: "https://mail.google.com/mail/u/0/", timings: { totalMs: 182.4 } },
        commit: { id: "c1" },
      }),
    },
    ctx,
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('click button "Send" [e14]');
  expect(lines[0]).toContain("mail.google.com · 182 ms · committed");
  const expanded = registry.render(
    {
      toolName: "click",
      args: { ref: "e14" },
      result: result({ summary: "clicked" }),
      expanded: true,
    },
    ctx,
  );
  expect(expanded.join("\n")).toContain('button "Compose" [ref=e2]');
});

test("running calls show their target from the arguments; failures are marked", () => {
  const registry = new RendererRegistry();
  registry.registerAll(browserRenderers);
  const running = registry.render(
    { toolName: "navigate", args: { url: "gmail.com" }, running: true },
    ctx,
  );
  expect(running[0]).toContain("navigate gmail.com");
  expect(running[0]).toContain("running");
  const failed = registry.render(
    {
      toolName: "click",
      args: { ref: "e2" },
      result: result(
        {
          ok: false,
          summary: 'did not click button "Buy" [e2]: it is covered by region "Cookies"',
        },
        true,
      ),
    },
    ctx,
  );
  expect(failed[0]).toContain('button "Buy" [e2]: it is covered by region "Cookies"');
});
