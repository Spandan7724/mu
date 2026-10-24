import {
  type Agent,
  type AuthFile,
  defaultAuthFile,
  type ExtensionHost,
  listModels,
  type ModelInfo,
  providerConfig,
  providerEnvVars,
  readAuthFile,
  type SpecialistKind,
  type SubagentRouteOverride,
  type ThinkingLevel,
} from "mu";
import { readSubagentPins, type SubagentPins, userConfigPath } from "./config.ts";

export interface SubagentRouteSources {
  extensions: ExtensionHost;
  configFile?: string;
  authFile?: string;
  env?: NodeJS.ProcessEnv;
}

// Models a subagent may be pinned to: any model whose provider you are logged into, have
// an environment key for, or that needs no credentials, plus extension models.
export function pinnableModels(
  extensions: ExtensionHost,
  auth: Pick<AuthFile, "providers">,
  env: NodeJS.ProcessEnv = process.env,
): ModelInfo[] {
  const models = new Map<string, ModelInfo>();
  for (const model of listModels()) {
    if (
      auth.providers[model.provider] ||
      providerConfig(model.provider)?.auth === "none" ||
      providerEnvVars(model.provider).some((variable) => Boolean(env[variable]))
    ) {
      models.set(`${model.provider}/${model.id}`, model);
    }
  }
  for (const [ref, model] of extensions.models) models.set(ref, model);
  return [...models.values()];
}

async function readAuth(authFile: string): Promise<Pick<AuthFile, "providers">> {
  return readAuthFile({ authFile }).catch(() => ({ providers: {} }));
}

function pinnedModel(
  ref: string,
  sources: SubagentRouteSources,
  auth: Pick<AuthFile, "providers">,
): ModelInfo | undefined {
  return pinnableModels(sources.extensions, auth, sources.env).find(
    (model) => `${model.provider}/${model.id}` === ref,
  );
}

// A pinned model that left the catalog or lost its credentials drops the whole pin, so
// the role runs on its default instead of failing the call.
export function subagentRouteOverride(
  sources: SubagentRouteSources,
): (kind: SpecialistKind, parent: Agent) => Promise<SubagentRouteOverride | undefined> {
  return async (kind) => {
    const pin = readSubagentPins(sources.configFile ?? userConfigPath())[kind];
    if (!pin?.model && !pin?.thinking) return undefined;
    const thinkingLevel = pin.thinking as ThinkingLevel | undefined;
    if (!pin.model) return thinkingLevel ? { thinkingLevel } : undefined;
    const model = pinnedModel(
      pin.model,
      sources,
      await readAuth(sources.authFile ?? defaultAuthFile()),
    );
    if (!model) return { unavailable: pin.model };
    return { model, ...(thinkingLevel ? { thinkingLevel } : {}) };
  };
}

export async function unavailableSubagentPins(
  sources: SubagentRouteSources,
  pins: SubagentPins = readSubagentPins(sources.configFile ?? userConfigPath()),
): Promise<string[]> {
  const entries = Object.entries(pins).filter(([, pin]) => pin?.model);
  if (entries.length === 0) return [];
  const auth = await readAuth(sources.authFile ?? defaultAuthFile());
  return entries.flatMap(([kind, pin]) =>
    pin?.model && !pinnedModel(pin.model, sources, auth)
      ? [`${kind} is set to ${pin.model}, which is not available; using its default`]
      : [],
  );
}
