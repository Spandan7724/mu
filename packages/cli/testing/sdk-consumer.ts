import {
  Agent,
  type AgentEvent,
  type AssistantMessage,
  type CheckpointDiffFile,
  createAgent,
  type HostInfo,
  MemorySessionStore,
  type Op,
  type PermissionPreview,
  type PermissionRequest,
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionState,
  type SessionSummary,
  type SubscriberPolicy,
  tool,
  type ToolCallContent,
  type ToolResultMessage,
  type UserMessage,
} from "@mu-agent/mu";
import { z } from "zod";

const echo = tool({
  name: "echo",
  description: "Return the supplied text",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ content: [{ type: "text", text }] }),
});

const agent = new Agent({
  session: new MemorySessionStore(),
  tools: [echo],
});

if (!(agent instanceof Agent)) throw new Error("SDK package export did not construct Agent");

const codingAgent = await createAgent({
  profile: "coding",
  profileOptions: {
    root: process.cwd(),
    home: process.cwd(),
    instructions: { enabled: false },
  },
});
if (!(codingAgent instanceof Agent)) throw new Error("SDK package did not create coding Agent");
await codingAgent.shutdown();

// The type surface, exercised the way a remote client uses it (RD13). This half
// of the file catches nothing at runtime — it is here because `verify:npm`
// typechecks it against the *built* package, and three separate declaration
// gaps shipped undetected while this file only constructed an Agent (RD22).
// A protocol type that stops resolving from `@mu-agent/mu` fails here.
const frame: ServerFrame = {
  t: "hello",
  protocol: PROTOCOL_VERSION,
  host: {
    hostId: "h",
    instanceId: "i",
    name: "machine",
    version: "0",
    workspace: { name: "mu", root: "/tmp" },
  } satisfies HostInfo,
};

const policy: SubscriberPolicy = { updates: "coalesced", updateHz: 8, images: "stub" };
const op: Op = { k: "permission_reply", requestId: "p1", outcome: "deny" };

// Every member of the message union has to be nameable, or a client holding an
// AgentMessage cannot render one.
function describe(state: SessionState, summary: SessionSummary, event: AgentEvent): string {
  const parts: string[] = [state.sessionId, summary.id, event.type];
  for (const message of state.messages) {
    if (message.role === "assistant") {
      const assistant: AssistantMessage = message;
      for (const block of assistant.content) {
        if (block.type === "toolCall") {
          const call: ToolCallContent = block;
          parts.push(call.name);
        }
      }
    } else if (message.role === "toolResult") {
      const result: ToolResultMessage = message;
      parts.push(result.toolName);
    } else if (message.role === "user") {
      const user: UserMessage = message;
      if (user.source) parts.push(user.source);
    }
  }
  for (const request of state.pendingPermissions) {
    const pending: PermissionRequest = request;
    const preview: PermissionPreview | undefined = pending.preview;
    if (preview?.kind === "diff") {
      const file: CheckpointDiffFile = preview.file;
      parts.push(`${file.path} +${file.added} -${file.removed}`, ...file.hunks);
    }
  }
  return parts.join(" ");
}

if (frame.t !== "hello" || policy.updates !== "coalesced" || op.k !== "permission_reply") {
  throw new Error("SDK package protocol types did not narrow");
}
if (typeof describe !== "function") throw new Error("unreachable");
