import { randomUUID } from "node:crypto";
import type { LlmContext, ModelInfo, Provider, StreamOpts } from "@mu/ai";
import {
  type AgentMessage,
  estimateTokens,
  planCompaction,
  type SessionStore,
  SessionTree,
  userMessage,
} from "@mu/core";
import { FakeProvider, fakeModel, type ScriptedTurn } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "../agent.ts";

const model = { ...fakeModel, contextWindow: 8_000 };
const texts = (context: LlmContext) =>
  context.messages
    .flatMap((message) =>
      message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    )
    .join("\n");

// A constrained evidence-selection policy, not an LLM quality simulation. Its
// only inputs are the actual requests. It never receives the expected nonce.
class DecisionPolicy implements Provider {
  readonly id = "fake";
  readonly requests: LlmContext[] = [];
  readonly options: (StreamOpts | undefined)[] = [];

  stream(model: ModelInfo, context: LlmContext, options?: StreamOpts) {
    this.requests.push(structuredClone(context));
    this.options.push(options);
    const body = texts(context);
    const system = JSON.stringify(context.systemPrompt);
    let turn: ScriptedTurn;
    if (system.includes("Summarize the conversation")) {
      const reference =
        body.match(/<recent-context[^>]*>\n([\s\S]*?)\n<\/recent-context>/)?.[1] ?? "";
      const active =
        reference
          .match(/Investigate case (alpha|beta)/g)
          ?.at(-1)
          ?.split(" ")
          .at(-1) ?? "alpha";
      const evidence = [
        ...body.matchAll(new RegExp(`case ${active}: expected_nonce=([a-f0-9-]+)`, "g")),
      ].at(-1)?.[1];
      const retry = [...reference.matchAll(/retry_limit=(\d+)/g)].at(-1)?.[1] ?? "3";
      const evidencePosition = evidence
        ? body.lastIndexOf(`case ${active}: expected_nonce=${evidence}`)
        : -1;
      const conversationStart = body.indexOf("<conversation>");
      const source =
        evidencePosition > conversationStart && conversationStart !== -1
          ? ([
              ...body.slice(conversationStart, evidencePosition).matchAll(/\[Source "([^"]+)"/g),
            ].at(-1)?.[1] ?? "earlier-handoff")
          : (body.match(/Source: ([^\n]+)/)?.[1] ?? "earlier-handoff");
      turn = {
        content: [
          {
            type: "text",
            text: `## Active goal\nInvestigate case ${active}.\n## Constraints and corrections\nretry_limit=${retry}; earlier retry limits are superseded.\n## Current task state\nInvestigation pending.\n## Evidence for the next decision\n${evidence ? `case ${active}: expected_nonce=${evidence}\nSource: ${source}` : "No relevant diagnostic available."}\n## Open questions and next steps\nRun the regression verification with the original expected value.`,
          },
        ],
      };
    } else if (
      context.messages.some(
        (message) => message.role === "toolResult" && message.toolName === "verify_regression",
      )
    ) {
      turn = { content: [{ type: "text", text: "Verification complete." }] };
    } else {
      const active =
        body
          .match(/Investigate case (alpha|beta)/g)
          ?.at(-1)
          ?.split(" ")
          .at(-1) ?? "beta";
      const nonce = body.match(new RegExp(`case ${active}: expected_nonce=([a-f0-9-]+)`))?.[1];
      const retryLimit = Number([...body.matchAll(/retry_limit=(\d+)/g)].at(-1)?.[1] ?? "0");
      turn = nonce
        ? {
            content: [
              {
                type: "toolCall",
                id: "verify",
                name: "verify_regression",
                arguments: { caseId: active, nonce, retryLimit },
              },
            ],
          }
        : { content: [{ type: "text", text: "Cannot verify without the original evidence." }] };
    }
    return new FakeProvider([turn]).stream(model, context, options);
  }
}

function observation(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "inspect",
    toolName: "inspect",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

// Reproduces the pre-change compactor input policy as a controlled baseline:
// working prefix only, 2,000 characters per result, no retained-tail reference.
async function legacyCompact(agent: Agent, provider: DecisionPolicy) {
  const visible = agent.session.messagesAt();
  const plan = planCompaction(visible, model.contextWindow * 0.2);
  const firstKept = visible[plan.keepFromIndex];
  const prefix = visible
    .slice(0, plan.keepFromIndex)
    .map((message) =>
      message.content
        .flatMap((block) =>
          block.type === "text"
            ? [message.role === "toolResult" ? block.text.slice(0, 2_000) : block.text]
            : [],
        )
        .join("\n"),
    )
    .join("\n\n");
  const result = await provider
    .stream(
      model,
      {
        systemPrompt: [{ text: "Summarize the conversation so far." }],
        messages: [userMessage(prefix)],
      },
      { maxTokens: 1_200 },
    )
    .result();
  const summary = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  agent.session.append({
    type: "compaction",
    summary,
    firstKeptEntryId: firstKept ? (agent.session.entryIdForMessage(firstKept) ?? null) : null,
    usage: result.usage,
  });
  await agent.sessionStore.save(agent.sessionId, agent.session);
}

export async function compactionScenario(improved: boolean, store?: SessionStore) {
  const original = { alpha: randomUUID(), beta: randomUUID() };
  const provider = new DecisionPolicy();
  let correctActions = 0;
  let attemptedActions = 0;
  const options = {
    provider,
    model,
    history: false,
    autoCompact: false,
    ...(store ? { session: store } : {}),
    tools: [
      {
        name: "verify_regression",
        description:
          "Verify the regression using its original evidence and the current retry limit",
        inputSchema: { type: "object" },
        execute: async (_id: string, args: Record<string, unknown>) => {
          attemptedActions++;
          const correct =
            args.caseId === "beta" && args.nonce === original.beta && args.retryLimit === 7;
          if (correct) correctActions++;
          return {
            content: [
              {
                type: "text" as const,
                text: correct ? "regression verified" : "wrong evidence or superseded constraint",
              },
            ],
            isError: !correct,
          };
        },
      },
    ],
  };
  const initial = new Agent(options);
  initial.session.appendMessage(userMessage("Investigate case alpha. Start with retry_limit=3."));
  const evidence = initial.session.appendMessage(
    observation(
      `${"setup log\n".repeat(400)}case alpha: expected_nonce=${original.alpha}\n${"intermediate log\n".repeat(1_500)}case beta: expected_nonce=${original.beta}\n${"trailing log\n".repeat(1_000)}`,
    ),
  );
  // Represents an existing session written by the old eviction policy.
  initial.session.append({
    type: "microcompaction",
    replacements: [{ entryId: evidence.id, message: observation("[output cleared]") }],
  });
  for (let i = 0; i < 5; i++)
    initial.session.appendMessage(
      userMessage(`Progress note ${i}: ${"unrelated detail ".repeat(70)}`),
    );
  initial.session.appendMessage(
    userMessage("Investigate case alpha. Preserve its exact original diagnostic. retry_limit=3."),
  );
  const compact = async (owner: Agent) => {
    if (!improved) return legacyCompact(owner, provider);
    const result = await owner.compactNow();
    if (result.status !== "completed") throw new Error(result.message);
  };
  await compact(initial);
  const firstSummary = JSON.stringify(initial.session.messagesAt());
  // Task relevance changes after the first handoff; beta was intentionally not
  // retained by the policy while alpha was the active investigation.
  initial.session.appendMessage(
    userMessage(
      "Correction: Investigate case beta instead. retry_limit=7. The earlier retry limit is superseded.",
    ),
  );
  await compact(initial);
  await compact(initial);
  const saved = await initial.sessionStore.load(initial.sessionId);
  if (!saved) throw new Error("Session was not persisted");
  const resumed = new Agent(options);
  resumed.resume(SessionTree.fromJsonl(saved.toJsonl()));
  const contextTokens = estimateTokens(resumed.session.messagesAt());
  const compactorCalls = provider.requests.length;
  const result = await resumed.run("Continue with the regression verification.");
  const outcome = {
    improved,
    firstTaskEvidencePreserved: firstSummary.includes(original.alpha),
    nextTaskEvidenceAbsentFromFirstHandoff: !firstSummary.includes(original.beta),
    correctActions,
    attemptedActions,
    compactorCalls,
    contextTokens,
    historyCalls: result.messages.filter(
      (message) => message.role === "toolResult" && message.toolName.startsWith("history_"),
    ).length,
    evidenceSourceId: evidence.id,
    finalContext: resumed.session.messagesAt(),
  };
  await initial.shutdown();
  await resumed.shutdown();
  return outcome;
}
