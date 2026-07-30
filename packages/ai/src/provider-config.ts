import type { LlmApi, ModelInfo } from "./types.ts";

export interface BuiltinProviderConfig {
  id: string;
  name: string;
  api: LlmApi;
  baseUrl?: string;
  env: string[];
  auth?: "bearer" | "anthropic" | "google" | "azure" | "cloudflare";
  headers?: Record<string, string>;
}

const configs: BuiltinProviderConfig[] = [
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    api: "openai-responses",
    env: ["AWS_BEARER_TOKEN_BEDROCK"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    env: ["ANTHROPIC_API_KEY"],
    auth: "anthropic",
  },
  {
    id: "azure-openai-responses",
    name: "Azure OpenAI",
    api: "openai-responses",
    env: ["AZURE_OPENAI_API_KEY"],
    auth: "azure",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    api: "openai-completions",
    baseUrl: "https://api.cerebras.ai/v1",
    env: ["CEREBRAS_API_KEY"],
  },
  {
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    api: "openai-completions",
    env: ["CLOUDFLARE_API_KEY"],
    auth: "cloudflare",
  },
  {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    api: "openai-completions",
    env: ["CLOUDFLARE_API_KEY"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    env: ["DEEPSEEK_API_KEY"],
  },
  {
    id: "fireworks",
    name: "Fireworks",
    api: "anthropic-messages",
    baseUrl: "https://api.fireworks.ai/inference",
    env: ["FIREWORKS_API_KEY"],
    auth: "anthropic",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    api: "openai-responses",
    baseUrl: "https://api.individual.githubcopilot.com",
    env: ["COPILOT_GITHUB_TOKEN"],
    headers: {
      "user-agent": "GitHubCopilotChat/0.35.0",
      "editor-version": "vscode/1.107.0",
      "editor-plugin-version": "copilot-chat/0.35.0",
      "copilot-integration-id": "vscode-chat",
    },
  },
  {
    id: "google",
    name: "Google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    env: ["GEMINI_API_KEY"],
    auth: "google",
  },
  {
    id: "google-vertex",
    name: "Google Vertex AI",
    api: "google-vertex",
    env: ["GOOGLE_CLOUD_API_KEY"],
    auth: "google",
  },
  {
    id: "groq",
    name: "Groq",
    api: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    env: ["GROQ_API_KEY"],
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    api: "openai-completions",
    baseUrl: "https://router.huggingface.co/v1",
    env: ["HF_TOKEN"],
  },
  {
    id: "kimi-coding",
    name: "Kimi For Coding",
    api: "anthropic-messages",
    baseUrl: "https://api.kimi.com/coding",
    env: ["KIMI_API_KEY"],
    auth: "anthropic",
    headers: { "user-agent": "KimiCLI/1.5" },
  },
  {
    id: "minimax",
    name: "MiniMax",
    api: "anthropic-messages",
    baseUrl: "https://api.minimax.io/anthropic",
    env: ["MINIMAX_API_KEY"],
    auth: "anthropic",
  },
  {
    id: "mistral",
    name: "Mistral",
    api: "openai-completions",
    baseUrl: "https://api.mistral.ai/v1",
    env: ["MISTRAL_API_KEY"],
  },
  {
    id: "moonshotai",
    name: "Moonshot AI",
    api: "openai-completions",
    baseUrl: "https://api.moonshot.ai/v1",
    env: ["MOONSHOT_API_KEY"],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    api: "openai-completions",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    env: ["NVIDIA_API_KEY"],
    headers: { "nvcf-poll-seconds": "3600" },
  },
  {
    id: "openai",
    name: "OpenAI",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    api: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    env: [],
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/v1",
    env: ["OPENCODE_API_KEY"],
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    env: ["OPENCODE_API_KEY"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
  },
  {
    id: "qwen-token-plan",
    name: "Qwen Token Plan",
    api: "openai-completions",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    env: ["QWEN_TOKEN_PLAN_API_KEY"],
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    api: "anthropic-messages",
    baseUrl: "https://ai-gateway.vercel.sh",
    env: ["AI_GATEWAY_API_KEY"],
    auth: "anthropic",
  },
  {
    id: "xai",
    name: "xAI",
    api: "openai-completions",
    baseUrl: "https://api.x.ai/v1",
    env: ["XAI_API_KEY"],
  },
  {
    id: "zai",
    name: "Z.AI Coding Plan",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    env: ["ZAI_API_KEY"],
  },
];

export const builtinProviderConfigs = new Map(configs.map((config) => [config.id, config]));

export function providerConfig(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderConfigs.get(id);
}

export function modelApi(model: ModelInfo): LlmApi {
  return model.api ?? providerConfig(model.provider)?.api ?? "openai-completions";
}

export function providerBaseUrl(model: ModelInfo): string | undefined {
  return model.baseUrl ?? providerConfig(model.provider)?.baseUrl;
}

export function providerEnvVars(provider: string): readonly string[] {
  return providerConfig(provider)?.env ?? [];
}
