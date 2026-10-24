import { classifyHttpError } from "../errors.ts";
import type { ModelInfo, ModelPricing, Provider, ProviderModelDiscoveryOptions } from "../types.ts";
import { streamOpenAICompletions } from "./openai-completions.ts";

const BASE_URL = "https://api.inceptionlabs.ai/v1";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const REASONING_LEVELS = ["instant", "low", "medium", "high"];
const VOICE_REASONING_LEVELS = ["low", "medium", "high"];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function perMillionPrice(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    return undefined;
  }
  return nonnegativeNumber(Number(value) * 1_000_000);
}

function modelPricing(
  value: unknown,
  fallback: ModelPricing | undefined,
): ModelPricing | undefined {
  if (value !== undefined && !isObject(value)) return undefined;
  const pricing = isObject(value) ? value : undefined;
  const price = (key: string, cached: number | undefined): number | undefined =>
    pricing?.[key] === undefined ? nonnegativeNumber(cached) : perMillionPrice(pricing[key]);
  const input = price("prompt", fallback?.input);
  const output = price("completion", fallback?.output);
  const cacheRead = price("input_cache_reads", fallback?.cacheRead ?? 0);
  const cacheWrite = price("input_cache_writes", fallback?.cacheWrite ?? 0);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

function reasoningMetadata(id: string, fallback: ModelInfo | undefined): Partial<ModelInfo> {
  if (id === "mercury-3" || id === "mercury-2.5" || id === "mercury-2") {
    return {
      thinking: true,
      thinkingLevels: [...REASONING_LEVELS],
      defaultThinkingLevel: id === "mercury-3" ? "low" : "medium",
    };
  }
  if (id === "mercury-voice") {
    const defaultLevel = fallback?.defaultThinkingLevel;
    return {
      thinking: true,
      thinkingLevels: [...VOICE_REASONING_LEVELS],
      ...(defaultLevel && VOICE_REASONING_LEVELS.includes(defaultLevel)
        ? { defaultThinkingLevel: defaultLevel }
        : {}),
    };
  }
  if (id === "mercury" || /^mercury-coder(?:-|$)/.test(id) || !fallback?.thinking) return {};
  const levels = fallback.thinkingLevels?.filter(
    (level) => typeof level === "string" && level.trim().length > 0,
  );
  const defaultLevel = fallback.defaultThinkingLevel;
  return {
    thinking: true,
    ...(levels?.length ? { thinkingLevels: levels } : {}),
    ...(defaultLevel && levels?.includes(defaultLevel)
      ? { defaultThinkingLevel: defaultLevel }
      : {}),
  };
}

function inceptionModelInfo(
  value: unknown,
  currentModels: readonly ModelInfo[],
): ModelInfo | undefined {
  if (!isObject(value) || typeof value.id !== "string" || value.id.trim().length === 0) {
    return undefined;
  }
  if (
    !Array.isArray(value.input_modalities) ||
    !value.input_modalities.includes("text") ||
    !Array.isArray(value.output_modalities) ||
    !value.output_modalities.includes("text") ||
    !Array.isArray(value.supported_endpoints) ||
    !value.supported_endpoints.includes("chat.completions") ||
    !Array.isArray(value.supported_features) ||
    !value.supported_features.includes("tools")
  ) {
    return undefined;
  }
  const fallback = currentModels.find(
    (model) => model.provider === "inception" && model.id === value.id && !model.inferred,
  );
  const contextWindow = positiveInteger(
    value.context_length === undefined ? fallback?.contextWindow : value.context_length,
  );
  const maxOutput = positiveInteger(
    value.max_output_length === undefined ? fallback?.maxOutput : value.max_output_length,
  );
  const pricing = modelPricing(value.pricing, fallback?.pricing);
  if (!contextWindow || !maxOutput || maxOutput > contextWindow || !pricing) return undefined;
  const name =
    typeof value.name === "string" && value.name.trim().length > 0 ? value.name : fallback?.name;
  return {
    provider: "inception",
    id: value.id,
    ...(name ? { name } : {}),
    api: "openai-completions",
    baseUrl: BASE_URL,
    contextWindow,
    maxOutput,
    modalities: ["text"],
    pricing,
    ...reasoningMetadata(value.id, fallback),
  };
}

export async function discoverInceptionModels(
  options: ProviderModelDiscoveryOptions,
): Promise<ModelInfo[] | undefined> {
  const credential =
    (await options.getCredentials?.()) ??
    (process.env.INCEPTION_API_KEY
      ? { type: "apiKey" as const, apiKey: process.env.INCEPTION_API_KEY }
      : undefined);
  const token = credential?.type === "oauth" ? credential.accessToken : credential?.apiKey;
  if (!token?.trim()) return undefined;

  const response = await (options.fetch ?? fetch)(`${BASE_URL}/models`, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    signal: options.signal ?? AbortSignal.timeout(DEFAULT_DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw classifyHttpError(response.status, await response.text(), response.headers);
  }
  const payload: unknown = await response.json();
  if (!isObject(payload) || !Array.isArray(payload.data)) {
    throw new Error("Could not discover Inception models: invalid /v1/models response");
  }
  const models = payload.data
    .map((value) => inceptionModelInfo(value, options.currentModels))
    .filter((model): model is ModelInfo => model !== undefined);
  if (models.length === 0) {
    throw new Error(
      "Could not discover Inception models: catalog contained no compatible models with valid metadata",
    );
  }
  return models;
}

export const inceptionProvider: Provider = {
  id: "inception",
  stream: streamOpenAICompletions,
  discoverModels: discoverInceptionModels,
};
