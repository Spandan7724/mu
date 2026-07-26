import type { PromptSection } from "@mu/ai";
import type { CheckpointProvider } from "./checkpoint.ts";
import type { Command } from "./commands.ts";
import type { ToolRenderer } from "./extensions.ts";
import type { AgentMessage } from "./messages.ts";
import type { PermissionRule } from "./permission.ts";
import type { AnyTool } from "./tools.ts";

// A profile bundles everything that makes the kernel behave as a particular
// kind of agent. The kernel knows nothing about what is inside — coding,
// computer-use and automation profiles are all just this shape.
export interface Profile {
  name: string;
  toolset: AnyTool[];
  // Per-model prompt variants: one prompt does not fit every model family.
  promptFor: (modelRef: string) => PromptSection[];
  permissionDefaults: PermissionRule[];
  renderers?: Record<string, ToolRenderer>;
  commands?: Command[];
  // Opaque per-domain environment (coding fills in directory/repo facts;
  // computer-use would fill in display/OS). The kernel only forwards it.
  environment?: () => Promise<Record<string, string>> | Record<string, string>;
  // Domain context injected per session as typed messages, never as a
  // system-prompt edit (cache hygiene).
  contextMessages?: () => Promise<AgentMessage[]> | AgentMessage[];
  // Compaction carryover: what this domain must not forget when summarizing.
  carryoverExtractor?: (messages: AgentMessage[]) => unknown;
  // Snapshot/restore for this domain (coding: a shadow repository).
  checkpointProvider?: CheckpointProvider;
  // Session scope key, used by file-backed stores to group sessions.
  scope?: () => Promise<string> | string;
}

export type ProfileFactory = (options?: Record<string, unknown>) => Profile | Promise<Profile>;
