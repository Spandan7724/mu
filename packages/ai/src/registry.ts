import { anthropic } from "./providers/anthropic.ts";
import { gemini } from "./providers/gemini.ts";
import { openai, openaiCodex } from "./providers/openai.ts";
import type { Provider } from "./types.ts";

export const providers = new Map<string, Provider>([
  [anthropic.id, anthropic],
  [openai.id, openai],
  [openaiCodex.id, openaiCodex],
  [gemini.id, gemini],
]);

export function getProvider(id: string): Provider {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}
