export { resolveCredential } from "./auth.ts";
export type { ModelDiscoveryOptions } from "./catalog.ts";
export {
  defaultModelRef,
  discoverModels,
  findModel,
  listModels,
  modelRef,
  refreshModels,
  registerModels,
} from "./catalog.ts";
export { addUsage, computeCostUsd, zeroUsage } from "./cost.ts";
export type { AiErrorKind } from "./errors.ts";
export { AiError, classifyHttpError, isContextTooLongMessage } from "./errors.ts";
export { parseJsonWithRepair, parsePartialJson, repairJson, salvageToolArgs } from "./json.ts";
export { anthropic, streamAnthropic } from "./providers/anthropic.ts";
export { gemini, streamGemini } from "./providers/gemini.ts";
export { openai, streamOpenAI } from "./providers/openai.ts";
export { getProvider, providers, registerProvider } from "./registry.ts";
export type { RetryOpts } from "./retry.ts";
export { withRetries } from "./retry.ts";
export type { SseEvent } from "./sse.ts";
export { iterateSse } from "./sse.ts";
export { AssistantStream, EventStream } from "./stream.ts";
export type { Cassette, RecordedInteraction, ReplayCall, ReplayHandle } from "./testing/replay.ts";
export { recordFetch, replayFetch } from "./testing/replay.ts";
export * from "./types.ts";
