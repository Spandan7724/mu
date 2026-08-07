import type {
  AgentMessage,
  PermissionModeTone,
  PermissionRequest,
  TaskInfo,
  Usage,
} from "@mu/core";
import type { AgentState, QueuedInput } from "mu";

// Display only. No op accepts a path, so nothing a client sends can be derived
// from this (SECURITY.md §5).
export interface WorkspaceInfo {
  name: string;
  root: string;
  branch?: string;
}

export interface PermissionModeInfo {
  id: string;
  label: string;
  tone?: PermissionModeTone;
}

export interface SessionTask {
  taskId: string;
  command: string;
  running: boolean;
}

// The snapshot: everything a client needs to render a session from cold.
export interface SessionState {
  sessionId: string;
  profile: string;
  workspace: WorkspaceInfo;

  model: string;
  thinkingLevel: string;
  thinkingLevels: string[];
  permissionMode?: PermissionModeInfo;

  running: boolean;
  compacting: boolean;

  usage: Usage;
  contextTokens: number;
  contextPercent: number;

  messages: AgentMessage[];
  pendingPermissions: PermissionRequest[];
  queuedInputs: QueuedInput[];
  tasks: SessionTask[];
}

function sessionTask(task: TaskInfo): SessionTask {
  return { taskId: task.id, command: task.command, running: task.status === "running" };
}

// Projects what the Agent knows onto the wire. A mode's rules stay behind:
// clients render the label, and the gate is the host's alone.
export function sessionStateFrom(state: AgentState, workspace: WorkspaceInfo): SessionState {
  return {
    sessionId: state.sessionId,
    profile: state.profile,
    workspace,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    thinkingLevels: [...state.thinkingLevels],
    ...(state.permissionMode
      ? {
          permissionMode: {
            id: state.permissionMode.id,
            label: state.permissionMode.label,
            ...(state.permissionMode.tone ? { tone: state.permissionMode.tone } : {}),
          },
        }
      : {}),
    running: state.running,
    compacting: state.compacting,
    usage: state.usage,
    contextTokens: state.contextTokens,
    contextPercent: state.contextPercent,
    messages: state.messages,
    pendingPermissions: state.pendingPermissions,
    queuedInputs: state.queuedInputs,
    tasks: state.tasks.map(sessionTask),
  };
}
