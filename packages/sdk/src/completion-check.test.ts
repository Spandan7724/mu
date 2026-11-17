import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { z } from "zod";
import { Agent } from "./agent.ts";
import {
  COMPLETION_CHECK_TYPE,
  completionPrompt,
  completionScope,
  parseVerdict,
} from "./completion-check.ts";
import { tool } from "./tool.ts";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};
const user = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 0,
});
const answer = (text: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  model: "fake/fake-1",
  usage,
  stopReason: "end",
  timestamp: 0,
});
const call = (name: string, text = ""): AgentMessage => ({
  role: "assistant",
  content: [
    ...(text ? [{ type: "text" as const, text }] : []),
    { type: "toolCall" as const, id: `c-${name}`, name, arguments: {} },
  ],
  model: "fake/fake-1",
  usage,
  stopReason: "toolUse",
  timestamp: 0,
});
const result = (name: string): AgentMessage => ({
  role: "toolResult",
  toolCallId: `c-${name}`,
  toolName: name,
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 0,
});

describe("completionScope", () => {
  test("a task spans hand-offs and steers until an answer closes it", () => {
    const messages = [
      answer("Hi, how can I help?"),
      user("apply to all 21 jobs listed below: 1. A … 21. U"),
      call("navigate"),
      result("navigate"),
      call("handoff", "A needs sign-in."),
      result("handoff"),
      user("skip this one"),
      call("navigate"),
      result("navigate"),
      user("skip this one too"),
      call("edit"),
      result("edit"),
      answer("Skipped F too. Submitted: A. Skipped: C, D, F."),
    ];
    const scope = completionScope(messages);
    expect(scope).toMatchObject({
      requests: [
        "apply to all 21 jobs listed below: 1. A … 21. U",
        "skip this one",
        "skip this one too",
      ],
      answer: "Skipped F too. Submitted: A. Skipped: C, D, F.",
      earlier: "Hi, how can I help?",
    });
    expect(scope?.steps.map((step) => ("user" in step ? "user" : step.action))).toEqual([
      "user",
      "navigate {} → ok",
      "handoff {} → ok",
      "user",
      "navigate {} → ok",
      "user",
      "edit {} → ok",
    ]);
  });

  test("a run that did not end with an answer is not checked", () => {
    expect(completionScope([user("do it"), call("handoff", "sign in please")])).toBeUndefined();
    expect(completionScope([user("do it"), call("x"), result("x")])).toBeUndefined();
  });

  test("a plain reply to one message is not checked", () => {
    expect(
      completionScope([answer("done"), user("what's the status?"), answer("6 of 21")]),
    ).toBeUndefined();
  });

  test("a compaction summary bounds the task and travels as context", () => {
    const summary: AgentMessage = {
      role: "custom",
      customType: "compaction-summary",
      content: [{ type: "text", text: "Task: apply to 21 jobs; 1–4 done." }],
      timestamp: 0,
    };
    const scope = completionScope([
      user("old"),
      summary,
      user("continue"),
      call("x"),
      result("x"),
      answer("done"),
    ]);
    expect(scope?.requests).toEqual(["continue"]);
    expect(scope?.earlier).toBe("Task: apply to 21 jobs; 1–4 done.");
  });

  test("the user interrupting closes the task", () => {
    const interrupted: AgentMessage = {
      role: "custom",
      customType: "interrupted",
      content: [{ type: "text", text: "The user interrupted this run here." }],
      timestamp: 0,
    };
    const scope = completionScope([
      user("apply to all 21 jobs"),
      call("read"),
      result("read"),
      interrupted,
      user("what order are skills loaded in?"),
      call("read"),
      result("read"),
      answer("Explicitly named skills first."),
    ]);
    expect(scope?.requests).toEqual(["what order are skills loaded in?"]);
  });

  test("the prompt keeps the first request, the latest ones and the latest actions", () => {
    const steps = [
      { user: "FIRST" },
      ...Array.from({ length: 40 }, (_, i) => [
        { user: `${i}`.padEnd(1_000, "x") },
        { action: `step-${i} ${"y".repeat(300)}` },
      ]).flat(),
    ];
    const requests = steps.flatMap((step) => ("user" in step ? [step.user] : []));
    const prompt = completionPrompt({ requests, steps, answer: "done" });
    expect(prompt).toContain("FIRST");
    expect(prompt).toContain("39xxx");
    expect(prompt).toContain("step-39");
    expect(prompt).not.toContain("step-0 ");
    expect(prompt).toContain("user messages omitted");
    expect(prompt).toContain('<agent_actions untrusted="true">');
  });
});

describe("parseVerdict", () => {
  test("reads the three verdicts and ignores anything else", () => {
    expect(parseVerdict('{"status":"complete"}')).toEqual({ status: "complete" });
    expect(parseVerdict('```json\n{"status":"waiting"}\n```')).toEqual({ status: "waiting" });
    expect(parseVerdict('{"status":"incomplete","remaining":"jobs 7–21"}')).toEqual({
      status: "incomplete",
      remaining: "jobs 7–21",
    });
    expect(parseVerdict("I think it is done")).toBeUndefined();
    expect(parseVerdict('{"status":"maybe"}')).toBeUndefined();
  });
});

describe("Agent completion check", () => {
  const work = tool({
    name: "work",
    description: "does one item",
    inputSchema: z.object({}),
    execute: () => "done",
  });
  const workCall = {
    content: [{ type: "toolCall" as const, id: "w1", name: "work", arguments: {} }],
  };
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

  test("sends the agent back once when the check finds work left", async () => {
    const provider = new FakeProvider([
      workCall,
      text("Did item 1."),
      text('{"status":"incomplete","remaining":"items 2 and 3"}'),
      workCall,
      text("Did items 2 and 3."),
    ]);
    const agent = new Agent({ provider, model: fakeModel, tools: [work], completionCheck: true });
    const run = await agent.run("do items 1, 2 and 3");

    expect(provider.callCount).toBe(5);
    expect(run.text).toBe("Did items 2 and 3.");
    const reminder = run.messages.find(
      (message) => message.role === "custom" && message.customType === COMPLETION_CHECK_TYPE,
    );
    expect(JSON.stringify(reminder)).toContain("items 2 and 3");
    const check = provider.requests[2];
    expect(check?.tools ?? []).toEqual([]);
    expect(JSON.stringify(check?.messages)).toContain("do items 1, 2 and 3");
    expect(JSON.stringify(check?.messages)).toContain("Did item 1.");
    expect(JSON.stringify(check?.messages)).toContain("work {} → done");
    expect(agent.costReport().lines.some((line) => line.source === "completion-check")).toBe(true);
  });

  test("ends the run when the check says complete or cannot decide", async () => {
    for (const verdict of ['{"status":"complete"}', "no idea", '{"status":"waiting"}']) {
      const provider = new FakeProvider([workCall, text("All done."), text(verdict)]);
      const agent = new Agent({ provider, model: fakeModel, tools: [work], completionCheck: true });
      const run = await agent.run("do the item");
      expect(provider.callCount).toBe(3);
      expect(run.text).toBe("All done.");
    }
  });

  test("is off unless asked for", async () => {
    const provider = new FakeProvider([workCall, text("All done.")]);
    const agent = new Agent({ provider, model: fakeModel, tools: [work] });
    await agent.run("do the item");
    expect(provider.callCount).toBe(2);
  });
});
