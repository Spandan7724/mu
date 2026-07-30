import { builtinProviderConfigs, modelApi } from "./provider-config.ts";
import { anthropic } from "./providers/anthropic.ts";
import { gemini } from "./providers/gemini.ts";
import { discoverGitHubCopilotModels } from "./providers/github-copilot.ts";
import { openai, openaiCodex } from "./providers/openai.ts";
import { streamOpenAICompletions } from "./providers/openai-completions.ts";
import type { Provider } from "./types.ts";

const direct = new Map<string, Provider>([
  [anthropic.id, anthropic],
  [openai.id, openai],
  [openaiCodex.id, openaiCodex],
  [gemini.id, gemini],
]);

function builtinProvider(id: string): Provider {
  const existing = direct.get(id);
  if (existing) return existing;
  return {
    id,
    stream: (model, context, options) => {
      switch (modelApi(model)) {
        case "anthropic-messages":
          return anthropic.stream(model, context, options);
        case "google-generative-ai":
        case "google-vertex":
          return gemini.stream(model, context, options);
        case "openai-responses":
          return openai.stream(model, context, options);
        default:
          return streamOpenAICompletions(model, context, options);
      }
    },
    ...(id === "github-copilot" ? { discoverModels: discoverGitHubCopilotModels } : {}),
  };
}

export const providers = new Map<string, Provider>(
  [...builtinProviderConfigs.keys()].map((id) => [id, builtinProvider(id)]),
);
providers.set(openaiCodex.id, openaiCodex);

export function getProvider(id: string): Provider {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}
