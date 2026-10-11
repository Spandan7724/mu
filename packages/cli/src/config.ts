import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultAuthFile,
  defaultModelRef,
  findModel,
  type ModelInfo,
  providerHasCredentials,
  readAuthFile,
  type ThinkingLevel,
  thinkingLevelForModel,
} from "mu";
import { z } from "zod";

export interface UserConfig {
  model?: string;
  // Last thinking level chosen per model ref.
  thinking?: Record<string, string>;
  [key: string]: unknown;
}

const userConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    thinking: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .loose();

export function userConfigPath(home = homedir()): string {
  return join(home, ".mu", "config.json");
}

function parseConfig(raw: string, file: string): UserConfig {
  const parsed: unknown = JSON.parse(raw);
  const result = userConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid user config at ${file}: ${issues}`);
  }
  const { model, thinking, ...rest } = result.data;
  return {
    ...rest,
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

async function readUserConfig(file: string): Promise<UserConfig> {
  try {
    return parseConfig(await readFile(file, "utf8"), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function loadUserConfig(
  file = userConfigPath(),
  onWarning: (message: string) => void = (message) => void process.stderr.write(`${message}\n`),
): Promise<UserConfig> {
  try {
    return await readUserConfig(file);
  } catch (error) {
    onWarning(error instanceof Error ? error.message : String(error));
    return {};
  }
}

export async function resolveCliModel(
  explicit?: string,
  file = userConfigPath(),
  authFile = defaultAuthFile(),
  env = process.env,
  onWarning: (message: string) => void = (message) => void process.stderr.write(message),
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
  const fallback = () =>
    defaultModelRef(env, authenticatedProviders.length > 0 ? authenticatedProviders : undefined);
  const configured = (await loadUserConfig(file, onWarning)).model;
  if (typeof configured !== "string") return fallback();

  const model = findModel(configured);
  if (
    model &&
    (authenticatedProviders.length > 0
      ? authenticatedProviders.includes(model.provider) ||
        providerHasCredentials(model.provider, env)
      : providerHasCredentials(model.provider, env))
  ) {
    return configured;
  }
  // A refresh can drop the configured model entirely — models.dev replaces a
  // provider's whole list. Silently resolving something else leaves the config
  // saying one thing while mu runs another, on every launch.
  const resolved = fallback();
  onWarning(
    model
      ? `mu: ${configured} needs credentials you are not signed in with — using ${resolved}\n`
      : `mu: ${configured} is no longer in the model catalog — using ${resolved}\n`,
  );
  return resolved;
}

export async function saveDefaultModel(model: string, file = userConfigPath()): Promise<void> {
  const config = await readUserConfig(file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...config, model }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function saveThinkingLevel(
  model: string,
  level: string,
  file = userConfigPath(),
): Promise<void> {
  const config = await readUserConfig(file);
  await mkdir(dirname(file), { recursive: true });
  const thinking = { ...config.thinking, [model]: level };
  await writeFile(file, `${JSON.stringify({ ...config, thinking }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function savedThinkingLevel(
  config: UserConfig,
  model: ModelInfo,
): ThinkingLevel | undefined {
  const saved = config.thinking?.[`${model.provider}/${model.id}`];
  return saved ? thinkingLevelForModel(model, saved) : undefined;
}

// A model without a saved level starts at its own default rather than
// inheriting the previous model's level.
export function applySavedThinking(
  agent: { readonly modelInfo: ModelInfo; setThinking(level: ThinkingLevel): void },
  file = userConfigPath(),
): void {
  let config: UserConfig = {};
  try {
    config = parseConfig(readFileSync(file, "utf8"), file);
  } catch {
    // A missing or invalid config means no saved levels; startup already warns.
  }
  agent.setThinking(
    savedThinkingLevel(config, agent.modelInfo) ??
      thinkingLevelForModel(agent.modelInfo, undefined),
  );
}
