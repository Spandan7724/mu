import { bashTool } from "@mu/profile-coding";
import { type AgentEvent, customMessage, listModels, type MarkdownCommandRun } from "mu";
import type { ParsedArgs } from "./args.ts";
import { transcriptExportCommand } from "./export-command.ts";
import { linesFrom, runRpc } from "./rpc.ts";
import { createCliSessionRuntime } from "./session-runtime.ts";
import { saveTranscriptMarkdown } from "./transcript-file.ts";
import { formatUserShellRecord, runUserShellCommand } from "./user-shell.ts";

const MAX_TASK_SNAPSHOT_CHARS = 100_000;

interface LiveTaskSnapshot {
  start: Extract<AgentEvent, { type: "task_started" }>;
  output: string;
}

function isMarkdownCommandRun(data: unknown): data is MarkdownCommandRun {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "markdown-command" &&
    typeof (data as { prompt?: unknown }).prompt === "string"
  );
}

export async function runAgentWorker(args: ParsedArgs): Promise<number> {
  if (!args.workerSessionId && !args.resumeSessionId) {
    process.stderr.write("mu: managed worker requires --session-id or --resume\n");
    return 2;
  }
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
    onDiagnostic: (message) => process.stderr.write(`mu: ${message}\n`),
  });
  const { agent } = runtime;
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
  const stopTaskTracking = agent.subscribe((event) => {
    if (event.type === "task_started") {
      liveTasks.set(event.taskId, { start: event, output: "" });
    } else if (event.type === "task_output") {
      const task = liveTasks.get(event.taskId);
      if (task) task.output = `${task.output}${event.chunk}`.slice(-MAX_TASK_SNAPSHOT_CHARS);
    } else if (event.type === "task_exited") {
      liveTasks.delete(event.taskId);
    }
  });
  const shellTool =
    runtime.agentOptions.tools?.find((candidate) => candidate.name === "bash") ??
    bashTool({ root: process.cwd() });
  let shellController: AbortController | undefined;

  try {
    await runRpc(
      { write: (line) => process.stdout.write(line), lines: linesFrom(process.stdin) },
      {
        agent,
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
          events: [...liveTasks.values()].flatMap((task) => [
            task.start,
            ...(task.output
              ? ([{ type: "task_output", taskId: task.start.taskId, chunk: task.output }] as const)
              : []),
          ]),
          models: [
            ...new Map(
              [
                ...listModels().map((model) => ({
                  label: `${model.provider}/${model.id}`,
                  ...(model.name ? { description: model.name } : {}),
                })),
                ...[...runtime.extensions.models].map(([label, model]) => ({
                  label,
                  ...(model.name ? { description: model.name } : {}),
                })),
              ].map((model) => [model.label, model] as const),
            ).values(),
          ],
          permissionModes: runtime.permissionModes.map((mode) => ({
            id: mode.id,
            label: mode.label,
            description: mode.description,
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
            setModel: (ref) => agent.setModel(ref),
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
