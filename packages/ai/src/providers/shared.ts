import { computeCostUsd } from "../cost.ts";
import { AiError, classifyHttpError } from "../errors.ts";
import { AssistantStream } from "../stream.ts";
import type { AssistantMessage, ModelInfo, StreamOpts } from "../types.ts";

export function newAssistantMessage(model: ModelInfo): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    model: `${model.provider}/${model.id}`,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    stopReason: "end",
    timestamp: Date.now(),
  };
}

export function updateCost(model: ModelInfo, output: AssistantMessage): void {
  output.usage.costUsd = computeCostUsd(model.pricing, output.usage);
}

// Runs the provider request in the background, converting a thrown error or an
// abort into a terminal "error" event. `fn` must emit start/deltas/usage onto
// the stream and set output.stopReason before returning.
export function driveStream(
  model: ModelInfo,
  opts: StreamOpts | undefined,
  fn: (stream: AssistantStream, output: AssistantMessage) => Promise<void>,
): AssistantStream {
  const stream = new AssistantStream();
  const output = newAssistantMessage(model);

  (async () => {
    try {
      await fn(stream, output);
      if (opts?.signal?.aborted) throw new Error("Request was aborted");
      if (output.stopReason === "error") {
        throw new AiError("api", output.errorMessage ?? "provider reported an error");
      }
      stream.push({ type: "done", message: output });
    } catch (error) {
      output.stopReason = opts?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({
        type: "error",
        reason: output.stopReason,
        ...(error instanceof AiError ? { errorKind: error.kind } : {}),
        error: output,
      });
    } finally {
      stream.end();
    }
  })();

  return stream;
}

export async function postSse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts?: StreamOpts,
): Promise<Response> {
  const doFetch = opts?.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
      body: JSON.stringify(body),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  } catch (error) {
    if (opts?.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AiError("network", message);
  }
  if (!response.ok) {
    const text = await response.text();
    throw classifyHttpError(response.status, text, response.headers);
  }
  if (!response.body) throw new AiError("api", "response has no body");
  return response;
}
