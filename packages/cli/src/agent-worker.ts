import {
  createCliSessionRuntime,
  formatUserShellRecord,
  linesFrom,
  modelPickerItems,
  type ParsedArgs,
  runRpc,
  runUserShellCommand,
  saveTranscriptMarkdown,
  transcriptExportCommand,
} from "@mu/cli-runtime";
import { type AgentEvent, customMessage, type MarkdownCommandRun, readAuthFile } from "mu";
import { type CodingProductOptions, codingProduct } from "./product.ts";

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
  args: ParsedArgs<CodingProductOptions>,
  io: AgentWorkerIo = {},
): Promise<number> {
  const stderr = io.stderr ?? ((message: string) => process.stderr.write(message));
  if (!args.product.workerSessionId && !args.resumeSessionId) {
    stderr("mu: managed worker requires --session-id or --resume\n");
    return 2;
  }
  if (!args.product.workerOwnershipToken) {
    stderr("mu: managed worker requires --ownership-token\n");
    return 2;
  }
  const ownershipToken = args.product.workerOwnershipToken;
  const runtime = await createCliSessionRuntime({
    cwd: process.cwd(),
    product: codingProduct,
    productOptions: args.product,
    profile: args.profile,
    model: args.model,
    permissionMode: args.permissionMode,
    allowAll: args.allowAll,
    noInstructions: args.noInstructions,
    sessionId: args.product.workerSessionId,
    resumeSessionId: args.resumeSessionId,
    maxTurns: args.maxTurns,
    maxCostUsd: args.maxCostUsd,
    permissions: "forward",
    onDiagnostic: (message) => stderr(`mu: ${message}\n`),
  });
  const { agent } = runtime;
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
            prefix: codingProduct.transcriptPrefix as string,
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
  const directShell = codingProduct.capabilities?.directShell;
  const shellTool =
    runtime.agentOptions.tools?.find((candidate) => candidate.name === directShell?.toolName) ??
    directShell?.fallbackTool({ cwd: process.cwd() });
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
          models: selectableModels,
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
          if (!shellTool) throw new Error("direct shell execution is unavailable");
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
