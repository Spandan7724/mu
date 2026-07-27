import { describe, expect, test } from "bun:test";
import { accountLoginProviders, apiKeyLoginProviders, loginMethods } from "./login.ts";

describe("/login provider registry", () => {
  test("starts with account versus API-key authentication", () => {
    expect(loginMethods.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "account", label: "Sign in with an account" },
      { id: "apiKey", label: "Sign in with an API key" },
    ]);
  });

  test("offers the ChatGPT plan under account sign-in", () => {
    expect(
      accountLoginProviders.map(({ id, name, description }) => ({ id, name, description })),
    ).toContainEqual({
      id: "openai",
      name: "OpenAI",
      description: "ChatGPT plan",
    });
  });

  test("derives API-key choices from every catalog provider", () => {
    const providers = apiKeyLoginProviders();
    expect(providers).toContainEqual({ id: "anthropic", name: "Anthropic" });
    expect(providers).toContainEqual({ id: "openai", name: "OpenAI" });
    expect(providers).toContainEqual({ id: "google", name: "Google" });
    expect(new Set(providers.map((provider) => provider.id)).size).toBe(providers.length);
  });
});
