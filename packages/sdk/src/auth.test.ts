import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialResolver, loginOpenAI, readAuthFile, saveApiKey } from "./auth.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function authPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mu-auth-"));
  roots.push(root);
  return join(root, ".mu", "auth.json");
}

function jwt(accountId: string, exp = Math.floor(Date.now() / 1_000) + 3_600): string {
  const payload = Buffer.from(
    JSON.stringify({
      exp,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `e30.${payload}.signature`;
}

async function completeLocalCallback(authUrl: string): Promise<void> {
  const authorize = new URL(authUrl);
  const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  redirect.searchParams.set("code", "local-code");
  redirect.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  expect((await fetch(redirect)).status).toBe(200);
}

describe("credential storage", () => {
  test("stores provider-indexed API keys with private permissions", async () => {
    const authFile = await authPath();
    await saveApiKey("anthropic", "sk-ant", { authFile });
    await saveApiKey("openai", "sk-openai", { authFile });

    const file = await readAuthFile({ authFile });
    expect(file.activeProvider).toBe("openai");
    expect(file.providers).toEqual({
      anthropic: { type: "apiKey", apiKey: "sk-ant" },
      openai: { type: "apiKey", apiKey: "sk-openai" },
    });
    if (process.platform !== "win32") {
      expect((await stat(authFile)).mode & 0o777).toBe(0o600);
    }

    const resolver = createCredentialResolver({ authFile });
    expect(await resolver("anthropic")).toEqual({ type: "apiKey", apiKey: "sk-ant" });
    expect(await resolver("google")).toBeUndefined();
  });

  test("does not overwrite a malformed auth file", async () => {
    const authFile = await authPath();
    await writeFile(authFile, "{broken", { encoding: "utf8" }).catch(async () => {
      // The nested .mu directory does not exist until the first store write.
      await saveApiKey("openai", "seed", { authFile });
      await writeFile(authFile, "{broken", "utf8");
    });
    await expect(saveApiKey("openai", "replacement", { authFile })).rejects.toThrow(
      "Could not parse authentication file",
    );
    expect(await readFile(authFile, "utf8")).toBe("{broken");
  });
});

describe("OpenAI account login", () => {
  test("accepts the authorization code through the real localhost callback", async () => {
    const authFile = await authPath();
    const exchange: { code: string | null } = { code: null };
    await loginOpenAI({
      authFile,
      port: 0,
      onAuthUrl: completeLocalCallback,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        exchange.code = new URLSearchParams(String(init?.body)).get("code");
        return Response.json({
          access_token: jwt("account-local"),
          refresh_token: "refresh-local",
          expires_in: 3_600,
        });
      }) as typeof fetch,
    });

    expect(exchange.code).toBe("local-code");
    expect((await readAuthFile({ authFile })).providers.openai).toMatchObject({
      accountId: "account-local",
    });
  });

  test("uses localhost PKCE and stores the ChatGPT account", async () => {
    const authFile = await authPath();
    let authorize: URL | undefined;
    let callbackState: string | undefined;
    let tokenBody: URLSearchParams | undefined;
    const tokenFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      tokenBody = new URLSearchParams(String(init?.body));
      return Response.json({
        access_token: jwt("account-123"),
        refresh_token: "refresh-1",
        id_token: jwt("account-123"),
        expires_in: 3_600,
      });
    }) as typeof fetch;

    const result = await loginOpenAI({
      authFile,
      fetch: tokenFetch,
      callbackServer: async (state) => {
        callbackState = state;
        return {
          redirectUri: "http://localhost:1455/auth/callback",
          callback: Promise.resolve("authorization-code"),
          close: () => {},
        };
      },
      onAuthUrl: (url) => {
        authorize = new URL(url);
      },
    });

    expect(result).toEqual({ provider: "openai", accountId: "account-123" });
    expect(authorize?.origin).toBe("https://auth.openai.com");
    expect(authorize?.pathname).toBe("/oauth/authorize");
    expect(authorize?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize?.searchParams.get("originator")).toBe("mu");
    expect(authorize?.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(authorize?.searchParams.get("state")).toBe(callbackState);
    expect(tokenBody?.get("grant_type")).toBe("authorization_code");
    expect(tokenBody?.get("code")).toBe("authorization-code");
    expect(tokenBody?.get("code_verifier")?.length).toBeGreaterThan(40);
    expect(
      createHash("sha256")
        .update(tokenBody?.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(authorize?.searchParams.get("code_challenge") ?? "");

    const file = await readAuthFile({ authFile });
    expect(file.activeProvider).toBe("openai");
    expect(file.providers.openai).toMatchObject({
      type: "oauth",
      refreshToken: "refresh-1",
      accountId: "account-123",
    });
  });

  test("refreshes once for concurrent requests and persists rotated tokens", async () => {
    const authFile = await authPath();
    let refreshCalls = 0;
    const now = Date.now();
    const tokenFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const contentType = new Headers(init?.headers).get("content-type");
      if (contentType === "application/json") {
        refreshCalls++;
        expect(JSON.parse(String(init?.body))).toEqual({
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          grant_type: "refresh_token",
          refresh_token: "refresh-old",
        });
        return Response.json({
          access_token: jwt("account-123", Math.floor(now / 1_000) + 3_600),
          refresh_token: "refresh-new",
          expires_in: 3_600,
        });
      }
      return Response.json({
        access_token: jwt("account-123", Math.floor(now / 1_000) - 10),
        refresh_token: "refresh-old",
        expires_in: 0,
      });
    }) as typeof fetch;

    await loginOpenAI({
      authFile,
      fetch: tokenFetch,
      now: () => now,
      callbackServer: async () => ({
        redirectUri: "http://localhost:1455/auth/callback",
        callback: Promise.resolve("authorization-code"),
        close: () => {},
      }),
    });
    const resolver = createCredentialResolver({ authFile, fetch: tokenFetch, now: () => now });
    const [first, second] = await Promise.all([resolver("openai"), resolver("openai")]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      type: "oauth",
      accountId: "account-123",
    });
    expect(refreshCalls).toBe(1);
    expect(await resolver("openai")).toEqual(first);
    expect((await readAuthFile({ authFile })).providers.openai).toMatchObject({
      refreshToken: "refresh-new",
    });
  });
});
