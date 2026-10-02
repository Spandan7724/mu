import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { LlmContext, ModelInfo, Provider, StreamOpts } from "@mu/ai";
import { type AgentMessage, permissionPreviewLines } from "@mu/core";
import { FakeProvider, fakeModel, type ScriptedTurn } from "@mu/core/testing/fake-provider.ts";
import {
  Agent,
  ExtensionHost,
  optionsFromProfile,
  type SubagentDetails,
  subagentsExtension,
} from "mu";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(60_000);

type Script = (turn: number) => ScriptedTurn;

// Answers each conversation from its own script (picked by its user messages),
// so concurrent children cannot take each other's scripted turns.
class RoutingProvider implements Provider {
  readonly id = "fake";
  readonly log: string[] = [];
  readonly contexts = new Map<string, LlmContext>();
  constructor(private readonly scripts: Record<string, Script>) {}

  stream(model: ModelInfo, ctx: LlmContext, opts?: StreamOpts) {
    const text = JSON.stringify(ctx.messages.filter((message) => message.role === "user"));
    const name = Object.keys(this.scripts).find((key) => text.includes(key)) ?? "";
    const turn = ctx.messages.filter((message) => message.role === "assistant").length;
    this.log.push(`${name}:${turn}`);
    this.contexts.set(`${name}:${turn}`, ctx);
    const script = this.scripts[name] ?? (() => ({ content: [{ type: "text", text: "" }] }));
    return new FakeProvider([script(turn)]).stream(model, ctx, opts);
  }
}

const call = (id: string, name: string, args: Record<string, unknown>): ScriptedTurn => ({
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const say = (text: string): ScriptedTurn => ({ content: [{ type: "text", text }] });

function toolText(messages: AgentMessage[], name: string): string {
  return messages
    .filter((message) => message.role === "toolResult" && message.toolName === name)
    .map((message) =>
      message.role === "toolResult"
        ? message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
        : "",
    )
    .join("\n");
}

describeWithBrowser("parallel browser sub-tasks", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;

  beforeAll(async () => {
    site = startFixtureSite();
    profile = await browserProfile({
      home,
      workspace: home,
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

  test("two task calls run at once, each in its own tabs with its own notes, sharing the ledger", async () => {
    const child =
      (brief: string, page: string, note: string): Script =>
      (turn) =>
        [
          call(`${brief}-nav`, "navigate", { url: site.url(page) }),
          call(`${brief}-note`, "notes", { action: "append", text: note }),
          call(`${brief}-tabs`, "tabs", { action: "list" }),
          say(`${brief} finished`),
        ][turn] ?? say("");
    const provider = new RoutingProvider({
      "PARENT-REQUEST": (turn) =>
        turn === 0
          ? {
              content: [
                {
                  type: "toolCall",
                  id: "t1",
                  name: "task",
                  arguments: { description: "form item", prompt: "FORM-BRIEF: fill the form" },
                },
                {
                  type: "toolCall",
                  id: "t2",
                  name: "task",
                  arguments: {
                    description: "review item",
                    prompt: "REVIEW-BRIEF: read the review",
                  },
                },
              ],
            }
          : say("both items done"),
      "FORM-BRIEF": child("FORM-BRIEF", "form-basic", "form note"),
      "REVIEW-BRIEF": child("REVIEW-BRIEF", "review", "review note"),
    });
    const host = new ExtensionHost();
    const options = await optionsFromProfile(profile, "fake/fake-1", {
      provider,
      model: fakeModel,
      extensions: host,
    });
    const agent = new Agent({
      ...options,
      permissions: [{ permission: "*", pattern: "*", action: "allow" }],
    });
    await host.register(
      subagentsExtension({
        parent: () => agent,
        ...(profile.subagents?.taskSession ? { taskSession: profile.subagents.taskSession } : {}),
      }),
    );

    const result = await agent.run("PARENT-REQUEST: do both items in parallel");
    expect(result.text).toBe("both items done");

    // Both children asked the model for their first step before either finished.
    const firstSteps = [
      provider.log.indexOf("FORM-BRIEF:0"),
      provider.log.indexOf("REVIEW-BRIEF:0"),
    ];
    const lastSteps = [
      provider.log.indexOf("FORM-BRIEF:3"),
      provider.log.indexOf("REVIEW-BRIEF:3"),
    ];
    expect(Math.max(...firstSteps)).toBeLessThan(Math.min(...lastSteps));

    const children = result.messages
      .filter((message) => message.role === "toolResult" && message.toolName === "task")
      .map((message) =>
        message.role === "toolResult" ? (message.details as SubagentDetails) : undefined,
      );
    const [form, review] = ["form item", "review item"].map(
      (description) =>
        children.find((details) => details?.description === description)?.messages ?? [],
    ) as [AgentMessage[], AgentMessage[]];
    expect(toolText(form, "navigate")).toContain("Send message");
    expect(toolText(review, "navigate")).toContain("Submit application");
    const tabOf = (messages: AgentMessage[]) =>
      /^\* (t\d+) /m.exec(toolText(messages, "tabs"))?.[1];
    expect(toolText(form, "tabs").match(/^[* ] t\d+ /gm)).toHaveLength(1);
    expect(toolText(review, "tabs").match(/^[* ] t\d+ /gm)).toHaveLength(1);
    expect(tabOf(form)).not.toBe(tabOf(review));
    const formContext = JSON.stringify(provider.contexts.get("FORM-BRIEF:0"));
    expect(formContext).toContain("subTask: form item");
    expect(formContext).not.toContain("PARENT-REQUEST");

    // Notes stay with each sub-task; the tabs they left open are handed to the main agent.
    expect(profile.notes.entries()).toEqual([]);
    expect(
      profile.browser
        .tabs()
        .filter((tab) => tab.leftBy)
        .map((tab) => tab.leftBy)
        .sort(),
    ).toEqual(["form item", "review item"]);
  });

  test("a sub-task's approvals name it, and what it sends lands in the session's ledger", async () => {
    const taskSession = profile.subagents?.taskSession;
    if (!taskSession) throw new Error("no task session");
    const session = await taskSession("send the contact form", AbortSignal.timeout(10_000));
    const tools = new Map(session.tools.map((candidate) => [candidate.name, candidate]));
    const run = async (id: string, name: string, args: Record<string, unknown>) =>
      toolText(
        [
          {
            role: "toolResult",
            toolCallId: id,
            toolName: name,
            ...(await tools.get(name)?.execute(id, args, AbortSignal.timeout(15_000))),
          } as AgentMessage,
        ],
        name,
      );
    const page = await run("n1", "navigate", { url: site.url("form-basic") });
    const ref = /button "Send message" \[ref=(e\d+)\]/.exec(page)?.[1];
    const details = await tools.get("click")?.permissionDetails?.({ ref, commit: true });
    expect(permissionPreviewLines(details?.preview)[0]).toBe("sub-task: send the contact form");
    await run("c1", "click", { ref, commit: true });
    expect(profile.ledger.records().map((record) => record.id)).toContain("c1");
    await session.close();
  });
});
