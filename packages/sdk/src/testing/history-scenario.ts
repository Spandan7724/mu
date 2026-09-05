import { randomUUID } from "node:crypto";
import type { LlmContext, ModelInfo, Provider, StreamOpts } from "@mu/ai";
import { estimateTokens, type SessionStore } from "@mu/core";
import { FakeProvider, fakeModel, type ScriptedTurn } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "../agent.ts";

// This policy has no access to the expected answer. Every choice and answer is
// derived from the actual request, including the tool results returned by Mu.
class EvidencePolicy implements Provider {
  readonly id = "fake";
  readonly requests: LlmContext[] = [];
  recovering = false;

  stream(model: ModelInfo, context: LlmContext, options?: StreamOpts) {
    this.requests.push(structuredClone(context));
    const system =
      typeof context.systemPrompt === "string"
        ? context.systemPrompt
        : (context.systemPrompt?.map((section) => section.text).join("\n") ?? "");
    const texts = context.messages.flatMap((message) =>
      message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    );
    let turn: ScriptedTurn;
    const call = (name: string, args: Record<string, unknown>): ScriptedTurn => ({
      content: [{ type: "toolCall", id: `c${this.requests.length}`, name, arguments: args }],
    });
    if (system.includes("Summarize the conversation")) {
      turn = {
        content: [
          {
            type: "text",
            text: "The diagnostic was captured. Continue investigating the regression.",
          },
        ],
      };
    } else if (!this.recovering) {
      turn = context.messages.some((message) => message.role === "toolResult")
        ? { content: [{ type: "text", text: "Diagnostic captured." }] }
        : call("observe", {});
    } else {
      const answer = texts.join("\n").match(/original_nonce=([a-f0-9-]+)/)?.[1];
      const lookup = context.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "history_search",
      );
      const searched = lookup?.content[0];
      if (answer) turn = { content: [{ type: "text", text: answer }] };
      else if (searched?.type === "text") {
        const result = JSON.parse(searched.text);
        const hit = result.matches?.find(
          (candidate: { toolName?: string }) => candidate.toolName === "observe",
        );
        turn = hit
          ? call("history_read", { entryId: hit.entryId, offset: hit.offset, maxChars: 4_000 })
          : { content: [{ type: "text", text: "Original evidence unavailable." }] };
      } else if (context.tools?.some((tool) => tool.name === "history_search")) {
        turn = call("history_search", { query: "DIAGNOSTIC_START" });
      } else if (!texts.some((text) => text.includes("current_nonce="))) {
        turn = call("observe", {});
      } else turn = { content: [{ type: "text", text: "Original evidence unavailable." }] };
    }
    return new FakeProvider([turn]).stream(model, context, options);
  }
}

export async function historyScenario(history: boolean, store?: SessionStore) {
  const expected = randomUUID();
  const current = randomUUID();
  const original = `${"setup log ".repeat(300)}DIAGNOSTIC_START\n${"diagnostic detail ".repeat(60)}original_nonce=${expected}\n${"trailing log ".repeat(450)}`;
  let sourceCalls = 0;
  const source = {
    name: "observe",
    description: "Observe the current diagnostic",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({
      content: [
        {
          type: "text" as const,
          text: ++sourceCalls === 1 ? original : `current_nonce=${current}`,
        },
      ],
    }),
  };
  const provider = new EvidencePolicy();
  const options = {
    provider,
    model: { ...fakeModel, contextWindow: 20_000 },
    tools: [source],
    history,
    autoCompact: false,
    budget: { maxTurns: 6 },
    ...(store ? { session: store } : {}),
  };
  const initial = new Agent(options);
  await initial.run("Capture the diagnostic so we can investigate the regression.");
  const beforeTokens = estimateTokens(initial.session.messagesAt());
  const compacted = await initial.compactNow();
  if (compacted.status !== "completed") throw new Error(`Compaction failed: ${compacted.message}`);
  const compactedTokens = estimateTokens(initial.session.messagesAt());
  const persisted = await initial.sessionStore.load(initial.sessionId);
  if (!persisted) throw new Error("Session was not persisted");
  const resumed = new Agent(options);
  resumed.resume(persisted);
  const hidden = !JSON.stringify(resumed.session.messagesAt()).includes(expected);
  const summarizerSawAnswer = provider.requests.some((request) => {
    const system = JSON.stringify(request.systemPrompt);
    return (
      system.includes("Summarize the conversation") &&
      JSON.stringify(request.messages).includes(expected)
    );
  });
  provider.recovering = true;
  const beforeRequests = provider.requests.length;
  const result = await resumed.run(
    "Recover the ORIGINAL diagnostic nonce from before compaction. The source has changed; do not substitute a current value.",
  );
  const retrievalResults = result.messages.filter(
    (message) => message.role === "toolResult" && message.toolName.startsWith("history_"),
  );
  const retrievalChars = retrievalResults.reduce(
    (sum, message) =>
      sum +
      message.content.reduce(
        (size, block) => size + (block.type === "text" ? block.text.length : 0),
        0,
      ),
    0,
  );
  const outcome = {
    history,
    recovered: result.text === expected,
    evidenceHiddenAfterCompaction: hidden,
    summarizerSawAnswer,
    sourceReruns: sourceCalls - 1,
    recoveryModelCalls: provider.requests.length - beforeRequests,
    retrievalChars,
    retrievalEstimatedTokens: estimateTokens(retrievalResults),
    beforeTokens,
    compactedTokens,
  };
  await initial.shutdown();
  await resumed.shutdown();
  return outcome;
}
