import {
  type AssistantContent,
  type AssistantMessage,
  AssistantStream,
  type LlmContext,
  type ModelInfo,
  type Provider,
  type StopReason,
  type StreamOpts,
  type Usage,
} from "@mu/ai";

// Scripted provider for loop tests: each turn yields the next scripted
// response, streamed through the real event protocol.
export interface ScriptedTurn {
  content: AssistantContent[];
  stopReason?: StopReason;
  errorMessage?: string;
  usage?: Partial<Usage>;
  // Resolves before the stream produces anything — lets a test await mid-turn.
  delayMs?: number;
}

export const fakeModel: ModelInfo = {
  provider: "fake",
  id: "fake-1",
  contextWindow: 100_000,
  maxOutput: 4_000,
  modalities: ["text"],
  thinking: true,
  pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};

export class FakeProvider implements Provider {
  readonly id = "fake";
  readonly requests: LlmContext[] = [];
  readonly streamOptions: (StreamOpts | undefined)[] = [];
  private index = 0;

  constructor(private turns: ScriptedTurn[]) {}

  get callCount(): number {
    return this.index;
  }

  stream(model: ModelInfo, ctx: LlmContext, opts?: StreamOpts): AssistantStream {
    this.requests.push(structuredClone(ctx));
    this.streamOptions.push(opts);
    const turn = this.turns[this.index] ?? { content: [{ type: "text", text: "" }] };
    this.index++;
    const stream = new AssistantStream();

    void (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        model: `${model.provider}/${model.id}`,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.0001,
          ...turn.usage,
        },
        stopReason:
          turn.stopReason ?? (turn.content.some((c) => c.type === "toolCall") ? "toolUse" : "end"),
        timestamp: Date.now(),
      };

      stream.push({ type: "start", partial: output });
      if (turn.delayMs) await Bun.sleep(turn.delayMs);

      if (opts?.signal?.aborted) {
        output.stopReason = "aborted";
        output.errorMessage = "Request was aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
      }

      for (const block of turn.content) {
        const contentIndex = output.content.length;
        if (block.type === "text") {
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex, partial: output });
          const target = output.content[contentIndex];
          if (target?.type === "text") target.text = block.text;
          stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
          stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
        } else if (block.type === "thinking") {
          output.content.push(block);
          stream.push({ type: "thinking_start", contentIndex, partial: output });
          stream.push({
            type: "thinking_delta",
            contentIndex,
            delta: block.thinking,
            partial: output,
          });
          stream.push({
            type: "thinking_end",
            contentIndex,
            content: block.thinking,
            partial: output,
          });
        } else {
          output.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: JSON.stringify(block.arguments),
            partial: output,
          });
          stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
        }
      }

      if (turn.errorMessage) {
        output.stopReason = "error";
        output.errorMessage = turn.errorMessage;
        stream.push({ type: "error", reason: "error", error: output });
      } else {
        stream.push({ type: "done", message: output });
      }
      stream.end();
    })();

    return stream;
  }
}
