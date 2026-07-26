// Subagents need no framework: an Agent inside a tool's execute is the whole
// pattern. The child gets its own model, prompt, toolset and budget, and the
// parent sees only the text it returns.
//
//   bun examples/subagent.ts
import { Agent, tool } from "mu";
import { z } from "zod";

const research = tool({
  name: "research",
  description:
    "Delegate a self-contained research question to a focused subagent. Returns its findings as text.",
  inputSchema: z.object({
    question: z.string().describe("A single, self-contained question"),
  }),
  // Independent questions can be researched at the same time.
  isConcurrencySafe: () => true,
  execute: async ({ question }, { signal }) => {
    const child = new Agent({
      model: "anthropic/claude-sonnet-5",
      systemPrompt:
        "You are a research subagent. Answer the single question you are given, concisely and factually. Do not ask follow-up questions.",
      budget: { maxTurns: 4, maxCostUsd: 0.5 },
    });
    // Propagate cancellation: aborting the parent aborts the child.
    signal.addEventListener("abort", () => child.abort(), { once: true });

    const result = await child.run(question);
    if (result.reason !== "done") {
      return {
        content: [{ type: "text", text: `Subagent halted: ${result.reason}` }],
        isError: true,
      };
    }
    return result.text;
  },
});

const lead = new Agent({
  model: "anthropic/claude-opus-5",
  systemPrompt:
    "You coordinate research. Break the user's request into independent questions and delegate each with the research tool — issue independent questions in the same turn so they run concurrently. Then synthesize one answer.",
  tools: [research],
  budget: { maxCostUsd: 5 },
});

const result = await lead.run(
  "Compare the energy mix of France and Denmark, and say which is more carbon-intensive per kWh.",
);

console.log(result.text);
console.log(`\n[${result.reason}] $${result.usage.costUsd?.toFixed(4)}`);
