import { expect, test } from "bun:test";
import type { ToolResultMessage } from "@mu/core";
import { App } from "./app.ts";
import { browserRenderers } from "./browser-renderers.ts";
import { InputDecoder } from "./input.ts";
import { RendererRegistry, subagentRenderers } from "./registry.ts";
import { stripAnsi } from "./style.ts";
import { stringWidth } from "./width.ts";

const ctx = { width: 120, depth: "none" as const };
const GMAIL = "https://mail.google.com/mail/u/0/#inbox";
const THREAD = "https://mail.google.com/mail/u/0/#inbox/FMfcgz";

function result(details: unknown, isError = false, toolName = "click"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "c1",
    toolName,
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

function outcome(summary: string, url: string, title: string, extra: object = {}) {
  return {
    ok: true,
    summary,
    details: { url, title, tabId: "t1", timings: { totalMs: 200 } },
    ...extra,
  };
}

function browserRegistry(): RendererRegistry {
  const registry = new RendererRegistry();
  registry.registerAll(browserRenderers);
  return registry;
}

test("an action renders as one row: verb, target, host, duration", () => {
  const registry = browserRegistry();
  const lines = registry.render(
    {
      toolName: "click",
      args: { ref: "e14" },
      result: result({
        ok: true,
        summary: 'clicked button "Compose" [e14]',
        details: { url: "https://mail.google.com/mail/u/0/", timings: { totalMs: 182.4 } },
      }),
    },
    ctx,
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('click button "Compose" [e14]');
  expect(lines[0]).toContain("mail.google.com · 182 ms");
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

test("a commit is a loud row led by the control's name and what it sent", () => {
  const registry = browserRegistry();
  const info = {
    toolName: "click",
    args: { ref: "e14", commit: true },
    result: result(
      outcome('clicked button "Send" [e14]', THREAD, "Re: Standup", {
        commit: {
          id: "c1",
          host: "mail.google.com",
          target: 'button "Send" [e14]',
          name: "Send",
          sends: ["To: Alex <alex@example.com>", "Subject: Re: Standup", "Message: Hi"],
        },
      }),
    ),
  };
  const [row] = registry.render(info, ctx);
  expect(row).toBe(
    "  │ ● Send To: Alex <alex@example.com> · Subject: Re: Standup · ✓ mail.google.com · 200 ms",
  );
  expect(registry.activityKind(info)).toBeUndefined();
  const [bare] = registry.render(
    { ...info, result: result({ summary: 'clicked button "Buy" [e2]', commit: { id: "c2" } }) },
    ctx,
  );
  expect(bare).toBe('  │ ● committed button "Buy" [e2] · ✓');
});

test("running calls show their target from the arguments; failures are marked", () => {
  const registry = browserRegistry();
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

test("calls group by page visit and the header says what happened there", () => {
  const registry = browserRegistry();
  const call = (toolName: string, args: object, url: string, title: string, isError = false) => ({
    toolName,
    args,
    result: result(outcome(`${toolName}ed`, url, title), isError, toolName),
  });
  const inbox = call("navigate", { url: "gmail.com" }, GMAIL, "Inbox (3)");
  const search = call(
    "find",
    { text: "Alex" },
    "https://mail.google.com/mail/u/0/?q=1#inbox",
    "Inbox (3)",
  );
  const thread = call("click", { ref: "e41" }, THREAD, "Standup moved");
  expect(registry.activityKind(inbox)).toBe("browse");
  expect(registry.activityGroup(inbox)).toBe(registry.activityGroup(search));
  expect(registry.activityGroup(inbox)).not.toBe(registry.activityGroup(thread));
  const visit = [
    thread,
    call("click", { ref: "e88" }, THREAD, "Standup moved"),
    call("type", { ref: "e93", text: "hi" }, THREAD, "Standup moved"),
    call("fill_form", { fields: [{}, {}] }, THREAD, "Standup moved"),
    call("click", { ref: "e99" }, THREAD, "Standup moved", true),
  ];
  expect(stripAnsi(registry.activitySummary("browse", visit, "none"))).toBe(
    "mail.google.com  Standup moved — 2 clicks, typed into 1 field, filled 2 fields · 5 actions · 1 failed · 1.0s",
  );
  expect(registry.activityKind({ toolName: "notes", args: {} })).toBeUndefined();
});

test("the App folds a visit and leaves the commit outside it", () => {
  const app = new App({
    width: 120,
    depth: "none",
    model: "fake/fake-1",
    cwd: "~",
    contextWindow: 1000,
    registry: browserRegistry(),
    callbacks: {
      onSubmit: () => {},
      onAbort: () => {},
      onExit: () => {},
    },
  });
  const complete = (id: string, toolName: string, args: object, details: unknown) => {
    app.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName, args });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: id,
      result: { ...result(details, false, toolName), toolCallId: id },
    });
  };
  complete("n1", "navigate", { url: "gmail.com" }, outcome("navigated to Inbox", GMAIL, "Inbox"));
  complete("f1", "find", { text: "Alex" }, outcome('find "Alex"', GMAIL, "Inbox"));
  complete("c1", "click", { ref: "e41" }, outcome("clicked link", THREAD, "Standup"));
  complete("c2", "click", { ref: "e88" }, outcome("clicked button", THREAD, "Standup"));
  complete(
    "c3",
    "click",
    { ref: "e97" },
    outcome('clicked button "Send" [e97]', THREAD, "Standup", {
      commit: { id: "c3", host: "mail.google.com", name: "Send", sends: ["To: alex@example.com"] },
    }),
  );
  const transcript = app.renderTranscript().map(stripAnsi);
  expect(transcript).toContain("  › mail.google.com  Inbox — opened, read · 2 actions · 400ms");
  expect(transcript).toContain("  › mail.google.com  Standup — 2 clicks · 2 actions · 400ms");
  expect(transcript).toContain("  › ● Send To: alex@example.com · ✓ mail.google.com · 200 ms");
  expect(app.renderScreen().map(stripAnsi)).toContain("  mail.google.com · Standup");
});

test("a running sub-task shows where its browser is and what it is doing", () => {
  const registry = browserRegistry();
  registry.registerAll(subagentRenderers);
  const lever = "https://jobs.lever.co/acme/apply";
  const step = (id: string, name: string, args: object) => ({
    role: "assistant" as const,
    content: [{ type: "toolCall" as const, id, name, arguments: args }],
    model: "m",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "toolUse" as const,
    timestamp: 1,
  });
  const messages = [
    step("n1", "navigate", { url: lever }),
    {
      ...result(outcome("navigated to Acme — Apply", lever, "Acme — Apply"), false, "navigate"),
      toolCallId: "n1",
    },
    step("u1", "upload", { ref: "e7", paths: ["resume.pdf"] }),
  ];
  const lines = registry
    .render(
      {
        toolName: "task",
        args: { description: "Apply to Acme" },
        running: true,
        elapsedMs: 41_000,
        progress: {
          type: "subagent-progress-state",
          kind: "task",
          description: "Apply to Acme",
          model: "m",
          thinkingLevel: "low",
          messages,
          answer: "",
        },
      },
      { ...ctx, spinnerFrame: 0 },
    )
    .map(stripAnsi);
  expect(lines).toEqual([
    "  │ ⠋ Apply to Acme · 2 actions · 41s",
    "  │ jobs.lever.co · Acme — Apply · upload e7",
  ]);
});

test("a hand-off is its own row and leaves the session waiting on the user", () => {
  const app = new App({
    width: 100,
    depth: "none",
    model: "fake/fake-1",
    cwd: "~",
    contextWindow: 1000,
    registry: browserRegistry(),
    callbacks: { onSubmit: () => {}, onAbort: () => {}, onExit: () => {} },
  });
  const args = { reason: "sign in to linkedin.com" };
  app.handleEvent({ type: "agent_start" });
  app.handleEvent({ type: "tool_execution_start", toolCallId: "h1", toolName: "handoff", args });
  app.handleEvent({
    type: "tool_execution_end",
    toolCallId: "h1",
    result: {
      ...result(
        { handoff: { reason: args.reason, host: "www.linkedin.com", tabId: "t1" } },
        false,
        "handoff",
      ),
      toolCallId: "h1",
    },
  });
  app.handleEvent({ type: "agent_end", messages: [], reason: "done" });
  const transcript = app.renderTranscript().map(stripAnsi);
  expect(transcript).toContain("  › ◆ your turn sign in to linkedin.com · www.linkedin.com");
  expect(transcript).toContain("  │ mu continues once the page moves on, or when you reply");
  const waiting = "  ◆ waiting on you: sign in to linkedin.com · reply when done";
  expect(app.renderScreen().map(stripAnsi)).toContain(waiting);
  app.handleEvent({ type: "agent_start" });
  expect(app.renderScreen().map(stripAnsi)).not.toContain(waiting);
});

test("a commit row never wraps past the width", () => {
  const registry = browserRegistry();
  const [row, ...rest] = registry.render(
    {
      toolName: "click",
      args: { ref: "e97" },
      result: result(
        outcome('clicked button "Send" [e97]', THREAD, "Standup", {
          commit: { id: "c", name: "Send", sends: ["To: someone-with-a-long-address@example.com"] },
        }),
      ),
    },
    { width: 60, depth: "none" },
  );
  expect(rest).toEqual([]);
  expect(stringWidth(row ?? "")).toBeLessThanOrEqual(60);
});

test("thinking between calls on one page stays inside the visit; routine compaction is silent", () => {
  const app = new App({
    width: 120,
    depth: "none",
    model: "fake/fake-1",
    cwd: "~",
    contextWindow: 1000,
    registry: browserRegistry(),
    callbacks: { onSubmit: () => {}, onAbort: () => {}, onExit: () => {} },
  });
  const complete = (id: string, toolName: string, details: unknown) => {
    app.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName, args: {} });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: id,
      result: { ...result(details, false, toolName), toolCallId: id },
    });
  };
  const think = (text: string, speech = "") =>
    app.handleEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text },
          ...(speech ? [{ type: "text" as const, text: speech }] : []),
        ],
        model: "m",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "toolUse",
        timestamp: 1,
      },
    });
  complete("n1", "navigate", outcome("navigated to Inbox", GMAIL, "Inbox"));
  app.handleEvent({ type: "compaction_start", layer: 1 });
  app.handleEvent({ type: "compaction_end", layer: 1, tokensFreed: 44 });
  think("Looking for Alex");
  complete("f1", "find", outcome('find "Alex"', GMAIL, "Inbox"));
  let transcript = app.renderTranscript().map(stripAnsi);
  expect(transcript).toContain("  › mail.google.com  Inbox — opened, read · 2 actions · 400ms");
  expect(transcript.join("\n")).not.toContain("Context compacted");
  expect(transcript.join("\n")).not.toContain("thinking");

  for (const event of new InputDecoder().push("\u000f")) app.handleInput(event);
  app.handleInput({ type: "key", key: { name: "return", ctrl: false, alt: false, shift: false } });
  expect(app.renderScreen().map(stripAnsi).join("\n")).toContain("thinking · Looking for Alex");

  think("Done here", "Found it.");
  complete("f2", "find", outcome('find "Bob"', GMAIL, "Inbox"));
  transcript = app.renderTranscript().map(stripAnsi);
  expect(transcript).toContain("  mu  Found it.");
  expect(transcript.filter((line) => line.includes("mail.google.com  Inbox"))).toHaveLength(1);
});

test("a step commit is an ordinary row inside its visit; a final one warns when nothing changed", () => {
  const registry = browserRegistry();
  const step = {
    toolName: "click",
    args: { ref: "e50" },
    result: result(
      outcome('clicked button "Checkout" [e50]', THREAD, "Cart", {
        commit: { id: "c1", name: "Checkout", strength: "step" },
      }),
    ),
  };
  expect(registry.render(step, ctx)[0]).toBe(
    '  │ click button "Checkout" [e50] · ✓ mail.google.com · 200 ms · committed',
  );
  expect(registry.activityKind(step)).toBe("browse");
  const stalled = {
    toolName: "click",
    args: { ref: "e70" },
    result: result(
      outcome('clicked button "Finish" [e70] (no visible change)', THREAD, "Overview", {
        kind: "no-change",
        commit: { id: "c2", name: "Finish", target: 'button "Finish" [e70]', strength: "final" },
      }),
    ),
  };
  expect(registry.render(stalled, ctx)[0]).toBe(
    "  │ ● Finish · no visible change · mail.google.com · 200 ms",
  );
  expect(registry.activityKind(stalled)).toBeUndefined();
});
