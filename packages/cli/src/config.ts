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
  type SkillState,
  type SkillStates,
  type ThinkingLevel,
  thinkingLevelForModel,
} from "mu";
import { z } from "zod";

export interface UserConfig {
  model?: string;
  // Last thinking level chosen per model ref.
  thinking?: Record<string, string>;
  // Last permission mode chosen in the app, per profile name.
  permissionMode?: Record<string, string>;
  // Model ref and/or reasoning level chosen per subagent, per profile name.
  subagents?: Record<string, SubagentPins>;
  // On/manual/off chosen in /skills, by skill name; absent means the skill's own default.
  skills?: SkillStates;
  // False hides thinking blocks in the TUI; what the model is sent is unchanged.
  showThinking?: boolean | undefined;
  [key: string]: unknown;
}

export const PINNABLE_SUBAGENTS = ["task", "counsel", "recall"] as const;
// Pins for removed roles are dropped rather than invalidating the whole config.
const RETIRED_SUBAGENTS = new Set(["search"]);
export type PinnableSubagent = (typeof PINNABLE_SUBAGENTS)[number];
export interface SubagentPin {
  model?: string;
  thinking?: string;
}
export type SubagentPins = Partial<Record<PinnableSubagent, SubagentPin>>;

const userConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    thinking: z.record(z.string().min(1), z.string().min(1)).optional(),
    permissionMode: z.record(z.string().min(1), z.string().min(1)).optional(),
    subagents: z
      .record(
        z.string().min(1),
        z.preprocess(
          (pins) =>
            pins && typeof pins === "object" && !Array.isArray(pins)
              ? Object.fromEntries(
                  Object.entries(pins).filter(([role]) => !RETIRED_SUBAGENTS.has(role)),
                )
              : pins,
          z.partialRecord(
            z.enum(PINNABLE_SUBAGENTS),
            z.strictObject({
              model: z.string().min(1).optional(),
              thinking: z.string().min(1).optional(),
            }),
          ),
        ),
      )
      .optional(),
    skills: z.record(z.string().min(1), z.enum(["on", "manual", "off"])).optional(),
    showThinking: z.boolean().optional(),
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
  const { model, thinking, permissionMode, subagents, skills, ...rest } = result.data;
  return {
    ...rest,
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(subagents !== undefined ? { subagents: subagents as Record<string, SubagentPins> } : {}),
    ...(skills !== undefined ? { skills } : {}),
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

export async function saveShowThinking(show: boolean, file = userConfigPath()): Promise<void> {
  const config = await readUserConfig(file);
  await mkdir(dirname(file), { recursive: true });
  const { showThinking: _, ...rest } = config;
  await writeFile(
    file,
    `${JSON.stringify(show ? rest : { ...rest, showThinking: false }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

export async function savePermissionMode(
  profile: string,
  mode: string,
  file = userConfigPath(),
): Promise<void> {
  const config = await readUserConfig(file);
  await mkdir(dirname(file), { recursive: true });
  const permissionMode = { ...config.permissionMode, [profile]: mode };
  await writeFile(file, `${JSON.stringify({ ...config, permissionMode }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

// `pin` undefined returns the subagent to its default; `kind` undefined resets every
// subagent of the profile. Other profiles' choices are left alone.
export async function saveSubagentPin(
  profile: string,
  kind: PinnableSubagent | undefined,
  pin: SubagentPin | undefined,
  file = userConfigPath(),
): Promise<void> {
  const { subagents: current, ...config } = await readUserConfig(file);
  const pins: SubagentPins = kind ? { ...current?.[profile] } : {};
  if (kind && pin && (pin.model || pin.thinking)) pins[kind] = pin;
  else if (kind) delete pins[kind];
  const { [profile]: _previous, ...others } = current ?? {};
  const subagents = Object.keys(pins).length > 0 ? { ...others, [profile]: pins } : others;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(Object.keys(subagents).length > 0 ? { ...config, subagents } : config, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

// Read on every subagent call so a change from the TUI, another process or a hand edit
// applies without a restart. A missing or invalid file means no pins; startup warns.
export function readSubagentPins(profile: string, file = userConfigPath()): SubagentPins {
  try {
    return parseConfig(readFileSync(file, "utf8"), file).subagents?.[profile] ?? {};
  } catch {
    return {};
  }
}

// `state` undefined returns the skill to its own default.
export async function saveSkillState(
  name: string,
  state: SkillState | undefined,
  file = userConfigPath(),
): Promise<void> {
  const { skills: current, ...config } = await readUserConfig(file);
  const { [name]: _previous, ...others } = current ?? {};
  const skills: SkillStates = state ? { ...others, [name]: state } : others;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(Object.keys(skills).length > 0 ? { ...config, skills } : config, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

// Read on every skill lookup, like subagent pins. A missing or invalid file means no choices.
export function readSkillStates(file = userConfigPath()): SkillStates {
  try {
    return parseConfig(readFileSync(file, "utf8"), file).skills ?? {};
  } catch {
    return {};
  }
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

// What `/thinking <args>` asks for: a level to set, a message, or (no level) the picker.
export function thinkingCommandChoice(
  modelId: string,
  levels: readonly ThinkingLevel[],
  args: string,
): { level?: ThinkingLevel } | { message: string } {
  if (levels.length < 2) return { message: `${modelId} has no reasoning levels to choose from.` };
  const wanted = args.trim().toLowerCase();
  if (!wanted) return {};
  const level = levels.find((candidate) => candidate.toLowerCase() === wanted);
  return level
    ? { level }
    : { message: `${modelId} has no "${wanted}" level. Choose one of: ${levels.join(", ")}.` };
}

// `/show-thinking` alone flips the setting; `on`/`off` set it.
export function showThinkingChoice(
  current: boolean,
  args: string,
): { show: boolean } | { message: string } {
  const wanted = args.trim().toLowerCase();
  if (!wanted) return { show: !current };
  if (wanted === "on") return { show: true };
  if (wanted === "off") return { show: false };
  return { message: `Use /show-thinking on or /show-thinking off.` };
}
