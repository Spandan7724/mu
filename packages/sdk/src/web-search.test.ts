import { describe, expect, test } from "bun:test";
import type { Provider } from "@mu/ai";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";
import { resolveWebSearchBackend } from "./web-search.ts";

describe("web search backend", () => {
  test("automatically selects hosted search from provider capabilities", () => {
    const openai = { capabilities: { hostedWebSearch: true }, id: "openai" } as Provider;
    const anthropic = { id: "anthropic" } as Provider;

    expect(resolveWebSearchBackend(openai)).toEqual({
      kind: "hosted",
      tool: { type: "web_search" },
    });
    expect(resolveWebSearchBackend(anthropic)).toEqual({ kind: "disabled" });
  });

  test("threads hosted search through Agent and emits native activity", async () => {
    const base = new FakeProvider([
      {
        content: [
          {
            type: "webSearch",
            id: "ws_1",
            status: "completed",
            action: { type: "search", query: "mu agent" },
          },
          { type: "text", text: "found it" },
        ],
      },
    ]);
    const provider = Object.assign(base, { capabilities: { hostedWebSearch: true } });
    const agent = new Agent({ provider, model: fakeModel });
    const events: string[] = [];
    agent.subscribe((event) => {
      events.push(event.type);
    });

    await agent.run("search");

    expect(provider.requests[0]?.hostedTools).toEqual([{ type: "web_search" }]);
    expect(events).toContain("web_search_start");
    expect(events).toContain("web_search_end");
  });

  test("per-run tool restrictions include hosted search only when named", async () => {
    const base = new FakeProvider([
      { content: [{ type: "text", text: "without" }] },
      { content: [{ type: "text", text: "with" }] },
    ]);
    const provider = Object.assign(base, { capabilities: { hostedWebSearch: true } });
    const agent = new Agent({ provider, model: fakeModel });

    await agent.run("without search", { allowedTools: [] });
    await agent.run("with search", { allowedTools: ["web_search"] });

    expect(provider.requests[0]?.hostedTools).toBeUndefined();
    expect(provider.requests[1]?.hostedTools).toEqual([{ type: "web_search" }]);
  });

  test("runs normally without search on an unsupported provider", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "no search" }] }]);
    const agent = new Agent({ provider, model: fakeModel });

    await agent.run("answer normally");

    expect(provider.requests[0]?.hostedTools).toBeUndefined();
  });
});
