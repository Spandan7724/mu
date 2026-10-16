import { bashTool } from "@mu/profile-coding";
import { type AgentEvent, customMessage, type MarkdownCommandRun, readAuthFile } from "mu";
import type { ParsedArgs } from "./args.ts";
import { applySavedThinking, saveThinkingLevel } from "./config.ts";
import { transcriptExportCommand } from "./export-command.ts";
import type { ModelCatalog } from "./model-catalog.ts";
import { modelPickerItems } from "./model-picker.ts";
import { linesFrom, runRpc } from "./rpc.ts";
import { createCliSessionRuntime } from "./session-runtime.ts";
import { saveTranscriptMarkdown } from "./transcript-file.ts";
import { formatUserShellRecord, runUserShellCommand } from "./user-shell.ts";

const MAX_TASK_SNAPSHOT_CHARS = 100_000;
const MAX_SUBAGENT_SNAPSHOT_EVENTS = 500;

interface LiveTaskSnapshot {
  start: Extract<AgentEvent, { type: "task_started" }>;
  output: string;
  omittedChars: number;
}

interface LiveSubagentSnapshot {
  start: Extract<AgentEvent, { type: "subagent_started" }>;
  progress: Extract<AgentEvent, { type: "subagent_progress" }>[];
}

// Streamed text is superseded by the completed message that follows it, so an
// attachment replays only whole messages.
function isTextDelta(details: unknown): boolean {
  if (typeof details !== "object" || details === null) return false;
  const event = (details as { event?: { type?: unknown } }).event;
  return event?.type === "text_delta";
}

function isMarkdownCommandRun(data: unknown): data is MarkdownCommandRun {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "markdown-command" &&
    typeof (data as { prompt?: unknown }).prompt === "string"
  );
}

async function* fencedWorkerLines(
  lines: AsyncIterable<string>,
  ownershipToken: string,
): AsyncGenerator<string> {
  for await (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.ownershipToken !== ownershipToken) {
      throw new Error("managed worker received a command for a different ownership generation");
    }
    const { ownershipToken: _ownershipToken, ...op } = parsed;
    yield JSON.stringify(op);
  }
}

export interface AgentWorkerIo {
  lines?: AsyncIterable<string>;
  write?: (line: string) => void;
  stderr?: (message: string) => void;
}

export async function runAgentWorker(
  args: ParsedArgs,
  io: AgentWorkerIo = {},
  modelCatalog?: ModelCatalog,
): Promise<number> {
  const stderr = io.stderr ?? ((message: string) => process.stderr.write(message));
  if (!args.workerSessionId && !args.resumeSessionId) {
    stderr("mu: managed worker requires --session-id or --resume\n");
    return 2;
  }
  if (!args.workerOwnershipToken) {
    stderr("mu: managed worker requires --ownership-token\n");
    return 2;
  }
  const ownershipToken = args.workerOwnershipToken;
  const runtime = await createCliSessionRuntime({
    cwd: process.cwd(),
    profile: args.profile,
    model: args.model,
    permissionMode: args.permissionMode,
    allowAll: args.allowAll,
    noInstructions: args.noInstructions,
    sessionId: args.workerSessionId,
    resumeSessionId: args.resumeSessionId,
    maxTurns: args.maxTurns,
    maxCostUsd: args.maxCostUsd,
    permissions: "forward",
    onDiagnostic: (message) => stderr(`mu: ${message}\n`),
  });
  const { agent } = runtime;
  void modelCatalog?.ensureFresh().then((refresh) => {
    if (refresh.ok) agent.refreshModelInfo();
  });
  const auth = await readAuthFile().catch((error: unknown) => {
    stderr(
      `mu: could not read saved authentication for /model: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { version: 1 as const, providers: {} };
  });
  const selectableModels = modelPickerItems(runtime.extensions, auth.providers);
  runtime.commands.register(
    transcriptExportCommand({
      getSession: () => agent.session,
      getSessionId: () => agent.sessionId,
      getModel: () => agent.modelRef,
      isRunning: () => agent.isRunning,
      save: async (markdown, requestedPath, now) =>
        (
          await saveTranscriptMarkdown(markdown, {
            cwd: process.cwd(),
            requestedPath,
            now,
          })
        ).displayPath,
    }),
  );
  const liveTasks = new Map<string, LiveTaskSnapshot>();
  const liveSubagents = new Map<string, LiveSubagentSnapshot>();
  const stopTaskTracking = agent.subscribe((event) => {
    if (event.type === "task_started") {
      liveTasks.set(event.taskId, { start: event, output: "", omittedChars: 0 });
    } else if (event.type === "task_output") {
      const task = liveTasks.get(event.taskId);
      if (task) {
        const combined = `${task.output}${event.chunk}`;
        const omitted = Math.max(0, combined.length - MAX_TASK_SNAPSHOT_CHARS);
        task.omittedChars += omitted;
        task.output = combined.slice(omitted);
      }
    } else if (event.type === "task_exited") {
      liveTasks.delete(event.taskId);
    } else if (event.type === "subagent_started") {
      liveSubagents.set(event.subagentId, { start: event, progress: [] });
    } else if (event.type === "subagent_progress" && !isTextDelta(event.details)) {
      const subagent = liveSubagents.get(event.subagentId);
      if (subagent) {
        subagent.progress.push(event);
        if (subagent.progress.length > MAX_SUBAGENT_SNAPSHOT_EVENTS) subagent.progress.shift();
      }
    } else if (event.type === "subagent_ended") {
      liveSubagents.delete(event.subagentId);
    }
  });
  const shellTool =
    runtime.agentOptions.tools?.find((candidate) => candidate.name === "bash") ??
    bashTool({ root: process.cwd() });
  let shellController: AbortController | undefined;

  try {
    await runRpc(
      {
        write: (line) => {
          const value = JSON.parse(line) as Record<string, unknown>;
          (io.write ?? ((output: string) => process.stdout.write(output)))(
            `${JSON.stringify({ ...value, ownershipToken })}\n`,
          );
        },
        lines: fencedWorkerLines(io.lines ?? linesFrom(process.stdin), ownershipToken),
      },
      {
        agent,
        onThinkingChange: () => {
          void saveThinkingLevel(agent.modelRef, agent.thinking).catch((error: unknown) => {
            stderr(
              `mu: could not save thinking level: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          });
        },
        ready: {
          sessionId: agent.sessionId,
          model: agent.modelRef,
          contextWindow: agent.contextWindow,
          thinking: agent.thinking,
          thinkingLevels: [...agent.thinkingLevels],
        },
        snapshot: () => ({
          sessionId: agent.sessionId,
          messages: agent.session.messagesAt(),
          model: agent.modelRef,
          contextWindow: agent.contextWindow,
          thinking: agent.thinking,
          thinkingLevels: [...agent.thinkingLevels],
          usage: agent.usage,
          contextPercent: agent.contextPercent,
          isRunning: agent.isRunning,
          events: [
            ...[...liveSubagents.values()].flatMap((subagent) => [
              subagent.start,
              ...subagent.progress,
            ]),
            ...[...liveTasks.values()].flatMap((task) => [
              task.start,
              ...(task.output
                ? ([
                    {
                      type: "task_output",
                      taskId: task.start.taskId,
                      chunk:
                        task.omittedChars > 0
                          ? `… ${task.omittedChars.toLocaleString()} earlier characters omitted from attachment snapshot …\n${task.output}`
                          : task.output,
                    },
                  ] as const)
                : []),
            ]),
          ],
          models: selectableModels,
          permissionModes: runtime.permissionModes.map((mode) => ({
            id: mode.id,
            label: mode.label,
            description: mode.description,
            ...(mode.tone ? { tone: mode.tone } : {}),
          })),
          ...(runtime.permissionMode ? { permissionMode: runtime.permissionMode.id } : {}),
          commands: runtime.commands
            .list()
            .map((command) => ({ label: command.name, description: command.description })),
        }),
        resolvePermission: runtime.resolvePermission,
        cancelPermissions: runtime.cancelPermissions,
        cyclePermissionMode: runtime.cyclePermissionMode,
        setPermissionMode: runtime.setPermissionMode,
        abortAuxiliary: () => shellController?.abort(),
        runShell: async (command, emit) => {
          if (shellController) throw new Error("a shell command is already active");
          const controller = new AbortController();
          shellController = controller;
          emit({ type: "agent_start" });
          try {
            const result = await runUserShellCommand(shellTool, command, controller.signal, emit);
            agent.session.appendMessage(
              customMessage("user_shell_command", formatUserShellRecord(command, result)),
            );
            await agent.sessionStore.save(agent.sessionId, agent.session);
          } finally {
            emit({
              type: "agent_end",
              messages: [],
              reason: controller.signal.aborted ? "aborted" : "done",
            });
            if (shellController === controller) shellController = undefined;
          }
        },
        runCommand: async (text) => {
          const printed: string[] = [];
          const result = await runtime.commands.execute(text, {
            inject: (message) => {
              if (message.role === "custom" && message.content[0]?.type === "text") {
                agent.followUp(message.content[0].text);
              }
            },
            print: (output) => printed.push(output),
            getModel: () => agent.modelRef,
            setModel: (ref) => {
              agent.setModel(ref);
              applySavedThinking(agent);
            },
            isRunning: () => agent.isRunning,
          });
          const message = [...printed, ...(result.message ? [result.message] : [])].join("\n");
          const complete = { ...result, ...(message ? { message } : {}) };
          if (isMarkdownCommandRun(complete.data)) return complete;
          return complete;
        },
      },
    );
    return 0;
  } finally {
    stopTaskTracking();
    shellController?.abort();
    runtime.cancelPermissions();
    await agent.shutdown();
  }
}
