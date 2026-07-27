import { listModels, loginOpenAI } from "mu";

export interface AccountLoginOptions {
  onAuthUrl?: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface AccountLoginProvider {
  id: string;
  name: string;
  description: string;
  successMessage: string;
  login: (options: AccountLoginOptions) => Promise<unknown>;
}

export interface ApiKeyLoginProvider {
  id: string;
  name: string;
}

export interface LoginMethod {
  id: "account" | "apiKey";
  label: string;
  description: string;
}

export const loginMethods: LoginMethod[] = [
  {
    id: "account",
    label: "Sign in with an account",
    description: "Use a provider subscription or plan",
  },
  {
    id: "apiKey",
    label: "Sign in with an API key",
    description: "Store a provider API key",
  },
];

export const accountLoginProviders: AccountLoginProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "ChatGPT plan",
    successMessage: "Signed in to OpenAI with your ChatGPT plan.",
    login: loginOpenAI,
  },
];

export function providerName(provider: string): string {
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
  };
  return (
    known[provider] ??
    provider
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function apiKeyLoginProviders(): ApiKeyLoginProvider[] {
  return [...new Set(listModels().map((model) => model.provider))].map((id) => ({
    id,
    name: providerName(id),
  }));
}
