import { Agent, type AgentOptions, defaultModelRef, type HaltReason, optionsFromProfile } from "mu";
import type { ParsedArgs } from "./args.ts";
import { DEFAULT_PROFILE, resolveProfile } from "./profiles.ts";

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
): Promise<number> {
  if (!args.prompt) {
    io.stderr("mu: -p requires a prompt\n");
    return EXIT.usage;
  }

  // The profile supplies the toolset, prompt and — importantly — the
  // restrictive permission defaults the bare SDK does not have.
  let resolved: AgentOptions = options;
  if (!options.tools) {
    try {
      const profile = await resolveProfile(args.profile ?? DEFAULT_PROFILE);
      resolved = await optionsFromProfile(profile, args.model ?? defaultModelRef(), options);
    } catch (error) {
      io.stderr(`mu: could not load profile: ${error instanceof Error ? error.message : error}\n`);
      return EXIT.usage;
    }
  }

  const agent = new Agent({
    ...resolved,
    ...(args.model ? { model: args.model } : {}),
    ...(args.maxTurns !== undefined || args.maxCostUsd !== undefined
      ? {
          budget: {
            ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
            ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
          },
        }
      : {}),
    // Headless is unattended: profile "ask" rules resolve to deny (no callback)
    // unless --allow-all is passed.
    ...(args.allowAll
      ? {
          permissions: [
            ...(resolved.permissions ?? []),
            { permission: "*", pattern: "*", action: "allow" as const },
          ],
        }
      : {}),
  });

  const onSigint = () => agent.abort();
  process.on("SIGINT", onSigint);

  try {
    // Capture the provider's own message so a failure is actionable rather
    // than a bare "an error occurred".
    let failure: string | undefined;
    const stream = agent.stream(args.prompt);
    for await (const event of stream) {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error" &&
        event.message.errorMessage
      ) {
        failure = event.message.errorMessage;
      }
      if (args.json) {
        io.stdout(`${JSON.stringify(event)}\n`);
        continue;
      }
      // Text mode: stream assistant text as it arrives, nothing else.
      if (event.type === "message_update" && event.delta.kind === "text_delta") {
        io.stdout(event.delta.text);
      }
    }

    const result = await stream.result();
    if (!args.json) io.stdout("\n");

    if (result.reason === "error") {
      io.stderr(`mu: ${failure ?? "the provider returned an error"}\n`);
    } else if (result.reason !== "done" && result.reason !== "aborted") {
      io.stderr(`mu: halted early (${result.reason})\n`);
    }
    return EXIT[result.reason];
  } catch (error) {
    io.stderr(`mu: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.error;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
