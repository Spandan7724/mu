import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credential } from "@mu/ai";
import { authErrorPage, authSuccessPage } from "./auth-page.ts";

const AUTH_VERSION = 1;
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_DISPLAY_NAME = "OpenAI";
const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const REFRESH_SKEW_MS = 60_000;
const REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOGIN_PORTS = [1455, 1457];

export interface StoredApiKey {
  type: "apiKey";
  apiKey: string;
}

export interface StoredOpenAiOAuth {
  type: "oauth";
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
  accountId: string;
}

export interface StoredPlanOAuth {
  type: "oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  idToken?: string;
  baseUrl?: string;
}

export type StoredCredential = StoredApiKey | StoredPlanOAuth;

export interface AuthFile {
  version: 1;
  activeProvider?: string;
  providers: Record<string, StoredCredential>;
}

export interface AuthStoreOptions {
  authFile?: string;
  fetch?: typeof fetch;
  now?: () => number;
  openAiIssuer?: string;
  openAiClientId?: string;
}

export interface OpenAiLoginOptions extends AuthStoreOptions {
  port?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  onAuthUrl?: (url: string) => void | Promise<void>;
  // Injectable localhost callback transport for deterministic/offline tests.
  callbackServer?: (state: string, signal: AbortSignal) => Promise<OpenAiCallbackServer>;
}

export interface OpenAiLoginResult {
  provider: "openai-codex";
  accountId: string;
}

export interface PlanLoginOptions extends AuthStoreOptions {
  signal?: AbortSignal;
  onAuthUrl?: (url: string) => void | Promise<void>;
  onDeviceCode?: (url: string, code: string) => void | Promise<void>;
  callbackServer?: (provider: string, signal?: AbortSignal) => Promise<PlanLoginCallbackServer>;
}

export interface PlanLoginResult {
  provider: "github-copilot" | "kimi-coding" | "openrouter" | "xai";
}

export interface PlanLoginCallbackServer {
  callbackUrl: string;
  code: Promise<string>;
  close: () => void;
}

export interface OpenAiCallbackServer {
  redirectUri: string;
  callback: Promise<string>;
  close: () => void;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
}

interface JwtClaims {
  exp?: unknown;
  [OPENAI_AUTH_CLAIM]?: {
    chatgpt_account_id?: unknown;
  };
}

export function defaultAuthFile(): string {
  return join(homedir(), ".mu", "auth.json");
}

function emptyAuthFile(): AuthFile {
  return { version: AUTH_VERSION, providers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredCredential(value: unknown, provider: string): StoredCredential {
  if (!isRecord(value)) throw new Error(`Invalid stored credentials for "${provider}"`);
  if (value.type === "apiKey" && typeof value.apiKey === "string" && value.apiKey.length > 0) {
    return { type: "apiKey", apiKey: value.apiKey };
  }
  if (
    value.type === "oauth" &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt)
  ) {
    if (
      (provider === "openai" || provider === OPENAI_CODEX_PROVIDER) &&
      (typeof value.accountId !== "string" || value.accountId.length === 0)
    ) {
      throw new Error(`Invalid stored credentials for "${provider}"`);
    }
    return {
      type: "oauth",
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      ...(typeof value.idToken === "string" ? { idToken: value.idToken } : {}),
      expiresAt: value.expiresAt,
      ...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
      ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : {}),
    };
  }
  throw new Error(`Invalid stored credentials for "${provider}"`);
}

export async function readAuthFile(options: AuthStoreOptions = {}): Promise<AuthFile> {
  const path = options.authFile ?? defaultAuthFile();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAuthFile();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse authentication file: ${path}`);
  }
  if (!isRecord(parsed) || parsed.version !== AUTH_VERSION || !isRecord(parsed.providers)) {
    throw new Error(`Unsupported authentication file: ${path}`);
  }

  const providers: Record<string, StoredCredential> = {};
  for (const [provider, credential] of Object.entries(parsed.providers)) {
    const stored = parseStoredCredential(credential, provider);
    const normalizedProvider =
      provider === "openai" && stored.type === "oauth" ? OPENAI_CODEX_PROVIDER : provider;
    if (normalizedProvider === provider) providers[normalizedProvider] = stored;
    else providers[normalizedProvider] ??= stored;
  }
  const activeProvider =
    parsed.activeProvider === "openai" &&
    !providers.openai &&
    providers[OPENAI_CODEX_PROVIDER]?.type === "oauth"
      ? OPENAI_CODEX_PROVIDER
      : parsed.activeProvider;

  // Repair overly broad permissions on Unix. Windows ignores POSIX mode bits.
  if (process.platform !== "win32") {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
  }

  return {
    version: AUTH_VERSION,
    ...(typeof activeProvider === "string" ? { activeProvider } : {}),
    providers,
  };
}

async function writeAuthFile(file: AuthFile, options: AuthStoreOptions = {}): Promise<void> {
  const path = options.authFile ?? defaultAuthFile();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const temporary = join(directory, `.auth-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function saveApiKey(
  provider: string,
  apiKey: string,
  options: AuthStoreOptions = {},
): Promise<void> {
  const normalizedProvider = provider.trim();
  const normalizedKey = apiKey.trim();
  if (!normalizedProvider) throw new Error("Provider is required");
  if (!normalizedKey) throw new Error("API key cannot be empty");
  const file = await readAuthFile(options);
  file.providers[normalizedProvider] = { type: "apiKey", apiKey: normalizedKey };
  file.activeProvider = normalizedProvider;
  await writeAuthFile(file, options);
}

export async function removeStoredCredential(
  provider: string,
  options: AuthStoreOptions = {},
): Promise<boolean> {
  const normalizedProvider = provider.trim();
  if (!normalizedProvider) throw new Error("Provider is required");
  const file = await readAuthFile(options);
  if (!file.providers[normalizedProvider]) return false;

  delete file.providers[normalizedProvider];
  if (file.activeProvider === normalizedProvider) {
    const nextProvider = Object.keys(file.providers)[0];
    if (nextProvider) file.activeProvider = nextProvider;
    else delete file.activeProvider;
  }
  await writeAuthFile(file, options);
  return true;
}

export async function storedAuthProviders(options: AuthStoreOptions = {}): Promise<string[]> {
  return Object.keys((await readAuthFile(options)).providers);
}

export async function preferredAuthProvider(
  options: AuthStoreOptions = {},
): Promise<string | undefined> {
  const file = await readAuthFile(options);
  return file.activeProvider && file.providers[file.activeProvider]
    ? file.activeProvider
    : Object.keys(file.providers)[0];
}

async function saveOAuthCredential(
  provider: string,
  credential: StoredPlanOAuth,
  options: AuthStoreOptions,
): Promise<void> {
  const file = await readAuthFile(options);
  file.providers[provider] = credential;
  file.activeProvider = provider;
  await writeAuthFile(file, options);
}

function decodeJwt(token: string): JwtClaims | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? (parsed as JwtClaims) : undefined;
  } catch {
    return undefined;
  }
}

function accountIdFromToken(token: string): string | undefined {
  const accountId = decodeJwt(token)?.[OPENAI_AUTH_CLAIM]?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

function expirationFromToken(token: string): number | undefined {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1_000 : undefined;
}

function tokenError(operation: string, response: Response, detail: string): Error {
  const suffix = detail.trim() ? `: ${detail.trim().slice(0, 1_000)}` : "";
  return new Error(`OpenAI token ${operation} failed (${response.status})${suffix}`);
}

async function readTokenResponse(
  response: Response,
  operation: "exchange" | "refresh",
): Promise<TokenResponse> {
  if (!response.ok) throw tokenError(operation, response, await response.text().catch(() => ""));
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error(`OpenAI token ${operation} returned invalid JSON`);
  return value;
}

function storedOauthFromResponse(
  response: TokenResponse,
  now: number,
  previous?: StoredOpenAiOAuth,
): StoredOpenAiOAuth {
  const accessToken =
    typeof response.access_token === "string" ? response.access_token : previous?.accessToken;
  const refreshToken =
    typeof response.refresh_token === "string" ? response.refresh_token : previous?.refreshToken;
  const idToken = typeof response.id_token === "string" ? response.id_token : previous?.idToken;
  if (!accessToken || !refreshToken) {
    throw new Error("OpenAI token response is missing access or refresh token");
  }

  const accountId =
    accountIdFromToken(accessToken) ??
    (idToken ? accountIdFromToken(idToken) : undefined) ??
    previous?.accountId;
  if (!accountId) throw new Error("OpenAI token did not include a ChatGPT account");
  if (previous?.accountId && accountId !== previous.accountId) {
    throw new Error("Refusing to rotate OpenAI credentials across ChatGPT accounts");
  }

  const expiresIn =
    typeof response.expires_in === "number" && Number.isFinite(response.expires_in)
      ? response.expires_in * 1_000
      : undefined;
  const expiresAt =
    expirationFromToken(accessToken) ??
    (expiresIn !== undefined ? now + expiresIn : now + 3_600_000);
  return {
    type: "oauth",
    accessToken,
    refreshToken,
    ...(idToken ? { idToken } : {}),
    expiresAt,
    accountId,
  };
}

async function refreshOpenAi(
  previous: StoredOpenAiOAuth,
  options: AuthStoreOptions,
): Promise<StoredOpenAiOAuth> {
  const issuer = (options.openAiIssuer ?? OPENAI_ISSUER).replace(/\/+$/, "");
  const response = await (options.fetch ?? fetch)(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: options.openAiClientId ?? OPENAI_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: previous.refreshToken,
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  return storedOauthFromResponse(
    await readTokenResponse(response, "refresh"),
    (options.now ?? Date.now)(),
    previous,
  );
}

function runtimeCredential(stored: StoredPlanOAuth): Credential {
  return {
    type: "oauth",
    accessToken: stored.accessToken,
    ...(stored.accountId ? { accountId: stored.accountId } : {}),
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
  };
}

async function readJsonObject(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${operation} returned invalid JSON (${response.status})`);
  }
  if (!response.ok) {
    const record =
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const detail = record.error_description ?? record.message ?? record.error;
    throw new Error(
      `${operation} failed (${response.status})${typeof detail === "string" ? `: ${detail}` : ""}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operation} returned invalid JSON`);
  }
  return value as Record<string, unknown>;
}

function oauthTokens(
  value: Record<string, unknown>,
  previous: StoredPlanOAuth,
  skewMs = 60_000,
): StoredPlanOAuth {
  const accessToken =
    typeof value.access_token === "string" ? value.access_token : previous.accessToken;
  const refreshToken =
    typeof value.refresh_token === "string" ? value.refresh_token : previous.refreshToken;
  const expiresIn =
    typeof value.expires_in === "number" && Number.isFinite(value.expires_in)
      ? value.expires_in
      : 3_600;
  if (!accessToken || !refreshToken) throw new Error("OAuth response is missing tokens");
  return {
    ...previous,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1_000 - skewMs,
  };
}

function copilotBaseUrl(token: string): string {
  const host = token.match(/(?:^|;)proxy-ep=([^;]+)/)?.[1];
  return host
    ? `https://${host.replace(/^proxy\./, "api.")}`
    : "https://api.individual.githubcopilot.com";
}

async function refreshPlanOAuth(
  provider: string,
  previous: StoredPlanOAuth,
  options: AuthStoreOptions,
): Promise<StoredPlanOAuth> {
  const doFetch = options.fetch ?? fetch;
  if (provider === "kimi-coding") {
    const response = await doFetch("https://auth.kimi.com/api/oauth/token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
        grant_type: "refresh_token",
        refresh_token: previous.refreshToken,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    return oauthTokens(await readJsonObject(response, "Kimi Code token refresh"), previous);
  }
  if (provider === "xai") {
    const response = await doFetch("https://auth.x.ai/oauth2/token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        grant_type: "refresh_token",
        refresh_token: previous.refreshToken,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    return oauthTokens(await readJsonObject(response, "xAI token refresh"), previous, 5 * 60_000);
  }
  if (provider === "github-copilot") {
    const response = await doFetch("https://api.github.com/copilot_internal/v2/token", {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${previous.refreshToken}`,
        "user-agent": "GitHubCopilotChat/0.35.0",
        "editor-version": "vscode/1.107.0",
        "editor-plugin-version": "copilot-chat/0.35.0",
        "copilot-integration-id": "vscode-chat",
      },
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    const value = await readJsonObject(response, "GitHub Copilot token refresh");
    if (typeof value.token !== "string" || typeof value.expires_at !== "number") {
      throw new Error("GitHub Copilot token refresh returned invalid credentials");
    }
    return {
      ...previous,
      accessToken: value.token,
      expiresAt: value.expires_at * 1_000 - 5 * 60_000,
      baseUrl: copilotBaseUrl(value.token),
    };
  }
  if (provider === OPENAI_CODEX_PROVIDER) {
    if (!previous.accountId) throw new Error("OpenAI login is missing its ChatGPT account");
    return refreshOpenAi(previous as StoredOpenAiOAuth, options);
  }
  throw new Error(`OAuth refresh is not implemented for provider "${provider}"`);
}

export function createCredentialResolver(
  options: AuthStoreOptions = {},
): (provider: string) => Promise<Credential | undefined> {
  const refreshes = new Map<string, Promise<Credential>>();
  return async (provider) => {
    const file = await readAuthFile(options);
    const stored = file.providers[provider];
    if (!stored) return undefined;
    if (stored.type === "apiKey") return { type: "apiKey", apiKey: stored.apiKey };

    const now = (options.now ?? Date.now)();
    if (stored.expiresAt > now + REFRESH_SKEW_MS) {
      return runtimeCredential(stored);
    }
    const activeRefresh = refreshes.get(provider);
    if (activeRefresh) return activeRefresh;

    const refresh = (async () => {
      // Another process may have refreshed since this invocation first read.
      const latestFile = await readAuthFile(options);
      const latest = latestFile.providers[provider];
      if (!latest || latest.type !== "oauth") {
        throw new Error(`${provider} login is no longer available`);
      }
      const latestNow = (options.now ?? Date.now)();
      const next =
        latest.expiresAt > latestNow + REFRESH_SKEW_MS
          ? latest
          : await refreshPlanOAuth(provider, latest, options);
      if (next !== latest) {
        latestFile.providers[provider] = next;
        await writeAuthFile(latestFile, options);
      }
      return runtimeCredential(next);
    })().finally(() => {
      refreshes.delete(provider);
    });
    refreshes.set(provider, refresh);
    return refresh;
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine OAuth callback port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function startCallbackServer(
  state: string,
  requestedPort: number | undefined,
  signal: AbortSignal,
): Promise<OpenAiCallbackServer> {
  if (signal.aborted) throw new Error("OpenAI login cancelled");
  const ports = requestedPort === undefined ? DEFAULT_LOGIN_PORTS : [requestedPort];
  let lastError: unknown;
  for (const port of ports) {
    let resolveCode: (code: string) => void = () => {};
    let rejectCode: (error: Error) => void = () => {};
    const callback = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    let settled = false;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (url.pathname !== "/auth/callback") {
        response.statusCode = 404;
        response.end(authErrorPage(OPENAI_DISPLAY_NAME, "That page does not exist."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response.statusCode = 400;
        response.end(
          authErrorPage(OPENAI_DISPLAY_NAME, "State mismatch. Return to mu and try again."),
        );
        return;
      }
      const oauthError = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (oauthError || !code) {
        response.statusCode = 400;
        response.end(authErrorPage(OPENAI_DISPLAY_NAME, "Return to mu and try again."));
        if (!settled) {
          settled = true;
          rejectCode(
            new Error(`OpenAI login failed: ${oauthError ?? "missing authorization code"}`),
          );
        }
        return;
      }
      response.end(authSuccessPage(OPENAI_DISPLAY_NAME));
      if (!settled) {
        settled = true;
        resolveCode(code);
      }
    });
    try {
      const actualPort = await listen(server, port);
      const onAbort = () => {
        if (!settled) {
          settled = true;
          rejectCode(new Error("OpenAI login cancelled"));
        }
        server.close();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      return {
        redirectUri: `http://localhost:${actualPort}/auth/callback`,
        callback: callback.finally(() => signal.removeEventListener("abort", onAbort)),
        close: () => server.close(),
      };
    } catch (error) {
      lastError = error;
      server.close();
    }
  }
  throw new Error(
    `Could not start OpenAI login callback server: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function loginOpenAI(options: OpenAiLoginOptions = {}): Promise<OpenAiLoginResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  timeout.unref?.();
  const state = randomBytes(32).toString("base64url");
  const codes = pkce();
  const issuer = (options.openAiIssuer ?? OPENAI_ISSUER).replace(/\/+$/, "");
  let callback: OpenAiCallbackServer | undefined;
  try {
    callback = options.callbackServer
      ? await options.callbackServer(state, controller.signal)
      : await startCallbackServer(state, options.port, controller.signal);
    const authorize = new URL(`${issuer}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: options.openAiClientId ?? OPENAI_CLIENT_ID,
      redirect_uri: callback.redirectUri,
      scope: OPENAI_SCOPE,
      code_challenge: codes.challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "mu",
    }).toString();
    await options.onAuthUrl?.(authorize.toString());
    const code = await callback.callback;

    const response = await (options.fetch ?? fetch)(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: options.openAiClientId ?? OPENAI_CLIENT_ID,
        code,
        code_verifier: codes.verifier,
        redirect_uri: callback.redirectUri,
      }),
      signal: controller.signal,
    });
    const credential = storedOauthFromResponse(
      await readTokenResponse(response, "exchange"),
      (options.now ?? Date.now)(),
    );
    const file = await readAuthFile(options);
    file.providers[OPENAI_CODEX_PROVIDER] = credential;
    file.activeProvider = OPENAI_CODEX_PROVIDER;
    await writeAuthFile(file, options);
    return { provider: OPENAI_CODEX_PROVIDER, accountId: credential.accountId };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    callback?.close();
  }
}

function requiredString(value: Record<string, unknown>, field: string, provider: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`${provider} response is missing ${field}`);
  }
  return result;
}

function trustedHttpUrl(value: string, provider: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${provider} returned an invalid authorization URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${provider} returned an unsafe authorization URL`);
  }
  return url.toString();
}

function trustedHttpsUrl(value: string, provider: string): string {
  const url = trustedHttpUrl(value, provider);
  if (!url.startsWith("https:")) {
    throw new Error(`${provider} returned an unsafe authorization URL`);
  }
  return url;
}

function positiveSeconds(value: Record<string, unknown>, field: string, fallback: number): number {
  const result = value[field];
  return typeof result === "number" && Number.isFinite(result) && result > 0 ? result : fallback;
}

async function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Login cancelled");
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Login cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function pollDeviceToken(options: {
  fetch: typeof fetch;
  url: string;
  fields: Record<string, string>;
  intervalSeconds: number;
  expiresInSeconds: number;
  signal?: AbortSignal;
  provider: string;
}): Promise<Record<string, unknown>> {
  const deadline = Date.now() + options.expiresInSeconds * 1_000;
  let interval = Math.max(0.05, options.intervalSeconds);
  while (Date.now() < deadline) {
    await waitFor(interval * 1_000, options.signal);
    const response = await options.fetch(options.url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(options.fields),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const value = await readJsonObject(
      response.status >= 400 && response.status < 500
        ? new Response(await response.text(), { status: 200, headers: response.headers })
        : response,
      `${options.provider} device token request`,
    );
    if (response.ok && typeof value.access_token === "string") return value;
    if (value.error === "authorization_pending") continue;
    if (value.error === "slow_down") {
      interval = positiveSeconds(value, "interval", interval + 5);
      continue;
    }
    throw new Error(
      `${options.provider} login failed${
        typeof value.error_description === "string"
          ? `: ${value.error_description}`
          : typeof value.error === "string"
            ? `: ${value.error}`
            : ""
      }`,
    );
  }
  throw new Error(`${options.provider} login timed out`);
}

async function deviceAuthorization(
  options: PlanLoginOptions,
  provider: string,
  url: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return readJsonObject(response, `${provider} device authorization`);
}

export async function loginKimiCoding(options: PlanLoginOptions = {}): Promise<PlanLoginResult> {
  const clientId = "17e5f671-d194-4dfb-9706-5516cb48c098";
  const doFetch = options.fetch ?? fetch;
  const device = await deviceAuthorization(
    options,
    "Kimi Code",
    "https://auth.kimi.com/api/oauth/device_authorization",
    { client_id: clientId },
  );
  const verificationUrl =
    typeof device.verification_uri_complete === "string"
      ? trustedHttpUrl(device.verification_uri_complete, "Kimi Code")
      : trustedHttpUrl(requiredString(device, "verification_uri", "Kimi Code"), "Kimi Code");
  const userCode = requiredString(device, "user_code", "Kimi Code");
  await options.onDeviceCode?.(verificationUrl, userCode);
  await options.onAuthUrl?.(verificationUrl);
  const token = await pollDeviceToken({
    fetch: doFetch,
    url: "https://auth.kimi.com/api/oauth/token",
    fields: {
      client_id: clientId,
      device_code: requiredString(device, "device_code", "Kimi Code"),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    intervalSeconds: positiveSeconds(device, "interval", 5),
    expiresInSeconds: positiveSeconds(device, "expires_in", 15 * 60),
    ...(options.signal ? { signal: options.signal } : {}),
    provider: "Kimi Code",
  });
  const expiresIn = positiveSeconds(token, "expires_in", 3_600);
  await saveOAuthCredential(
    "kimi-coding",
    {
      type: "oauth",
      accessToken: requiredString(token, "access_token", "Kimi Code"),
      refreshToken: requiredString(token, "refresh_token", "Kimi Code"),
      expiresAt: (options.now ?? Date.now)() + expiresIn * 1_000,
    },
    options,
  );
  return { provider: "kimi-coding" };
}

export async function loginXai(options: PlanLoginOptions = {}): Promise<PlanLoginResult> {
  const clientId = "b1a00492-073a-47ea-816f-4c329264a828";
  const doFetch = options.fetch ?? fetch;
  const device = await deviceAuthorization(options, "xAI", "https://auth.x.ai/oauth2/device/code", {
    client_id: clientId,
    scope: "openid profile email offline_access grok-cli:access api:access",
    referrer: "mu",
  });
  const verificationUrl =
    typeof device.verification_uri_complete === "string"
      ? trustedHttpsUrl(device.verification_uri_complete, "xAI")
      : trustedHttpsUrl(requiredString(device, "verification_uri", "xAI"), "xAI");
  const userCode = requiredString(device, "user_code", "xAI");
  await options.onDeviceCode?.(verificationUrl, userCode);
  await options.onAuthUrl?.(verificationUrl);
  const token = await pollDeviceToken({
    fetch: doFetch,
    url: "https://auth.x.ai/oauth2/token",
    fields: {
      client_id: clientId,
      device_code: requiredString(device, "device_code", "xAI"),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    intervalSeconds: positiveSeconds(device, "interval", 5),
    expiresInSeconds: positiveSeconds(device, "expires_in", 15 * 60),
    ...(options.signal ? { signal: options.signal } : {}),
    provider: "xAI",
  });
  const expiresIn = positiveSeconds(token, "expires_in", 3_600);
  await saveOAuthCredential(
    "xai",
    {
      type: "oauth",
      accessToken: requiredString(token, "access_token", "xAI"),
      refreshToken: requiredString(token, "refresh_token", "xAI"),
      expiresAt: (options.now ?? Date.now)() + expiresIn * 1_000 - 5 * 60_000,
    },
    options,
  );
  return { provider: "xai" };
}

export async function loginGitHubCopilot(options: PlanLoginOptions = {}): Promise<PlanLoginResult> {
  const clientId = Buffer.from("SXYxLmI1MDdhMDhjODdlY2ZlOTg=", "base64").toString("utf8");
  const doFetch = options.fetch ?? fetch;
  const device = await deviceAuthorization(
    options,
    "GitHub Copilot",
    "https://github.com/login/device/code",
    { client_id: clientId, scope: "read:user" },
  );
  const verificationUrl = trustedHttpUrl(
    requiredString(device, "verification_uri", "GitHub Copilot"),
    "GitHub Copilot",
  );
  const userCode = requiredString(device, "user_code", "GitHub Copilot");
  await options.onDeviceCode?.(verificationUrl, userCode);
  await options.onAuthUrl?.(verificationUrl);
  const github = await pollDeviceToken({
    fetch: doFetch,
    url: "https://github.com/login/oauth/access_token",
    fields: {
      client_id: clientId,
      device_code: requiredString(device, "device_code", "GitHub Copilot"),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    intervalSeconds: positiveSeconds(device, "interval", 5),
    expiresInSeconds: positiveSeconds(device, "expires_in", 15 * 60),
    ...(options.signal ? { signal: options.signal } : {}),
    provider: "GitHub Copilot",
  });
  const githubToken = requiredString(github, "access_token", "GitHub Copilot");
  const response = await doFetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${githubToken}`,
      "user-agent": "GitHubCopilotChat/0.35.0",
      "editor-version": "vscode/1.107.0",
      "editor-plugin-version": "copilot-chat/0.35.0",
      "copilot-integration-id": "vscode-chat",
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const copilot = await readJsonObject(response, "GitHub Copilot token exchange");
  const accessToken = requiredString(copilot, "token", "GitHub Copilot");
  const expiresAt = copilot.expires_at;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new Error("GitHub Copilot response is missing expires_at");
  }
  await saveOAuthCredential(
    "github-copilot",
    {
      type: "oauth",
      accessToken,
      refreshToken: githubToken,
      expiresAt: expiresAt * 1_000 - 5 * 60_000,
      baseUrl: copilotBaseUrl(accessToken),
    },
    options,
  );
  return { provider: "github-copilot" };
}

async function startBrowserCodeServer(
  provider: string,
  signal?: AbortSignal,
): Promise<PlanLoginCallbackServer> {
  const path = `/oauth/callback/${randomBytes(18).toString("base64url")}`;
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let settled = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname !== path) {
      response.statusCode = 404;
      response.end(authErrorPage(provider, "That page does not exist."));
      return;
    }
    const error = url.searchParams.get("error");
    const authorizationCode = url.searchParams.get("code");
    if (error || !authorizationCode) {
      response.statusCode = 400;
      response.end(authErrorPage(provider, "Authorization was not completed."));
      if (!settled) {
        settled = true;
        rejectCode(new Error(`${provider} login failed: ${error ?? "missing authorization code"}`));
      }
      return;
    }
    response.end(authSuccessPage(provider));
    if (!settled) {
      settled = true;
      resolveCode(authorizationCode);
    }
  });
  await listen(server, 0);
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error(`Could not start the ${provider} callback server`);
  }
  const abort = () => {
    if (!settled) {
      settled = true;
      rejectCode(new Error(`${provider} login cancelled`));
    }
    server.close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    callbackUrl: `http://127.0.0.1:${address.port}${path}`,
    code: code.finally(() => signal?.removeEventListener("abort", abort)),
    close: () => server.close(),
  };
}

export async function loginOpenRouter(options: PlanLoginOptions = {}): Promise<PlanLoginResult> {
  const codes = pkce();
  const callback = options.callbackServer
    ? await options.callbackServer("OpenRouter", options.signal)
    : await startBrowserCodeServer("OpenRouter", options.signal);
  try {
    const authorize = new URL("https://openrouter.ai/auth");
    authorize.search = new URLSearchParams({
      callback_url: callback.callbackUrl,
      code_challenge: codes.challenge,
      code_challenge_method: "S256",
    }).toString();
    await options.onAuthUrl?.(authorize.toString());
    const code = await callback.code;
    const response = await (options.fetch ?? fetch)("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: codes.verifier,
        code_challenge_method: "S256",
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const value = await readJsonObject(response, "OpenRouter key exchange");
    await saveOAuthCredential(
      "openrouter",
      {
        type: "oauth",
        accessToken: requiredString(value, "key", "OpenRouter"),
        refreshToken: "",
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      options,
    );
    return { provider: "openrouter" };
  } finally {
    callback.close();
  }
}
