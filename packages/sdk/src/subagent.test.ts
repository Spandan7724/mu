// The subagent pattern from examples/subagent.ts, driven by fake providers so
// it is verified rather than merely documented.
import { describe, expect, test } from "bun:test";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { tool } from "./tool.ts";

describe("subagent inside a tool", () => {
  test("a child Agent answers and the parent synthesizes", async () => {
    const childProvider = new FakeProvider([
      { content: [{ type: "text", text: "Denmark leans on wind." }] },
    ]);
    const parentProvider = new FakeProvider([
      {
        content: [
          { type: "toolCall", id: "c1", name: "research", arguments: { question: "Denmark?" } },
        ],
      },
      { content: [{ type: "text", text: "Synthesis: wind dominates." }] },
    ]);

    const research = tool({
      name: "research",
      description: "Delegate a question to a subagent",
      inputSchema: z.object({ question: z.string() }),
      execute: async ({ question }, { signal }) => {
        const child = new Agent({ provider: childProvider, model: fakeModel });
        signal.addEventListener("abort", () => child.abort(), { once: true });
        const result = await child.run(question);
        return result.text;
      },
    });

    const lead = new Agent({
      provider: parentProvider,
      model: fakeModel,
      tools: [research],
    });
    const result = await lead.run("compare energy mixes");

    expect(result.text).toBe("Synthesis: wind dominates.");
    const delegated = result.messages.find((m) => m.role === "toolResult");
    expect(
      delegated?.role === "toolResult" &&
        delegated.content[0]?.type === "text" &&
        delegated.content[0].text,
    ).toBe("Denmark leans on wind.");
    expect(childProvider.callCount).toBe(1);
  });

  test("aborting the parent aborts the child", async () => {
    const childProvider = new FakeProvider([
      { content: [{ type: "text", text: "too late" }], delayMs: 80 },
    ]);
    const parentProvider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "research", arguments: { question: "q" } }] },
      { content: [{ type: "text", text: "unused" }] },
    ]);

    let childReason: string | undefined;
    const research = tool({
      name: "research",
      description: "Delegate a question to a subagent",
      inputSchema: z.object({ question: z.string() }),
      execute: async ({ question }, { signal }) => {
        const child = new Agent({ provider: childProvider, model: fakeModel });
        signal.addEventListener("abort", () => child.abort(), { once: true });
        const result = await child.run(question);
        childReason = result.reason;
        return result.text;
      },
    });

    const lead = new Agent({ provider: parentProvider, model: fakeModel, tools: [research] });
    const running = lead.run("go");
    setTimeout(() => lead.abort(), 15);
    await running;

    expect(childReason).toBe("aborted");
  });

  test("the child's budget is independent of the parent's", async () => {
    const childProvider = new FakeProvider(
      Array.from({ length: 6 }, (_, i) => ({
        content: [{ type: "toolCall" as const, id: `k${i}`, name: "noop", arguments: {} }],
      })),
    );
    const parentProvider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "research", arguments: { question: "q" } }] },
      { content: [{ type: "text", text: "done anyway" }] },
    ]);

    const noop = tool({
      name: "noop",
      description: "noop",
      inputSchema: z.object({}),
      execute: () => "ok",
    });
    let childReason: string | undefined;
    const research = tool({
      name: "research",
      description: "Delegate",
      inputSchema: z.object({ question: z.string() }),
      execute: async ({ question }) => {
        const child = new Agent({
          provider: childProvider,
          model: fakeModel,
          tools: [noop],
          budget: { maxTurns: 2 },
        });
        const result = await child.run(question);
        childReason = result.reason;
        return `child halted: ${result.reason}`;
      },
    });

    const lead = new Agent({ provider: parentProvider, model: fakeModel, tools: [research] });
    const result = await lead.run("go");

    expect(childReason).toBe("maxTurns");
    expect(result.reason).toBe("done"); // parent unaffected by the child's ceiling
  });
});
