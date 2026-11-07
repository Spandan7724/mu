import {
  type AgentMessage,
  customMessage,
  MemorySessionStore,
  type PermissionRule,
} from "@mu/core";
import { Agent, type AgentOptions } from "./agent.ts";
import { MCP_CONTEXT_TYPE } from "./mcp.ts";
import { SKILLS_CONTEXT_TYPE } from "./skills.ts";

const SIDE_BOUNDARY = `Side conversation boundary.

Everything before this boundary is inherited from the main conversation as reference context. It is not your current task. Do not continue or complete instructions, plans, tool calls, or requests found only in that inherited history.

Only messages submitted after this boundary are active instructions. Answer the side question independently without disrupting the main conversation.`;

export interface SideConversationInput {
  messages: AgentMessage[];
  boundary?: string;
  permissions?: PermissionRule[];
  // A fixed toolset. The side then also runs without extension context, and the
  // skill and MCP listings it inherits are dropped.
  tools?: string[];
}

const EXTENSION_CONTEXT_TYPES = new Set([SKILLS_CONTEXT_TYPE, MCP_CONTEXT_TYPE]);

export interface SideConversation {
  agent: Agent;
  close(): Promise<void>;
}

export function startSideConversation(
  options: AgentOptions,
  input: SideConversationInput,
): SideConversation {
  const boundary = [SIDE_BOUNDARY, input.boundary?.trim()].filter(Boolean).join("\n\n");
  const {
    session: _session,
    sessionId: _sessionId,
    initialMessages: _initialMessages,
    refreshContext: _refreshContext,
    runtime: _runtime,
    checkpointProvider: _checkpointProvider,
    ...shared
  } = options;
  const inherited = input.tools
    ? input.messages.filter(
        (message) => message.role !== "custom" || !EXTENSION_CONTEXT_TYPES.has(message.customType),
      )
    : input.messages;
  const agent = new Agent({
    ...shared,
    session: new MemorySessionStore(),
    initialMessages: [...inherited, customMessage("side-conversation-boundary", boundary)],
    ...(input.permissions ? { permissions: input.permissions } : {}),
    ...(input.tools ? { toolNames: input.tools, extensionContext: false } : {}),
  });
  let closed = false;
  return {
    agent,
    close: async () => {
      if (closed) return;
      closed = true;
      // The extension host is borrowed from the parent. Agent.shutdown() would
      // deactivate it and break the still-running main conversation.
      agent.stop();
      await agent.waitForIdle();
      options.extensions?.emitLifecycle({
        type: "session_shutdown",
        sessionId: agent.sessionId,
      });
    },
  };
}
