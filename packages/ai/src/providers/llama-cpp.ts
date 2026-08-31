import type { Credential, ModelInfo, Provider, ProviderModelDiscoveryOptions } from "../types.ts";
import { streamOpenAICompletions } from "./openai-completions.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_000;
const ZERO_PRICING = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function configuredBaseUrl(): string {
  const configured = (process.env.LLAMA_CPP_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return configured.endsWith("/v1") ? configured : `${configured}/v1`;
}

function serverRoot(baseUrl: string): string {
  return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

function discoverySignal(parent: AbortSignal | undefined): AbortSignal | undefined {
  if (process.env.LLAMA_CPP_BASE_URL !== undefined) return parent;
  const timeout = AbortSignal.timeout(DEFAULT_DISCOVERY_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function discoveryCredential(
  options: ProviderModelDiscoveryOptions,
): Promise<Credential | undefined> {
  return (
    (await options.getCredentials?.()) ??
    (process.env.LLAMA_CPP_API_KEY
      ? { type: "apiKey", apiKey: process.env.LLAMA_CPP_API_KEY }
      : undefined)
  );
}

function discoveryHeaders(credential: Credential | undefined): Record<string, string> {
  if (!credential) return { accept: "application/json" };
  const token = credential.type === "oauth" ? credential.accessToken : credential.apiKey;
  return {
    accept: "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function discoverLlamaCppModels(
  options: ProviderModelDiscoveryOptions,
): Promise<ModelInfo[]> {
  const request = options.fetch ?? fetch;
  const baseUrl = configuredBaseUrl();
  const credential = await discoveryCredential(options);
  const headers = discoveryHeaders(credential);
  const signal = discoverySignal(options.signal);
  const modelsResponse = await request(`${baseUrl}/models`, {
    headers,
    ...(signal ? { signal } : {}),
  });
  if (!modelsResponse.ok) {
    throw new Error(
      `Could not discover llama.cpp models: ${modelsResponse.status} ${modelsResponse.statusText}`.trim(),
    );
  }
  const payload: unknown = await modelsResponse.json();
  if (!isObject(payload) || !Array.isArray(payload.data)) {
    throw new Error("Could not discover llama.cpp models: invalid /v1/models response");
  }

  let props: JsonObject | undefined;
  try {
    const response = await request(`${serverRoot(baseUrl)}/props`, {
      headers,
      ...(signal ? { signal } : {}),
    });
    if (response.ok) {
      const value: unknown = await response.json();
      if (isObject(value)) props = value;
    }
  } catch {
    // /props enriches metadata but is not required for OpenAI compatibility.
  }

  const settings = isObject(props?.default_generation_settings)
    ? props.default_generation_settings
    : undefined;
  const configuredContext = positiveInteger(settings?.n_ctx);
  const modalities = isObject(props?.modalities) ? props.modalities : undefined;
  const supportsVision = modalities?.vision === true;

  return payload.data.flatMap((entry): ModelInfo[] => {
    if (!isObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) return [];
    const meta = isObject(entry.meta) ? entry.meta : undefined;
    const contextWindow = configuredContext ?? positiveInteger(meta?.n_ctx_train) ?? 131_072;
    return [
      {
        provider: "llama-cpp",
        id: entry.id,
        name: entry.id,
        api: "openai-completions",
        baseUrl,
        contextWindow,
        maxOutput: Math.min(32_768, contextWindow),
        modalities: supportsVision ? ["text", "image"] : ["text"],
        pricing: ZERO_PRICING,
      },
    ];
  });
}

export const llamaCpp: Provider = {
  id: "llama-cpp",
  stream: streamOpenAICompletions,
  discoverModels: discoverLlamaCppModels,
};
