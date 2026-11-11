import {
  type AgentOptions,
  type AgentRunOptions,
  type CommandRegistry,
  customMessage,
  type DiffCommandData,
  type HaltReason,
  type MarkdownCommandRun,
  supportedThinkingLevels,
  type ThinkingLevel,
  toWireEvent,
  type UndoPointsCommandData,
} from "mu";
import type { ParsedArgs } from "./args.ts";
import { isCostReport, renderCostCommand } from "./cost-command.ts";
import { transcriptExportCommand } from "./export-command.ts";
import { browserFlags } from "./profiles.ts";
import { createCliSessionRuntime } from "./session-runtime.ts";
import { unavailableSubagentPins, usableModels } from "./subagent-routes.ts";
import { saveTranscriptMarkdown } from "./transcript-file.ts";

// Exit codes: 0 done, 1 error, 2 usage/config, 3 halted early (budget/turns),
// 130 aborted — so callers can branch on how a run ended.
export const EXIT: Record<HaltReason | "usage", number> = {
  done: 0,
  error: 1,
  usage: 2,
  maxTurns: 3,
  maxCostUsd: 3,
  maxTokens: 3,
  aborted: 130,
};

export interface HeadlessIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export async function runHeadless(
  args: ParsedArgs,
  options: AgentOptions,
  io: HeadlessIo,
  extra: { profileOptions?: Record<string, unknown> } = {},
): Promise<number> {
  if (!args.prompt) {
    io.stderr("mu: -p requires a prompt\n");
    return EXIT.usage;
  }

  let runtime: Awaited<ReturnType<typeof createCliSessionRuntime>>;
  try {
    runtime = await createCliSessionRuntime({
      cwd: process.cwd(),
      profile: args.profile,
      model: args.model,
      thinking: args.thinking,
      permissionMode: args.permissionMode,
      allowAll: args.allowAll,
      noInstructions: args.noInstructions,
      noCheckpoints: args.noCheckpoints,
      browser: browserFlags(args),
      resumeSessionId: args.resumeSessionId,
      maxTurns: args.maxTurns,
      maxCostUsd: args.maxCostUsd,
      agentOptions: options,
      ...(extra.profileOptions ? { profileOptions: extra.profileOptions } : {}),
      permissions: "deny",
      onDiagnostic: (message) => io.stderr(`mu: ${message}\n`),
    });
  } catch (error) {
    io.stderr(`mu: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.usage;
  }
  const { agent } = runtime;

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    agent.stop();
  };
  process.on("SIGINT", onSigint);

  let failure: string | undefined;
  // A reply's text is printed once it completes: a stream that fails part way
  // is retried, and stdout must not carry the abandoned attempt.
  let replyText = "";
  const unsubscribe = agent.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error" &&
      event.message.errorMessage
    ) {
      failure = event.message.errorMessage;
    }
    if (event.type === "provider_retry" && !args.json) {
      const seconds = Math.round(event.delayMs / 1000);
      io.stderr(
        `mu: ${event.errorMessage}; retrying in ${seconds}s (${event.attempt} of ${event.maxAttempts})\n`,
      );
    }
    if (event.type === "thinking_adjusted" && !args.json) {
      io.stderr(
        `mu: ${event.model} does not offer thinking ${event.requested}${event.inferredModel ? " (not in mu's model catalog)" : ""}; using ${event.level}\n`,
      );
    }
    if (event.type === "permission_asked" && !args.json) {
      const unrestricted = runtime.permissionModes.find((mode) => mode.tone === "unrestricted");
      io.stderr(
        `mu: denied ${event.request.permission} (${event.request.description}) — headless runs cannot ask for approval${unrestricted ? `; rerun with --permission-mode ${unrestricted.id} or --allow-all to permit it` : ""}\n`,
      );
    }
    if (args.json) {
      io.stdout(`${JSON.stringify(toWireEvent(event))}\n`);
    } else if (event.type === "message_update" && event.delta.kind === "text_delta") {
      replyText += event.delta.text;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason !== "error" && replyText) io.stdout(replyText);
      replyText = "";
    }
  });

  try {
    if (runtime.profile?.name === "coding") {
      for (const notice of await unavailableSubagentPins({
        profile: runtime.profile.name,
        extensions: runtime.extensions,
      }))
        io.stderr(`mu: ${notice}\n`);
    }
    registerHeadlessCommands(runtime.commands, runtime);
    const printed: string[] = [];
    const command = await runtime.commands.execute(args.prompt, {
      inject: () => {},
      print: (text) => printed.push(text),
      getModel: () => agent.modelRef,
      setModel: (ref) => agent.setModel(ref),
      isRunning: () => agent.isRunning,
    });
    let prompt = args.prompt;
    let runOptions: AgentRunOptions | undefined;
    if (isMarkdownCommandRun(command.data)) {
      prompt = command.data.prompt;
      runOptions = {
        ...(command.data.model ? { model: command.data.model } : {}),
        ...(command.data.allowedTools ? { allowedTools: command.data.allowedTools } : {}),
        ...(command.data.context ? { context: command.data.context } : {}),
      };
    } else if (command.handled) {
      const messages = [...printed, ...(command.message ? [command.message] : [])];
      if (args.json) {
        io.stdout(
          `${JSON.stringify({
            type: "command_result",
            ...(messages.length > 0 ? { message: messages.join("\n") } : {}),
            ...(command.data !== undefined ? { data: command.data } : {}),
          })}\n`,
        );
      } else {
        const text = [...messages, ...commandDataText(command.data)];
        if (text.length > 0) io.stdout(`${text.join("\n")}\n`);
      }
      return EXIT.done;
    }

    // Capture the provider's own message so a failure is actionable rather
    // than a bare "an error occurred".
    // Background subagents report back through follow-up turns; a one-shot
    // run ends only once those have been delivered and answered.
    let laterRuns = 0;
    let laterReason: HaltReason | undefined;
    let mainDone = false;
    const runningTasks = new Map<string, string>();
    const stopWatching = agent.subscribe((event) => {
      if (event.type === "task_started") runningTasks.set(event.taskId, event.command);
      if (event.type === "task_exited") runningTasks.delete(event.taskId);
      if (!mainDone) return;
      if (event.type === "agent_start") laterRuns++;
      if (event.type !== "agent_end" || event.reason === "done") return;
      laterReason = event.reason === "budget" ? "maxCostUsd" : event.reason;
    });
    const result = await agent.run(prompt, runOptions);
    mainDone = true;
    if (!args.json) io.stdout("\n");
    // Tasks the model was already told about are stopped at exit rather than
    // awaited: a server it left running would otherwise hold the run open.
    const toldAbout = new Set<string>();
    for (;;) {
      await agent.waitForSettled();
      if (result.reason !== "done" || laterReason || agent.isStopping) break;
      const waiting = agent.waitingOnUser;
      if (waiting) {
        io.stderr(`mu: waiting for you: ${waiting.reason} (ctrl+c to stop)\n`);
        await waiting.done;
        continue;
      }
      const untold = [...runningTasks].filter(([id]) => !toldAbout.has(id));
      if (untold.length === 0) break;
      for (const [id] of untold) toldAbout.add(id);
      agent.followUp(
        customMessage(
          "one_shot_run",
          `This is a one-shot run: it ends when you end your turn, and background tasks still running then are stopped, so their exits will not reach you. Still running: ${[
            ...runningTasks,
          ]
            .map(([id, command]) => `${id} (${command})`)
            .join(", ")}. Wait now for any whose result you need; otherwise end your turn.`,
        ),
      );
    }
    stopWatching();
    if (laterRuns > 0 && !args.json) io.stdout("\n");
    const reason =
      result.reason === "done"
        ? (laterReason ?? (interrupted ? "aborted" : "done"))
        : result.reason;

    if (args.json) {
      io.stdout(
        `${JSON.stringify({ type: "result", reason, sessionId: agent.sessionId, usage: agent.usage })}\n`,
      );
    }
    if (reason === "error") {
      io.stderr(`mu: ${failure ?? "the provider returned an error"}\n`);
    } else if (reason !== "done" && reason !== "aborted") {
      io.stderr(`mu: halted early (${reason})\n`);
    }
    return EXIT[reason];
  } catch (error) {
    io.stderr(`mu: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.error;
  } finally {
    process.off("SIGINT", onSigint);
    await agent.shutdown();
    unsubscribe();
  }
}

function isMarkdownCommandRun(data: unknown): data is MarkdownCommandRun {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "markdown-command" &&
    typeof (data as { prompt?: unknown }).prompt === "string"
  );
}

// Commands the terminal app shows as pickers or panels, made usable in one shot.
function registerHeadlessCommands(
  commands: CommandRegistry,
  runtime: Awaited<ReturnType<typeof createCliSessionRuntime>>,
): void {
  const { agent } = runtime;
  commands.register(
    transcriptExportCommand({
      getSession: () => agent.session,
      getSessionId: () => agent.sessionId,
      getModel: () => agent.modelRef,
      isRunning: () => agent.isRunning,
      save: async (markdown, requestedPath, now) =>
        (await saveTranscriptMarkdown(markdown, { cwd: process.cwd(), requestedPath, now }))
          .displayPath,
    }),
  );
  // Read-only: a one-shot run is configured by its flags, never by saved state.
  commands.register({
    name: "model",
    description: "List the usable models and their reasoning levels",
    run: async (ctx) => {
      if (ctx.args.trim()) {
        return { handled: true, message: "With -p, choose the model with --model <ref>." };
      }
      const models = (await usableModels({ extensions: runtime.extensions })).map((model) => ({
        ref: `${model.provider}/${model.id}`,
        ...(model.name ? { name: model.name } : {}),
        thinkingLevels: supportedThinkingLevels(model),
      }));
      return {
        handled: true,
        message: [
          `Current model: ${agent.modelRef} · thinking ${agent.thinking}`,
          ...(models.length > 0
            ? [
                "Usable models:",
                ...models.map((model) => `  ${model.ref}  ${model.thinkingLevels.join(", ")}`),
              ]
            : ["No usable models. Run mu and use /login first."]),
        ].join("\n"),
        data: {
          kind: "models",
          current: agent.modelRef,
          thinking: agent.thinking,
          models,
        } satisfies ModelsCommandData,
      };
    },
  });
  commands.register({
    name: "thinking",
    description: "List the reasoning levels of the run's model",
    run: (ctx) => {
      if (ctx.args.trim()) {
        return { handled: true, message: "With -p, choose the level with --thinking <level>." };
      }
      const levels = agent.thinkingLevels;
      return {
        handled: true,
        message: `Thinking levels for ${agent.modelRef}: ${levels
          .map((level) => (level === agent.thinking ? `${level} (current)` : level))
          .join(", ")}`,
        data: {
          kind: "thinking-levels",
          model: agent.modelRef,
          current: agent.thinking,
          levels,
        } satisfies ThinkingLevelsCommandData,
      };
    },
  });
  for (const [name, hint] of Object.entries(INTERACTIVE_ONLY)) {
    if (commands.get(name)) continue;
    commands.register({
      name,
      description: "Available in the interactive app",
      run: () => ({
        handled: true,
        message: `/${name} is only available in the interactive app${hint ? `; ${hint}` : ""}.`,
      }),
    });
  }
}

export interface ModelsCommandData {
  kind: "models";
  current: string;
  thinking: ThinkingLevel;
  models: { ref: string; name?: string; thinkingLevels: ThinkingLevel[] }[];
}

export interface ThinkingLevelsCommandData {
  kind: "thinking-levels";
  model: string;
  current: ThinkingLevel;
  levels: ThinkingLevel[];
}

const INTERACTIVE_ONLY: Record<string, string> = {
  login: "",
  logout: "",
  permissions: "with -p, pass --permission-mode or --allow-all",
  resume: "with -p, pass --resume <session>",
  new: "each -p run without --resume starts a new session",
  rename: "",
  btw: "",
  keybindings: "",
};

export function commandDataText(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const kind = (data as { kind?: unknown }).kind;
  if (isCostReport(data)) return renderCostCommand(data, 80, "none").slice(1, -1);
  if (kind === "diff") {
    // Hunks are the patch's own lines, headers included.
    return (data as DiffCommandData).files.flatMap((file) => {
      const lines = file.hunks.at(-1) === "" ? file.hunks.slice(0, -1) : file.hunks;
      return lines.length > 0 ? lines : [`${file.path} (+${file.added} -${file.removed})`];
    });
  }
  if (kind === "undo-points") {
    return [
      "Undo through a prompt with /undo <n>:",
      ...(data as UndoPointsCommandData).points.map(
        (point) =>
          `  ${point.steps}  ${point.prompt.replace(/\s+/g, " ").trim() || "(empty prompt)"}`,
      ),
    ];
  }
  return [];
}
