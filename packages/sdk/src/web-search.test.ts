import { describe, expect, test } from "bun:test";
import type { Provider } from "@mu/ai";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";
import { resolveWebSearchBackend } from "./web-search.ts";

describe("web search backend", () => {
  test("resolves hosted modes into provider-neutral tool specs", () => {
    const provider = { capabilities: { hostedWebSearch: true }, id: "openai" } as Provider;

    expect(resolveWebSearchBackend(provider, { mode: "disabled" })).toEqual({ kind: "disabled" });
    expect(resolveWebSearchBackend(provider, { mode: "cached" })).toMatchObject({
      kind: "hosted",
      tool: { type: "web_search", externalWebAccess: false },
    });
    expect(resolveWebSearchBackend(provider, { mode: "indexed" })).toMatchObject({
      kind: "hosted",
      tool: { externalWebAccess: true, indexedWebAccess: true },
    });
    expect(
      resolveWebSearchBackend(provider, {
        mode: "live",
        allowedDomains: ["example.com"],
        userLocation: { country: "US", city: "Seattle" },
        searchContextSize: "high",
      }),
    ).toEqual({
      kind: "hosted",
      tool: {
        type: "web_search",
        externalWebAccess: true,
        filters: { allowedDomains: ["example.com"] },
        userLocation: { type: "approximate", country: "US", city: "Seattle" },
        searchContextSize: "high",
      },
    });
  });

  test("makes unsupported providers explicit", () => {
    const provider = { id: "anthropic" } as Provider;
    expect(resolveWebSearchBackend(provider, { mode: "live" })).toEqual({
      kind: "unavailable",
      provider: "anthropic",
    });
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
    const agent = new Agent({ provider, model: fakeModel, webSearch: { mode: "cached" } });
    const events: string[] = [];
    agent.subscribe((event) => {
      events.push(event.type);
    });

    await agent.run("search");

    expect(provider.requests[0]?.hostedTools).toEqual([
      { type: "web_search", externalWebAccess: false },
    ]);
    expect(events).toContain("web_search_start");
    expect(events).toContain("web_search_end");
  });

  test("per-run tool restrictions include hosted search only when named", async () => {
    const base = new FakeProvider([
      { content: [{ type: "text", text: "without" }] },
      { content: [{ type: "text", text: "with" }] },
    ]);
    const provider = Object.assign(base, { capabilities: { hostedWebSearch: true } });
    const agent = new Agent({ provider, model: fakeModel, webSearch: { mode: "live" } });

    await agent.run("without search", { allowedTools: [] });
    await agent.run("with search", { allowedTools: ["web_search"] });

    expect(provider.requests[0]?.hostedTools).toBeUndefined();
    expect(provider.requests[1]?.hostedTools).toEqual([
      { type: "web_search", externalWebAccess: true },
    ]);
  });

  test("fails rather than silently omitting search on an unsupported provider", async () => {
    const provider = new FakeProvider([]);
    const agent = new Agent({ provider, model: fakeModel, webSearch: { mode: "live" } });
    await expect(agent.run("search")).rejects.toThrow("not available for provider fake");
    expect(provider.callCount).toBe(0);
  });
});
