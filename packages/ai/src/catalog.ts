import data from "./models.json" with { type: "json" };
import { builtinProviderConfigs, modelApi, providerEnvVars } from "./provider-config.ts";
import { providers as registeredProviders } from "./registry.ts";
import type { Credential, LlmApi, ModelInfo, Provider } from "./types.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const DISCOVERY_TIMEOUT_MS = 15_000;
const ZERO_PRICING = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const PUBLIC_PROVIDER_SOURCES: ReadonlyArray<{
  source: string;
  providers: readonly string[];
}> = [
  { source: "amazon-bedrock", providers: ["amazon-bedrock"] },
  { source: "anthropic", providers: ["anthropic"] },
  { source: "cerebras", providers: ["cerebras"] },
  { source: "cloudflare-ai-gateway", providers: ["cloudflare-ai-gateway"] },
  { source: "cloudflare-workers-ai", providers: ["cloudflare-workers-ai"] },
  { source: "deepseek", providers: ["deepseek"] },
  { source: "fireworks-ai", providers: ["fireworks"] },
  { source: "github-copilot", providers: ["github-copilot"] },
  { source: "google", providers: ["google"] },
  { source: "google-vertex", providers: ["google-vertex"] },
  { source: "groq", providers: ["groq"] },
  { source: "huggingface", providers: ["huggingface"] },
  { source: "kimi-for-coding", providers: ["kimi-coding"] },
  { source: "minimax", providers: ["minimax"] },
  { source: "mistral", providers: ["mistral"] },
  { source: "moonshotai", providers: ["moonshotai"] },
  { source: "nvidia", providers: ["nvidia"] },
  { source: "openai", providers: ["openai", "azure-openai-responses"] },
  { source: "opencode", providers: ["opencode"] },
  { source: "opencode-go", providers: ["opencode-go"] },
  { source: "openrouter", providers: ["openrouter"] },
  { source: "alibaba-token-plan", providers: ["qwen-token-plan"] },
  { source: "vercel-ai-gateway", providers: ["vercel-ai-gateway"] },
  { source: "xai", providers: ["xai"] },
  { source: "zai-coding-plan", providers: ["zai"] },
];
const planModels: ModelInfo[] = [
  {
    provider: "github-copilot",
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    api: "openai-responses",
    contextWindow: 128_000,
    maxOutput: 32_000,
    modalities: ["text", "image"],
    thinking: true,
    pricing: ZERO_PRICING,
  },
  {
    provider: "kimi-coding",
    id: "kimi-for-coding",
    name: "Kimi For Coding",
    api: "anthropic-messages",
    contextWindow: 262_144,
    maxOutput: 65_536,
    modalities: ["text"],
    thinking: true,
    pricing: ZERO_PRICING,
  },
  {
    provider: "openrouter",
    id: "auto",
    name: "OpenRouter Auto",
    api: "openai-completions",
    contextWindow: 2_000_000,
    maxOutput: 30_000,
    modalities: ["text", "image"],
    thinking: true,
    pricing: ZERO_PRICING,
  },
  {
    provider: "xai",
    id: "grok-4.3",
    name: "Grok 4.3",
    api: "openai-completions",
    contextWindow: 256_000,
    maxOutput: 64_000,
    modalities: ["text", "image"],
    thinking: true,
    pricing: ZERO_PRICING,
  },
  {
    provider: "zai",
    id: "glm-5.1",
    name: "GLM-5.1",
    api: "openai-completions",
    contextWindow: 202_752,
    maxOutput: 65_536,
    modalities: ["text"],
    thinking: true,
    pricing: ZERO_PRICING,
  },
  {
    provider: "qwen-token-plan",
    id: "qwen3.7-max",
    name: "Qwen3.7 Max",
    api: "openai-completions",
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    modalities: ["text", "image"],
    thinking: true,
    pricing: ZERO_PRICING,
  },
];
const bundledModels = [...(data.models as ModelInfo[]), ...planModels];
let models: ModelInfo[] = [...bundledModels];
const authoritativeProviders = new Set<string>();

type JsonObject = Record<string, unknown>;
type CatalogFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ModelDiscoveryOptions {
  fetch?: CatalogFetch;
  url?: string;
  signal?: AbortSignal;
  getCredentials?: (provider: string) => Promise<Credential | undefined>;
  clientVersion?: string;
  providers?: Iterable<Provider>;
  onWarning?: (warning: string) => void;
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

function apiForModel(provider: string, model: JsonObject): LlmApi {
  if (provider === "cloudflare-ai-gateway" && typeof model.id === "string") {
    if (model.id.startsWith("openai/")) return "openai-responses";
    if (model.id.startsWith("anthropic/")) return "anthropic-messages";
    return "openai-completions";
  }
  if (provider === "fireworks" && typeof model.id === "string" && model.id.includes("glm-5p2")) {
    return "openai-completions";
  }
  if (provider === "github-copilot") {
    if (
      typeof model.id === "string" &&
      /^claude-(haiku|sonnet|opus)-[45](?=[.-]|$)/.test(model.id)
    ) {
      return "anthropic-messages";
    }
    if (
      typeof model.id === "string" &&
      (model.id.startsWith("gpt-5") || model.id.startsWith("oswe") || model.id.startsWith("mai-"))
    ) {
      return "openai-responses";
    }
    return "openai-completions";
  }
  if (provider === "xai" && model.id === "grok-4.5") return "openai-responses";
  if (provider === "opencode" || provider === "opencode-go") {
    const npm = isObject(model.provider) ? model.provider.npm : undefined;
    if (npm === "@ai-sdk/openai") return "openai-responses";
    if (npm === "@ai-sdk/anthropic") return "anthropic-messages";
    if (npm === "@ai-sdk/google") return "google-generative-ai";
    return "openai-completions";
  }
  return modelApi({
    provider,
    id: "",
    contextWindow: 1,
    maxOutput: 1,
    modalities: ["text"],
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
}

function routedModel(
  provider: string,
  model: JsonObject,
): { id: string; api: LlmApi; baseUrl?: string } | undefined {
  if (typeof model.id !== "string") return undefined;
  const api = apiForModel(provider, model);
  let id = model.id;
  let baseUrl = builtinProviderConfigs.get(provider)?.baseUrl;
  if (provider === "cloudflare-ai-gateway") {
    const slash = id.indexOf("/");
    const upstream = slash === -1 ? "" : id.slice(0, slash);
    if (upstream === "openai" || upstream === "anthropic") id = id.slice(slash + 1);
  } else if (provider === "fireworks" && api === "openai-completions") {
    baseUrl = "https://api.fireworks.ai/inference/v1";
  } else if (
    (provider === "opencode" || provider === "opencode-go") &&
    api === "anthropic-messages"
  ) {
    baseUrl = baseUrl?.replace(/\/v1$/, "");
  }
  return { id, api, ...(baseUrl ? { baseUrl } : {}) };
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
  const route = routedModel(provider, model);
  if (!route) return undefined;

  return {
    provider,
    id: route.id,
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    api: route.api,
    ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
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

interface DiscoveryResult {
  models: ModelInfo[];
  authoritativeProviders: Set<string>;
}

async function discoverPublicModels(options: ModelDiscoveryOptions): Promise<DiscoveryResult> {
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
  const authoritativeProviders = new Set<string>();
  for (const source of PUBLIC_PROVIDER_SOURCES) {
    const provider = payload[source.source];
    if (!isObject(provider) || !isObject(provider.models)) continue;
    for (const providerId of source.providers) {
      let compatible = 0;
      for (const [id, value] of Object.entries(provider.models)) {
        if (!isObject(value)) continue;
        const entry = typeof value.id === "string" ? value : { ...value, id };
        const model = toModelInfo(providerId, entry);
        if (model) {
          discovered.push(model);
          compatible++;
        }
      }
      if (compatible > 0) authoritativeProviders.add(providerId);
    }
  }
  if (discovered.length === 0) {
    throw new Error("Could not discover models: catalog contained no compatible models");
  }
  return { models: discovered, authoritativeProviders };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function discoverModelSources(options: ModelDiscoveryOptions): Promise<DiscoveryResult> {
  const sources: Promise<DiscoveryResult | undefined>[] = [discoverPublicModels(options)];
  const getCredentials = options.getCredentials;
  for (const provider of options.providers ?? registeredProviders.values()) {
    if (!provider.discoverModels) continue;
    sources.push(
      provider
        .discoverModels({
          ...(options.fetch ? { fetch: options.fetch as typeof fetch } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(getCredentials ? { getCredentials: () => getCredentials(provider.id) } : {}),
          ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
          currentModels: models,
        })
        .then((discovered) => {
          if (discovered === undefined) return undefined;
          if (discovered.length === 0) {
            throw new Error(`Could not discover ${provider.id} models: catalog returned no models`);
          }
          return {
            models: discovered,
            authoritativeProviders: new Set([provider.id]),
          };
        }),
    );
  }

  const settled = await Promise.allSettled(sources);
  const discovered: ModelInfo[] = [];
  const authoritativeProviders = new Set<string>();
  const failures: string[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      failures.push(message(result.reason));
      continue;
    }
    if (!result.value) continue;
    discovered.push(...result.value.models);
    for (const provider of result.value.authoritativeProviders) {
      authoritativeProviders.add(provider);
    }
  }
  if (authoritativeProviders.size === 0) {
    throw new Error(failures[0] ?? "Could not discover models: no discovery source was available");
  }
  for (const failure of failures) options.onWarning?.(failure);
  return { models: discovered, authoritativeProviders };
}

export async function discoverModels(options: ModelDiscoveryOptions = {}): Promise<ModelInfo[]> {
  return (await discoverModelSources(options)).models;
}

export async function refreshModels(options: ModelDiscoveryOptions = {}): Promise<ModelInfo[]> {
  const discovered = await discoverModelSources(options);
  for (const provider of discovered.authoritativeProviders) authoritativeProviders.add(provider);

  // A source replaces only the providers it successfully described. Providers
  // skipped due to missing credentials, or whose source failed, retain their
  // cached/bundled metadata.
  const merged = models.filter((model) => !discovered.authoritativeProviders.has(model.provider));
  for (const fallback of bundledModels) {
    if (discovered.authoritativeProviders.has(fallback.provider)) continue;
    if (
      !merged.some(
        (candidate) => candidate.provider === fallback.provider && candidate.id === fallback.id,
      )
    ) {
      merged.push(fallback);
    }
  }
  for (const model of discovered.models) {
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
    const known = models.find((m) => m.provider === provider && m.id === id);
    if (known) return known;
    if (authoritativeProviders.has(provider)) return undefined;
    const config = builtinProviderConfigs.get(provider);
    if (!config || !id) return undefined;
    const route = routedModel(provider, { id });
    if (!route) return undefined;
    return {
      provider,
      id: route.id,
      name: route.id,
      api: route.api,
      ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
      contextWindow: 128_000,
      maxOutput: 32_000,
      modalities: ["text", "image"],
      thinking: true,
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }
  return models.find((m) => m.id === ref);
}

export function modelRef(model: ModelInfo): string {
  return `${model.provider}/${model.id}`;
}

export function providerHasCredentials(provider: string, env = process.env): boolean {
  if (provider === "openai-codex") return false;
  const variables = providerEnvVars(provider);
  return variables.length === 0 || variables.some((variable) => Boolean(env[variable]));
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
