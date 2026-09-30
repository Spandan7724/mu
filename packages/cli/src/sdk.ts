import {
  type BrowserProfile,
  type BrowserProfileOptions,
  browserProfile,
} from "@mu/profile-browser";
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
export { browserProfile, codingProfile };
export type { BrowserProfile, BrowserProfileOptions, CodingProfile, CodingProfileOptions };

export type CreateAgentOptions = AgentOptions &
  (
    | { profile?: "coding" | Profile; profileOptions?: CodingProfileOptions }
    | { profile: "browser"; profileOptions?: BrowserProfileOptions }
  );

async function builtInProfile(options: CreateAgentOptions): Promise<Profile | undefined> {
  if (options.profile === "browser") return browserProfile(options.profileOptions);
  if (options.profile === "coding") return codingProfile(options.profileOptions);
  return options.profile;
}

function modelRefFor(options: AgentOptions): string {
  if (typeof options.model === "string") return options.model;
  if (options.model) return `${options.model.provider}/${options.model.id}`;
  return defaultModelRef();
}

export async function createAgent(options: CreateAgentOptions = {}): Promise<Agent> {
  const { profile: _profile, profileOptions: _profileOptions, ...agentOptions } = options;
  const resolvedProfile = await builtInProfile(options);
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
      ...(resolvedProfile?.subagents?.taskSession
        ? { taskSession: resolvedProfile.subagents.taskSession }
        : {}),
      ...(resolvedProfile?.name === "coding" && resolvedProfile.subagents
        ? { coding: resolvedProfile.subagents }
        : {}),
      inspectionPermissions: [...(resolved.permissions ?? []), ...(restrictiveMode?.rules ?? [])],
      excludeTools: existingTools,
    }),
  );
  return agent;
}
