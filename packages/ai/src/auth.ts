import { AiError } from "./errors.ts";
import type { Credential, StreamOpts } from "./types.ts";

// Resolution order: explicit resolver → explicit apiKey → env var.
export async function resolveCredential(
  provider: string,
  envVar: string,
  opts?: StreamOpts,
): Promise<Credential> {
  if (opts?.getCredentials) return opts.getCredentials();
  const apiKey = opts?.apiKey ?? process.env[envVar];
  if (!apiKey) {
    throw new AiError("auth", `No API key for provider "${provider}" (set ${envVar})`);
  }
  return { type: "apiKey", apiKey };
}
