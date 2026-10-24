import {
  type AuthFile,
  builtinProviderConfigs,
  listModels,
  loginGitHubCopilot,
  loginKimiCoding,
  loginOpenAI,
  loginOpenRouter,
  loginXai,
} from "mu";

export interface AccountLoginOptions {
  onAuthUrl?: (url: string) => void | Promise<void>;
  onDeviceCode?: (url: string, code: string) => void | Promise<void>;
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

export interface LogoutProvider {
  id: string;
  name: string;
  description: string;
  credentialType: "apiKey" | "oauth";
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
    id: "openai-codex",
    name: "OpenAI",
    description: "ChatGPT plan",
    successMessage: "Signed in to OpenAI with your ChatGPT plan.",
    login: loginOpenAI,
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    description: "Copilot plan",
    successMessage: "Signed in to GitHub Copilot.",
    login: loginGitHubCopilot,
  },
  {
    id: "kimi-coding",
    name: "Kimi Code",
    description: "Kimi Code plan",
    successMessage: "Signed in to Kimi Code.",
    login: loginKimiCoding,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "OpenRouter account",
    successMessage: "Signed in to OpenRouter.",
    login: loginOpenRouter,
  },
  {
    id: "xai",
    name: "xAI",
    description: "Grok plan",
    successMessage: "Signed in to xAI.",
    login: loginXai,
  },
];

export function providerName(provider: string): string {
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    "openai-codex": "OpenAI",
    google: "Google",
    "github-copilot": "GitHub Copilot",
    "kimi-coding": "Kimi Code",
    openrouter: "OpenRouter",
    xai: "xAI",
    zai: "Z.AI",
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
  return [
    ...new Set(
      [...builtinProviderConfigs.keys(), ...listModels().map((model) => model.provider)].filter(
        (provider) => provider !== "openai-codex",
      ),
    ),
  ].map((id) => ({
    id,
    name: providerName(id),
  }));
}

export function logoutProviders(auth: AuthFile): LogoutProvider[] {
  return Object.entries(auth.providers)
    .map(([id, credential]) => ({
      id,
      name: providerName(id),
      description:
        credential.type === "oauth"
          ? (accountLoginProviders.find((provider) => provider.id === id)?.description ?? "account")
          : "API key",
      credentialType: credential.type,
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.description.localeCompare(right.description),
    );
}
