import data from "./models.json" with { type: "json" };
import type { ModelInfo } from "./types.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const DISCOVERY_TIMEOUT_MS = 15_000;
const DISCOVERED_PROVIDERS = new Set(["anthropic", "openai", "google"]);
const bundledModels = data.models as ModelInfo[];
let models: ModelInfo[] = [...bundledModels];

type JsonObject = Record<string, unknown>;
type CatalogFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ModelDiscoveryOptions {
  fetch?: CatalogFetch;
  url?: string;
  signal?: AbortSignal;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function supportsAgentRequests(model: JsonObject): boolean {
  if (model.tool_call !== true || model.status === "deprecated") return false;
  const limit = isObject(model.limit) ? model.limit : {};
  if ((finiteNumber(limit.context) ?? 0) <= 0 || (finiteNumber(limit.output) ?? 0) <= 0) {
    return false;
  }
  if (!isObject(model.modalities)) return true;
  const input = stringArray(model.modalities.input);
  const output = stringArray(model.modalities.output);
  return input.includes("text") && output.includes("text");
}

function thinkingMode(model: JsonObject): "adaptive" | "budget" {
  if (!Array.isArray(model.reasoning_options)) return "budget";
  return model.reasoning_options.some((option) => isObject(option) && option.type === "effort")
    ? "adaptive"
    : "budget";
}

function toModelInfo(provider: string, model: JsonObject): ModelInfo | undefined {
  if (!supportsAgentRequests(model) || typeof model.id !== "string") return undefined;
  const limit = isObject(model.limit) ? model.limit : {};
  const contextWindow = finiteNumber(limit.context);
  const maxOutput = finiteNumber(limit.output);
  if (contextWindow === undefined || maxOutput === undefined) return undefined;
  const cost = isObject(model.cost) ? model.cost : {};
  const inputModalities = isObject(model.modalities)
    ? stringArray(model.modalities.input)
    : ["text"];
  const modalities: ModelInfo["modalities"] = ["text"];
  if (inputModalities.includes("image")) modalities.push("image");
  const thinking = model.reasoning === true;

  return {
    provider,
    id: model.id,
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    contextWindow,
    maxOutput,
    modalities,
    ...(thinking ? { thinking: true } : {}),
    ...(thinking && provider === "anthropic" ? { thinkingMode: thinkingMode(model) } : {}),
    pricing: {
      input: finiteNumber(cost.input) ?? 0,
      output: finiteNumber(cost.output) ?? 0,
      cacheRead: finiteNumber(cost.cache_read) ?? 0,
      cacheWrite: finiteNumber(cost.cache_write) ?? 0,
    },
  };
}

export async function discoverModels(options: ModelDiscoveryOptions = {}): Promise<ModelInfo[]> {
  const response = await (options.fetch ?? fetch)(options.url ?? MODELS_DEV_URL, {
    headers: { accept: "application/json" },
    signal: options.signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Could not discover models: ${response.status} ${response.statusText}`.trim());
  }

  const payload: unknown = await response.json();
  if (!isObject(payload)) throw new Error("Could not discover models: invalid catalog response");

  const discovered: ModelInfo[] = [];
  for (const providerId of DISCOVERED_PROVIDERS) {
    const provider = payload[providerId];
    if (!isObject(provider) || !isObject(provider.models)) continue;
    for (const entry of Object.values(provider.models)) {
      if (!isObject(entry)) continue;
      const model = toModelInfo(providerId, entry);
      if (model) discovered.push(model);
    }
  }
  if (discovered.length === 0) {
    throw new Error("Could not discover models: catalog contained no compatible models");
  }
  return discovered;
}

export async function refreshModels(options: ModelDiscoveryOptions = {}): Promise<ModelInfo[]> {
  const discovered = await discoverModels(options);

  // Merge rather than replace. A valid but partial upstream response (one
  // provider staged, another briefly absent) must never delete models the
  // bundled catalog knows work — that turns `--model anthropic/...` into
  // "unknown model" and silently moves the default.
  const merged = [...bundledModels, ...models.filter((m) => !DISCOVERED_PROVIDERS.has(m.provider))];
  for (const model of discovered) {
    const index = merged.findIndex((m) => m.provider === model.provider && m.id === model.id);
    if (index === -1) merged.push(model);
    else merged[index] = model;
  }
  models = merged;
  return listModels();
}

export function listModels(): ModelInfo[] {
  return [...models];
}

export function registerModels(extra: ModelInfo[]): void {
  for (const model of extra) {
    const index = models.findIndex(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    );
    if (index === -1) models.push(model);
    else models[index] = model;
  }
}

// Accepts "provider/model-id" or a bare model id (first match wins).
export function findModel(ref: string): ModelInfo | undefined {
  const slash = ref.indexOf("/");
  if (slash !== -1) {
    const provider = ref.slice(0, slash);
    const id = ref.slice(slash + 1);
    return models.find((m) => m.provider === provider && m.id === id);
  }
  return models.find((m) => m.id === ref);
}

export function modelRef(model: ModelInfo): string {
  return `${model.provider}/${model.id}`;
}

const PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
};

export function providerHasCredentials(provider: string, env = process.env): boolean {
  if (provider === "openai-codex") return false;
  const variable = PROVIDER_ENV[provider];
  return variable === undefined || Boolean(env[variable]);
}

const DEFAULT_MODEL_IDS: Readonly<Record<string, string>> = {
  "openai-codex": "gpt-5.6-sol",
  openai: "gpt-5.6-sol",
  anthropic: "claude-opus-5",
  google: "gemini-2.5-pro",
};

function preferredModel(providers: Iterable<string>): ModelInfo | undefined {
  for (const provider of providers) {
    const providerModels = models.filter((model) => model.provider === provider);
    if (providerModels.length === 0) continue;
    const preferredId = DEFAULT_MODEL_IDS[provider];
    const preferred = preferredId
      ? providerModels.find((model) => model.id === preferredId)
      : undefined;
    return preferred ?? providerModels[0];
  }
  return undefined;
}

// The optional provider order comes from persisted login state. Without it,
// SDK callers retain environment-aware selection.
export function defaultModelRef(
  env = process.env,
  authenticatedProviders?: Iterable<string>,
): string {
  const providers = authenticatedProviders
    ? [...authenticatedProviders]
    : [...new Set(models.map((model) => model.provider))].filter((provider) =>
        providerHasCredentials(provider, env),
      );
  const model =
    preferredModel(providers) ??
    findModel("openai-codex/gpt-5.6-sol") ??
    models[0] ??
    bundledModels[0];
  if (!model) throw new Error("No models are available");
  return modelRef(model);
}
