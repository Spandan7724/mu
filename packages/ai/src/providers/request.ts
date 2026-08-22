import { AiError } from "../errors.ts";
import { providerBaseUrl, providerConfig, providerEnvVars } from "../provider-config.ts";
import type { Credential, ModelInfo, StreamOpts } from "../types.ts";

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function envValue(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

export async function resolveProviderCredential(
  model: ModelInfo,
  opts?: StreamOpts,
): Promise<Credential> {
  const resolved = await opts?.getCredentials?.();
  if (resolved) {
    if (model.provider === "anthropic" && resolved.type === "oauth") {
      throw new AiError("auth", "Anthropic account-plan authentication is not supported");
    }
    return resolved;
  }
  const apiKey = opts?.apiKey ?? envValue(providerEnvVars(model.provider));
  if (!apiKey && providerConfig(model.provider)?.auth === "none") {
    return { type: "apiKey", apiKey: "" };
  }
  if (!apiKey) {
    const variables = providerEnvVars(model.provider);
    const setup =
      variables.length > 0 ? `set ${variables.join(" or ")} or run /login` : "run /login";
    throw new AiError("auth", `No credentials for provider "${model.provider}" (${setup})`);
  }
  return { type: "apiKey", apiKey };
}

function cloudflareBaseUrl(model: ModelInfo): string | undefined {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) return undefined;
  if (model.provider === "cloudflare-workers-ai") {
    return `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`;
  }
  const gateway = process.env.CLOUDFLARE_GATEWAY_ID;
  if (!gateway) return undefined;
  const prefix = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}`;
  if (model.api === "anthropic-messages") return `${prefix}/anthropic`;
  if (model.api === "openai-responses") return `${prefix}/openai`;
  return `${prefix}/compat`;
}

function azureBaseUrl(): string | undefined {
  const configured = process.env.AZURE_OPENAI_BASE_URL;
  const resource = process.env.AZURE_OPENAI_RESOURCE_NAME;
  if (!configured && !resource) return undefined;
  const root = trimSlash(configured ?? `https://${resource}.openai.azure.com`);
  return root.endsWith("/openai/v1") ? root : `${root}/openai/v1`;
}

function vertexBaseUrl(): string | undefined {
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION;
  if (!project || !location) return "https://aiplatform.googleapis.com/v1/publishers/google";
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google`;
}

function bedrockBaseUrl(): string {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  return `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
}

export function resolvedBaseUrl(model: ModelInfo, opts?: StreamOpts): string {
  if (opts?.baseUrl) return trimSlash(opts.baseUrl);
  if (model.provider === "llama-cpp" && process.env.LLAMA_CPP_BASE_URL) {
    const configured = trimSlash(process.env.LLAMA_CPP_BASE_URL);
    return configured.endsWith("/v1") ? configured : `${configured}/v1`;
  }
  if (model.provider.startsWith("cloudflare-")) {
    const base = cloudflareBaseUrl(model);
    if (base) return trimSlash(base);
  }
  if (model.provider === "azure-openai-responses") {
    const base = azureBaseUrl();
    if (base) return trimSlash(base);
  }
  if (model.provider === "google-vertex") {
    const base = vertexBaseUrl();
    if (base) return trimSlash(base);
  }
  if (model.provider === "amazon-bedrock") return bedrockBaseUrl();
  return trimSlash(providerBaseUrl(model) ?? "");
}

export function apiPath(baseUrl: string, path: string): string {
  const base = trimSlash(baseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!base) return normalizedPath;
  if (normalizedPath.startsWith("/v1/") && base.endsWith("/v1")) {
    return `${base}${normalizedPath.slice(3)}`;
  }
  return `${base}${normalizedPath}`;
}

export function credentialHeaders(
  model: ModelInfo,
  credential: Credential,
): Record<string, string> {
  const config = providerConfig(model.provider);
  const base = { ...config?.headers, ...model.headers };
  if (config?.auth === "none" && credential.type === "apiKey" && !credential.apiKey) return base;
  if (credential.type === "oauth") {
    return {
      ...base,
      authorization: `Bearer ${credential.accessToken}`,
      ...credential.headers,
    };
  }
  if (config?.auth === "anthropic") return { ...base, "x-api-key": credential.apiKey };
  if (config?.auth === "google") return { ...base, "x-goog-api-key": credential.apiKey };
  if (config?.auth === "azure") return { ...base, "api-key": credential.apiKey };
  if (config?.auth === "cloudflare") {
    return { ...base, "cf-aig-authorization": `Bearer ${credential.apiKey}` };
  }
  return { ...base, authorization: `Bearer ${credential.apiKey}` };
}

export function credentialBaseUrl(
  model: ModelInfo,
  credential: Credential,
  opts?: StreamOpts,
): string {
  if (opts?.baseUrl) return trimSlash(opts.baseUrl);
  if (credential.type === "oauth" && credential.baseUrl) return trimSlash(credential.baseUrl);
  return resolvedBaseUrl(model, opts);
}
