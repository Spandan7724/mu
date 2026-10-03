import { expect, test } from "bun:test";
import type { AgentMessage, CustomMessage } from "@mu/core";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tabs.ts";
import { Handoffs, handoffTool } from "./handoff.ts";

function fakeTab(url: string) {
  return { tabId: "t1", url, title: "Sign in", detached: false } as unknown as Tab & {
    url: string;
    title: string;
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness() {
  const woken: (string | CustomMessage)[] = [];
  const handoffs = new Handoffs(5);
  handoffs.attach({ emit: () => {}, followUp: (message) => void woken.push(message) });
  return { handoffs, woken };
}

test("the agent is woken once the page settles outside the sign-in flow", async () => {
  const { handoffs, woken } = harness();
  const tab = fakeTab("https://www.linkedin.com/login");
  handoffs.start(tab, "sign in to linkedin.com");
  tab.url = "https://www.linkedin.com/checkpoint/challenge/abc";
  await wait(40);
  expect(woken).toHaveLength(0);
  tab.url = "https://www.linkedin.com/feed/";
  tab.title = "Feed | LinkedIn";
  await wait(40);
  expect(woken).toHaveLength(1);
  const message = woken[0] as AgentMessage;
  expect(message.role).toBe("custom");
  expect(JSON.stringify(message)).toContain("https://www.linkedin.com/feed/");
  await wait(20);
  expect(woken).toHaveLength(1);
});

test("resuming first, or the tab going away, cancels the wake-up", async () => {
  const { handoffs, woken } = harness();
  const tab = fakeTab("https://accounts.google.com/v3/signin/identifier");
  handoffs.start(tab, "sign in to Google");
  handoffs.cancel();
  tab.url = "https://mail.google.com/mail/u/0/";
  await wait(40);
  expect(woken).toHaveLength(0);

  const closed = fakeTab("https://example.com/login");
  handoffs.start(closed, "sign in");
  (closed as unknown as { detached: boolean }).detached = true;
  closed.url = "https://example.com/home";
  await wait(40);
  expect(woken).toHaveLength(0);
});

test("handoff brings the tab forward, ends the turn and starts watching", async () => {
  const tab = fakeTab("https://www.linkedin.com/login");
  const activated: unknown[] = [];
  const browser = {
    activeTab: async () => tab,
    connection: {
      send: async (method: string, params: unknown) => void activated.push([method, params]),
    },
  } as unknown as BrowserManager;
  const { handoffs, woken } = harness();
  const result = await handoffTool(browser, handoffs).execute(
    "h1",
    { reason: "sign in to linkedin.com" },
    new AbortController().signal,
  );
  expect(result.terminate).toBe(true);
  expect(result.details).toMatchObject({
    handoff: { reason: "sign in to linkedin.com", host: "www.linkedin.com", tabId: "t1" },
  });
  expect(activated).toHaveLength(1);
  tab.url = "https://www.linkedin.com/feed/";
  await wait(40);
  expect(woken).toHaveLength(1);
});
