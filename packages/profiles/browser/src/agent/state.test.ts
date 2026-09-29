import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type AgentMessage, customMessage } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, FileSessionStore, optionsFromProfile } from "mu";
import { browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";
import { BrowserState, type CommitRecord, STATE_TYPE } from "./state.ts";

setDefaultTimeout(60_000);

const toolResult = (name: string, details: unknown): AgentMessage => ({
  role: "toolResult",
  toolCallId: name,
  toolName: name,
  content: [{ type: "text", text: name }],
  details,
  isError: false,
  timestamp: 1,
});

const commit = (id: string): CommitRecord => ({
  id,
  at: 1,
  host: "mail.test",
  url: "https://mail.test/",
  action: "click",
  target: 'button "Send" [e9]',
});

describe("browser state in the transcript", () => {
  test("rebuilds from the latest snapshot plus later tool results; snapshots only on change", () => {
    const state = new BrowserState();
    state.notes.replace("prices", "a: $1");
    state.ledger.append(commit("c1"));
    const [snapshot] = state.snapshotIfChanged([]);
    expect(snapshot).toMatchObject({
      role: "custom",
      customType: STATE_TYPE,
      retention: { key: "browser:state" },
    });
    const messages: AgentMessage[] = [
      snapshot as AgentMessage,
      toolResult("notes", { notes: [{ key: "prices", text: "a: $1\nb: $2" }] }),
      toolResult("click", { commit: commit("c2") }),
      toolResult("click", { commit: commit("c2") }),
    ];
    const rebuilt = new BrowserState();
    rebuilt.rebuild(messages);
    expect(rebuilt.notes.entries()).toEqual([{ key: "prices", text: "a: $1\nb: $2" }]);
    expect(rebuilt.ledger.records().map((record) => record.id)).toEqual(["c1", "c2"]);
    const next = rebuilt.snapshotIfChanged(messages);
    expect(next).toHaveLength(1);
    expect(rebuilt.snapshotIfChanged([...messages, ...next])).toEqual([]);
    expect(new BrowserState().snapshotIfChanged([customMessage("x", "y")])).toEqual([]);
  });
});

describeWithBrowser("notes and the commit ledger survive resume", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  beforeAll(() => {
    site = startFixtureSite();
  });
  afterAll(() => {
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("a send is recorded, persisted, and rebuilt by a fresh profile resuming the session", async () => {
    const options = {
      home,
      headless: true,
      keepOpen: true,
      vision: "off" as const,
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    };
    const store = new FileSessionStore({ root: join(home, "sessions"), scope: "browser-default" });
    const first = await browserProfile(options);
    const call = (id: string, name: string, args: Record<string, unknown>) => ({
      content: [{ type: "toolCall" as const, id, name, arguments: args }],
    });
    const provider = new FakeProvider([
      call("n1", "navigate", { url: site.url("mail-mock") }),
      call("n2", "click", { ref: "e2" }),
      call("n3", "fill_form", {
        fields: [
          { ref: "e10", value: "alex@example.com" },
          { ref: "e11", value: "Lunch" },
          { ref: "e12", value: "See you at noon" },
        ],
      }),
      call("n4", "click", { ref: "e13" }),
      call("n5", "notes", { action: "append", key: "sent", text: "emailed alex@example.com" }),
      { content: [{ type: "text", text: "Sent." }] },
    ]);
    const agent = new Agent(
      await optionsFromProfile(first, "fake/fake-1", {
        provider,
        model: fakeModel,
        session: store,
        onPermission: async () => "allow",
      }),
    );
    const result = await agent.run("Email Alex about lunch");
    expect(result.text).toBe("Sent.");
    const sendResult = result.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "n4",
    );
    expect(JSON.stringify(sendResult)).toContain("Message sent.");
    expect(first.ledger.records()).toHaveLength(1);
    expect(first.ledger.records()[0]).toMatchObject({
      action: "click",
      target: 'button "Send" [e13]',
    });
    const sessionId = agent.sessionId;
    await agent.shutdown();

    const second = await browserProfile(options);
    expect(second.ledger.records()).toEqual([]);
    const tree = await store.load(sessionId);
    if (!tree) throw new Error("session not saved");
    const resumed = new Agent(
      await optionsFromProfile(second, "fake/fake-1", {
        provider: new FakeProvider([{ content: [{ type: "text", text: "Already sent." }] }]),
        model: fakeModel,
        session: store,
      }),
    );
    resumed.resume(tree);
    await resumed.run("Did you send it?");
    expect(second.ledger.records().map((record) => record.id)).toEqual(["n4"]);
    expect(second.notes.entries()).toEqual([{ key: "sent", text: "emailed alex@example.com" }]);
    const stateMessage = resumed.session
      .messagesAt()
      .findLast((message) => message.role === "custom" && message.customType === STATE_TYPE);
    expect(JSON.stringify(stateMessage)).toContain("never repeat them");
    await second.browser.shutdown({ close: true });
  });
});
