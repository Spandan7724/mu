import { type CodingProfile, type CodingProfileOptions, codingProfile } from "@mu/profile-coding";
import { Agent, type AgentOptions, defaultModelRef, optionsFromProfile, type Profile } from "mu";

export * from "mu";
export { codingProfile };
export type { CodingProfile, CodingProfileOptions };

// Re-exported so a remote client takes the wire contract as a type-only
// dependency on this package rather than maintaining a translation (RD13).
export type {
  ByeReason,
  ClientFrame,
  ErrorCode,
  HostInfo,
  Op,
  OpKind,
  OpResult,
  Origin,
  PermissionModeInfo,
  ServerFrame,
  SessionState,
  SessionSummary,
  SessionTask,
  SubscriberPolicy,
  WorkspaceInfo,
} from "@mu/protocol";
export {
  DEFAULT_MAX_INLINE_BYTES,
  DEFAULT_UPDATE_HZ,
  MAX_UPDATE_HZ,
  MIN_UPDATE_HZ,
  PROTOCOL_VERSION,
} from "@mu/protocol";

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
  if (!profile) return new Agent(agentOptions);

  const resolvedProfile = profile === "coding" ? await codingProfile(profileOptions) : profile;
  return new Agent(
    await optionsFromProfile(resolvedProfile, modelRefFor(agentOptions), agentOptions),
  );
}
