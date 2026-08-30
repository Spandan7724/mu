import type { PromptSection } from "@mu/ai";
import type { CheckpointProvider } from "./checkpoint.ts";
import type { Command } from "./commands.ts";
import type { AgentEvent } from "./events.ts";
import type { ToolRenderer } from "./extensions.ts";
import type { AgentMessage } from "./messages.ts";
import type { PermissionRule } from "./permission.ts";
import type { AnyTool } from "./tools.ts";

// Which way a mode moves the gate relative to the profile's defaults. A profile
// classifies its own modes; presentation layers decide what that looks like.
export type PermissionModeTone = "restrictive" | "permissive" | "unrestricted";

export interface PermissionMode {
  id: string;
  label: string;
  description: string;
  tone?: PermissionModeTone;
  // Applied after the profile/user/project layers, so a mode is a preset of
  // final overrides rather than a replacement for configured rules.
  rules: PermissionRule[];
}

export interface ProfileRuntimeHost {
  emit: (event: AgentEvent) => void;
  followUp: (message: string) => void;
}

// Session-owned resources supplied by a profile. The Agent binds their events
// and owns their lifecycle without knowing which domain produced them.
export interface ProfileRuntime {
  attach: (host: ProfileRuntimeHost) => void;
  resize?: (cols: number, rows: number) => void;
  stop?: () => void;
  shutdown?: () => void | Promise<void>;
}

export interface ProfileSubagents {
  // Tools a read-only investigator may use. Their permission rules remain the
  // enforcement boundary; this list only limits the child's visible toolset.
  inspectionTools: string[];
  searchPrompt?: string;
  counselPrompt?: string;
}

// A profile bundles everything that makes the kernel behave as a particular
// kind of agent. The kernel knows nothing about what is inside — coding,
// computer-use and automation profiles are all just this shape.
export interface Profile {
  name: string;
  toolset: AnyTool[];
  // Per-model prompt variants: one prompt does not fit every model family.
  promptFor: (modelRef: string) => PromptSection[];
  permissionDefaults: PermissionRule[];
  permissionModes?: PermissionMode[];
  defaultPermissionMode?: string;
  rememberPermission?: (permission: string, pattern: string) => void | Promise<void>;
  renderers?: Record<string, ToolRenderer>;
  commands?: Command[];
  // Opaque per-domain environment (coding fills in directory/repo facts;
  // computer-use would fill in display/OS). The kernel only forwards it.
  environment?: () => Promise<Record<string, string>> | Record<string, string>;
  // Domain context injected per session as typed messages, never as a
  // system-prompt edit (cache hygiene).
  contextMessages?: () => Promise<AgentMessage[]> | AgentMessage[];
  // Domain-specific constraints appended to the neutral side-conversation boundary.
  sideBoundary?: () => string;
  // Optional domain contribution to the profile-independent subagent extension.
  subagents?: ProfileSubagents;
  // Re-evaluates domain context against the active transcript before a run.
  // The profile returns only new typed messages that should be appended.
  refreshContext?: (
    messages: AgentMessage[],
    context: { sessionId: string },
  ) => Promise<AgentMessage[]> | AgentMessage[];
  // Actionable startup diagnostics from profile-owned resource discovery.
  diagnostics?: string[];
  // Compaction carryover: what this domain must not forget when summarizing.
  carryoverExtractor?: (messages: AgentMessage[]) => unknown;
  // Snapshot/restore for this domain (coding: a shadow repository).
  checkpointProvider?: CheckpointProvider;
  runtime?: ProfileRuntime;
  // Session scope key, used by file-backed stores to group sessions.
  scope?: () => Promise<string> | string;
}

export type ProfileFactory = (options?: Record<string, unknown>) => Profile | Promise<Profile>;
