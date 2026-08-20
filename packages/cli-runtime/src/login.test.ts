import { describe, expect, test } from "bun:test";
import {
  accountLoginProviders,
  apiKeyLoginProviders,
  loginMethods,
  logoutProviders,
  providerName,
} from "./login.ts";

describe("/login provider registry", () => {
  test("starts with account versus API-key authentication", () => {
    expect(loginMethods.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "account", label: "Sign in with an account" },
      { id: "apiKey", label: "Sign in with an API key" },
    ]);
  });

  test("offers supported account plans and excludes Anthropic account auth", () => {
    const providers = accountLoginProviders.map(({ id, name, description }) => ({
      id,
      name,
      description,
    }));
    expect(providers).toContainEqual({
      id: "openai-codex",
      name: "OpenAI",
      description: "ChatGPT plan",
    });
    expect(providers.map(({ id }) => id)).toEqual([
      "openai-codex",
      "github-copilot",
      "kimi-coding",
      "openrouter",
      "xai",
    ]);
    expect(providers.some(({ id }) => id === "anthropic")).toBe(false);
    expect(providers.some(({ id }) => id === "radius")).toBe(false);
  });

  test("derives API-key choices from every catalog provider", () => {
    const providers = apiKeyLoginProviders();
    expect(providers).toContainEqual({ id: "anthropic", name: "Anthropic" });
    expect(providers).toContainEqual({ id: "openai", name: "OpenAI" });
    expect(providers).toContainEqual({ id: "google", name: "Google" });
    expect(providers).toContainEqual({ id: "zai", name: "Z.AI" });
    expect(providers).toContainEqual({ id: "qwen-token-plan", name: "Qwen Token Plan" });
    for (const removed of [
      "ant-ling",
      "minimax-cn",
      "moonshotai-cn",
      "qwen-token-plan-cn",
      "radius",
      "together",
      "xiaomi",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-sgp",
      "zai-coding-cn",
    ]) {
      expect(providers.some(({ id }) => id === removed)).toBe(false);
    }
    expect(providers).not.toContainEqual({ id: "openai-codex", name: "Openai Codex" });
    expect(new Set(providers.map((provider) => provider.id)).size).toBe(providers.length);
  });

  test("labels stored credentials by provider and authentication route", () => {
    expect(
      logoutProviders({
        version: 1,
        activeProvider: "openai-codex",
        providers: {
          openai: { type: "apiKey", apiKey: "sk-openai" },
          "openai-codex": {
            type: "oauth",
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: Date.now() + 60_000,
            accountId: "account",
          },
          anthropic: { type: "apiKey", apiKey: "sk-ant" },
        },
      }).map(({ id, name, description, credentialType }) => ({
        id,
        name,
        description,
        credentialType,
      })),
    ).toEqual([
      {
        id: "anthropic",
        name: "Anthropic",
        description: "API key",
        credentialType: "apiKey",
      },
      {
        id: "openai",
        name: "OpenAI",
        description: "API key",
        credentialType: "apiKey",
      },
      {
        id: "openai-codex",
        name: "OpenAI",
        description: "ChatGPT plan",
        credentialType: "oauth",
      },
    ]);
    expect(providerName("openai-codex")).toBe("OpenAI");
  });
});
