import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createCredentialResolver,
  loginGitHubCopilot,
  loginKimiCoding,
  loginOpenRouter,
  loginXai,
  readAuthFile,
} from "./auth.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function authPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mu-plan-auth-"));
  roots.push(root);
  return join(root, ".mu", "auth.json");
}

describe("coding-plan account authentication", () => {
  test("stores and resolves Kimi Code device-flow credentials", async () => {
    const authFile = await authPath();
    const notices: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/device_authorization")) {
        return Response.json({
          device_code: "device",
          user_code: "KIMI-CODE",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?code=KIMI-CODE",
          interval: 0.001,
          expires_in: 30,
        });
      }
      return Response.json({
        access_token: "kimi-access",
        refresh_token: "kimi-refresh",
        expires_in: 3_600,
      });
    }) as typeof fetch;

    await loginKimiCoding({
      authFile,
      fetch: fakeFetch,
      now: () => 1_000,
      onDeviceCode: (_url, code) => {
        notices.push(code);
      },
    });

    expect(notices).toEqual(["KIMI-CODE"]);
    expect((await readAuthFile({ authFile })).activeProvider).toBe("kimi-coding");
    expect(await createCredentialResolver({ authFile, now: () => 2_000 })("kimi-coding")).toEqual({
      type: "oauth",
      accessToken: "kimi-access",
    });
  });

  test("stores xAI subscription credentials without adding Anthropic account auth", async () => {
    const authFile = await authPath();
    const fakeFetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/device/code")) {
        return Response.json({
          device_code: "device",
          user_code: "XAI-CODE",
          verification_uri: "https://auth.x.ai/device",
          interval: 0.001,
          expires_in: 30,
        });
      }
      return Response.json({
        access_token: "xai-access",
        refresh_token: "xai-refresh",
        expires_in: 3_600,
      });
    }) as typeof fetch;

    await loginXai({ authFile, fetch: fakeFetch, now: () => 1_000 });
    const auth = await readAuthFile({ authFile });
    expect(auth.providers.xai?.type).toBe("oauth");
    expect(auth.providers.anthropic).toBeUndefined();
  });

  test("exchanges a GitHub device token for a Copilot request token", async () => {
    const authFile = await authPath();
    let modelFetches = 0;
    const enabled: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) {
        return Response.json({
          device_code: "device",
          user_code: "GITHUB-CODE",
          verification_uri: "https://github.com/login/device",
          interval: 0.001,
          expires_in: 30,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return Response.json({ access_token: "github-access" });
      }
      if (url.endsWith("/models") && init?.method !== "POST") {
        modelFetches++;
        return Response.json({
          data: [
            {
              id: "gpt-5.3-codex",
              model_picker_enabled: modelFetches > 1,
              policy: { state: modelFetches > 1 ? "enabled" : "disabled" },
              capabilities: { supports: { tool_calls: true } },
            },
            {
              id: "gpt-no-tools",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: { supports: { tool_calls: false } },
            },
          ],
        });
      }
      if (url.includes("/models/") && url.endsWith("/policy")) {
        enabled.push(decodeURIComponent(url.split("/models/")[1]?.replace("/policy", "") ?? ""));
        return new Response("", { status: 200 });
      }
      return Response.json({
        token: "tid=x;proxy-ep=proxy.individual.githubcopilot.com;exp=x",
        expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      });
    }) as typeof fetch;

    await loginGitHubCopilot({ authFile, fetch: fakeFetch });
    expect(await createCredentialResolver({ authFile })("github-copilot")).toMatchObject({
      type: "oauth",
      baseUrl: "https://api.individual.githubcopilot.com",
      availableModelIds: ["gpt-5.3-codex"],
    });
    expect(enabled).toEqual(["gpt-5.3-codex", "gpt-no-tools"]);
  });

  test("repairs an existing Copilot login that predates account model discovery", async () => {
    const authFile = await authPath();
    await mkdir(dirname(authFile), { recursive: true });
    await writeFile(
      authFile,
      JSON.stringify({
        version: 1,
        activeProvider: "github-copilot",
        providers: {
          "github-copilot": {
            type: "oauth",
            accessToken: "old-copilot-token",
            refreshToken: "github-access",
            expiresAt: Date.now() + 3_600_000,
            baseUrl: "https://api.individual.githubcopilot.com",
          },
        },
      }),
    );
    let modelFetches = 0;
    let exchanges = 0;
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/copilot_internal/v2/token")) {
        exchanges++;
        return Response.json({
          token: "tid=x;proxy-ep=proxy.individual.githubcopilot.com;exp=x",
          expires_at: Math.floor(Date.now() / 1_000) + 3_600,
        });
      }
      if (url.endsWith("/models")) {
        modelFetches++;
        return Response.json({
          data: [
            {
              id: "gpt-5.3-codex",
              model_picker_enabled: modelFetches > 1,
              policy: { state: modelFetches > 1 ? "enabled" : "disabled" },
              capabilities: { supports: { tool_calls: true } },
            },
          ],
        });
      }
      if (url.endsWith("/policy")) return new Response("", { status: 200 });
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    expect(
      await createCredentialResolver({ authFile, fetch: fakeFetch })("github-copilot"),
    ).toMatchObject({
      availableModelIds: ["gpt-5.3-codex"],
    });
    expect(exchanges).toBe(1);
    expect((await readAuthFile({ authFile })).providers["github-copilot"]).toMatchObject({
      availableModelIds: ["gpt-5.3-codex"],
    });
  });

  test("exchanges an OpenRouter browser authorization for a stored key", async () => {
    const authFile = await authPath();
    let displayedUrl = "";
    await loginOpenRouter({
      authFile,
      fetch: (async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ key: "openrouter-key" })) as typeof fetch,
      callbackServer: async () => ({
        callbackUrl: "http://127.0.0.1:1234/oauth/callback",
        code: Promise.resolve("openrouter-code"),
        close: () => {},
      }),
      onAuthUrl: (authorizationUrl) => {
        displayedUrl = authorizationUrl;
      },
    });

    expect(new URL(displayedUrl).searchParams.get("callback_url")).toBe(
      "http://127.0.0.1:1234/oauth/callback",
    );
    expect(await createCredentialResolver({ authFile })("openrouter")).toEqual({
      type: "oauth",
      accessToken: "openrouter-key",
    });
  });

  test("rejects non-HTTP device verification URLs before displaying them", async () => {
    const authFile = await authPath();
    let displayed = false;
    await expect(
      loginKimiCoding({
        authFile,
        fetch: (async (_input: string | URL | Request, _init?: RequestInit) =>
          Response.json({
            device_code: "device",
            user_code: "CODE",
            verification_uri: "javascript:alert(1)",
          })) as typeof fetch,
        onAuthUrl: () => {
          displayed = true;
        },
      }),
    ).rejects.toThrow("unsafe authorization URL");
    expect(displayed).toBe(false);
  });
});
