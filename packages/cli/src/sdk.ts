import { type CodingProfile, type CodingProfileOptions, codingProfile } from "@mu/profile-coding";
import {
  Agent,
  type AgentOptions,
  defaultModelRef,
  ExtensionHost,
  optionsFromProfile,
  type Profile,
  subagentsExtension,
} from "mu";

export * from "mu";
export { codingProfile };
export type { CodingProfile, CodingProfileOptions };

export interface CreateAgentOptions extends AgentOptions {
  profile?: "coding" | Profile;
  profileOptions?: CodingProfileOptions;
}

function modelRefFor(options: AgentOptions): string {
  if (typeof options.model === "string") return options.model;
  if (options.model) return `${options.model.provider}/${options.model.id}`;
  return defaultModelRef();
}

export async function createAgent(options: CreateAgentOptions = {}): Promise<Agent> {
  const { profile, profileOptions, ...agentOptions } = options;
  const resolvedProfile = profile
    ? profile === "coding"
      ? await codingProfile(profileOptions)
      : profile
    : undefined;
  const resolved = resolvedProfile
    ? await optionsFromProfile(resolvedProfile, modelRefFor(agentOptions), agentOptions)
    : agentOptions;
  const extensions = resolved.extensions ?? new ExtensionHost();
  const agent = new Agent({ ...resolved, extensions });
  const restrictiveMode = resolvedProfile?.permissionModes?.find(
    (mode) => mode.tone === "restrictive",
  );
  const existingTools = [
    ...(resolved.tools?.map((candidate) => candidate.name) ?? []),
    ...extensions.tools.keys(),
  ];
  await extensions.register(
    subagentsExtension({
      parent: () => agent,
      ...(resolvedProfile?.name === "coding" && resolvedProfile.subagents
        ? { coding: resolvedProfile.subagents }
        : {}),
      inspectionPermissions: [...(resolved.permissions ?? []), ...(restrictiveMode?.rules ?? [])],
      excludeTools: existingTools,
    }),
  );
  return agent;
}
