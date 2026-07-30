import { AiError } from "./errors.ts";
import type { Credential, StreamOpts } from "./types.ts";

export async function resolveCredential(
  provider: string,
  envVar: string | undefined,
  opts?: StreamOpts,
): Promise<Credential> {
  const resolved = await opts?.getCredentials?.();
  if (resolved) return resolved;
  const apiKey = opts?.apiKey ?? (envVar ? process.env[envVar] : undefined);
  if (!apiKey) {
    const setup = envVar ? `set ${envVar} or run /login` : "run /login";
    throw new AiError("auth", `No credentials for provider "${provider}" (${setup})`);
  }
  return { type: "apiKey", apiKey };
}
