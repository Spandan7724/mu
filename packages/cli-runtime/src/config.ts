import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  defaultAuthFile,
  defaultModelRef,
  findModel,
  providerHasCredentials,
  readAuthFile,
} from "mu";
import { z } from "zod";

export interface UserConfig {
  model?: string;
  [key: string]: unknown;
}

const userConfigSchema = z.object({ model: z.string().min(1).optional() }).loose();

function parseConfig(raw: string, file: string): UserConfig {
  const parsed: unknown = JSON.parse(raw);
  const result = userConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid user config at ${file}: ${issues}`);
  }
  const { model, ...rest } = result.data;
  return { ...rest, ...(model !== undefined ? { model } : {}) };
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
  file: string,
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
  explicit: string | undefined,
  file: string,
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
      ? authenticatedProviders.includes(model.provider)
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
      ? `${configured} needs credentials you are not signed in with — using ${resolved}\n`
      : `${configured} is no longer in the model catalog — using ${resolved}\n`,
  );
  return resolved;
}

export async function saveDefaultModel(model: string, file: string): Promise<void> {
  const config = await readUserConfig(file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...config, model }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
