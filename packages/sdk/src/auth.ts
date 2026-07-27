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

export type StoredCredential = StoredApiKey | StoredOpenAiOAuth;

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
    (provider === "openai" || provider === OPENAI_CODEX_PROVIDER) &&
    value.type === "oauth" &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    typeof value.accountId === "string" &&
    value.accountId.length > 0
  ) {
    return {
      type: "oauth",
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      ...(typeof value.idToken === "string" ? { idToken: value.idToken } : {}),
      expiresAt: value.expiresAt,
      accountId: value.accountId,
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

export function createCredentialResolver(
  options: AuthStoreOptions = {},
): (provider: string) => Promise<Credential | undefined> {
  let refresh: Promise<Credential> | undefined;
  return async (provider) => {
    const file = await readAuthFile(options);
    const stored = file.providers[provider];
    if (!stored) return undefined;
    if (stored.type === "apiKey") return { type: "apiKey", apiKey: stored.apiKey };
    if (provider !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`OAuth refresh is not implemented for provider "${provider}"`);
    }

    const now = (options.now ?? Date.now)();
    if (stored.expiresAt > now + REFRESH_SKEW_MS) {
      return {
        type: "oauth",
        accessToken: stored.accessToken,
        accountId: stored.accountId,
      };
    }
    if (refresh) return refresh;

    refresh = (async () => {
      // Another process may have refreshed since this invocation first read.
      const latestFile = await readAuthFile(options);
      const latest = latestFile.providers[OPENAI_CODEX_PROVIDER];
      if (!latest || latest.type !== "oauth") {
        throw new Error("OpenAI login is no longer available");
      }
      const latestNow = (options.now ?? Date.now)();
      const next =
        latest.expiresAt > latestNow + REFRESH_SKEW_MS
          ? latest
          : await refreshOpenAi(latest, options);
      if (next !== latest) {
        latestFile.providers[OPENAI_CODEX_PROVIDER] = next;
        await writeAuthFile(latestFile, options);
      }
      return {
        type: "oauth",
        accessToken: next.accessToken,
        accountId: next.accountId,
      } satisfies Credential;
    })().finally(() => {
      refresh = undefined;
    });
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
