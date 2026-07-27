import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultAuthFile,
  defaultModelRef,
  findModel,
  providerHasCredentials,
  readAuthFile,
} from "mu";

export interface UserConfig {
  model?: string;
  [key: string]: unknown;
}

export function userConfigPath(home = homedir()): string {
  return join(home, ".mu", "config.json");
}

function parseConfig(raw: string, file: string): UserConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid user config at ${file}: expected a JSON object`);
  }
  return parsed as UserConfig;
}

async function readUserConfig(file: string): Promise<UserConfig> {
  try {
    return parseConfig(await readFile(file, "utf8"), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function loadUserConfig(file = userConfigPath()): Promise<UserConfig> {
  return readUserConfig(file).catch(() => ({}));
}

export async function resolveCliModel(
  explicit?: string,
  file = userConfigPath(),
  authFile = defaultAuthFile(),
  env = process.env,
): Promise<string> {
  if (explicit) return explicit;
  const auth = await readAuthFile({ authFile }).catch(() => undefined);
  const authenticatedProviders = auth
    ? [
        ...(auth.activeProvider && auth.providers[auth.activeProvider]
          ? [auth.activeProvider]
          : []),
        ...Object.keys(auth.providers).filter((provider) => provider !== auth.activeProvider),
      ]
    : [];
  const configured = (await loadUserConfig(file)).model;
  if (typeof configured === "string") {
    const model = findModel(configured);
    if (
      model &&
      (authenticatedProviders.length > 0
        ? authenticatedProviders.includes(model.provider)
        : providerHasCredentials(model.provider, env))
    ) {
      return configured;
    }
  }
  return defaultModelRef(
    env,
    authenticatedProviders.length > 0 ? authenticatedProviders : undefined,
  );
}

export async function saveDefaultModel(model: string, file = userConfigPath()): Promise<void> {
  const config = await readUserConfig(file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...config, model }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
