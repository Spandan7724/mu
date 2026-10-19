import type { AgentOptions, AgentRunOptions, HaltReason, MarkdownCommandRun } from "mu";
import type { ParsedArgs } from "./args.ts";
import { browserFlags } from "./profiles.ts";
import { createCliSessionRuntime } from "./session-runtime.ts";

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

  const onSigint = () => agent.stop();
  process.on("SIGINT", onSigint);

  let failure: string | undefined;
  const unsubscribe = agent.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error" &&
      event.message.errorMessage
    ) {
      failure = event.message.errorMessage;
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
      io.stdout(`${JSON.stringify(event)}\n`);
    } else if (event.type === "message_update" && event.delta.kind === "text_delta") {
      io.stdout(event.delta.text);
    }
  });

  try {
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
      } else if (messages.length > 0) {
        io.stdout(`${messages.join("\n")}\n`);
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
    const stopWatching = agent.subscribe((event) => {
      if (!mainDone) return;
      if (event.type === "agent_start") laterRuns++;
      if (event.type !== "agent_end" || event.reason === "done") return;
      laterReason = event.reason === "budget" ? "maxCostUsd" : event.reason;
    });
    const result = await agent.run(prompt, runOptions);
    mainDone = true;
    if (!args.json) io.stdout("\n");
    await agent.waitForSettled();
    stopWatching();
    if (laterRuns > 0 && !args.json) io.stdout("\n");
    const reason = result.reason === "done" ? (laterReason ?? "done") : result.reason;

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
