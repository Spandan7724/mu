import {
  Agent,
  type AgentOptions,
  type Command,
  type HaltReason,
  optionsFromProfile,
  type Profile,
  registryWithCoreCommands,
} from "mu";
import type { ParsedArgs } from "./args.ts";
import { withStoredCredentials } from "./auth.ts";
import { loadUserConfig, resolveCliModel } from "./config.ts";
import { loadBuiltInExtensions } from "./extensions.ts";
import { permissionModeFor, rulesForPermissionMode } from "./permissions.ts";
import { DEFAULT_PROFILE, resolveProfile, sessionStoreForProfile } from "./profiles.ts";

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
  const useBuiltIns = !options.tools;
  let profileCommands: Command[] = [];
  let profile: Profile | undefined;
  let resolved: AgentOptions = options;
  if (!options.tools) {
    try {
      profile = await resolveProfile(args.profile ?? DEFAULT_PROFILE);
      profileCommands = profile.commands ?? [];
      resolved = await optionsFromProfile(profile, await resolveCliModel(args.model), options);
      if (!resolved.session) {
        resolved = { ...resolved, session: await sessionStoreForProfile(profile) };
      }
    } catch (error) {
      io.stderr(`mu: could not load profile: ${error instanceof Error ? error.message : error}\n`);
      return EXIT.usage;
    }
  }
  try {
    if (profile) {
      const configuredModes = (await loadUserConfig()).permissionModes;
      const requestedMode = args.permissionMode ?? configuredModes?.[profile.name];
      const mode = args.allowAll
        ? profile.permissionModes?.find((candidate) => candidate.id === "yolo")
        : permissionModeFor(profile, requestedMode);
      resolved = {
        ...resolved,
        permissions: args.allowAll
          ? [...(resolved.permissions ?? []), { permission: "*", pattern: "*", action: "allow" }]
          : rulesForPermissionMode(resolved.permissions, mode),
      };
    } else if (args.permissionMode) {
      throw new Error("--permission-mode requires a profile with permission modes");
    }
  } catch (error) {
    io.stderr(`mu: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.usage;
  }
  resolved = withStoredCredentials(resolved);

  const builtIns = useBuiltIns
    ? await loadBuiltInExtensions(process.cwd(), resolved.extensions)
    : undefined;
  const extensions = builtIns?.host ?? resolved.extensions;
  for (const warning of builtIns?.warnings ?? []) io.stderr(`mu: ${warning}\n`);

  const agent = new Agent({
    ...resolved,
    ...(extensions ? { extensions } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.maxTurns !== undefined || args.maxCostUsd !== undefined
      ? {
          budget: {
            ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
            ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
          },
        }
      : {}),
    // Headless is unattended: profile "ask" rules resolve to deny (no callback).
  });

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
    if (args.json) {
      io.stdout(`${JSON.stringify(event)}\n`);
    } else if (event.type === "message_update" && event.delta.kind === "text_delta") {
      io.stdout(event.delta.text);
    }
  });

  try {
    const commands = registryWithCoreCommands({
      requestCompaction: () => agent.requestCompaction(),
      usage: () => ({
        ...agent.usage,
        contextPercent: agent.contextPercent,
      }),
      undo: () => agent.undo(),
      redo: () => agent.redo(),
      fork: (entryId) => agent.fork(entryId),
      forkPoints: () => agent.forkPoints(),
      diff: () => agent.sessionDiff(),
    });
    for (const command of profileCommands) commands.register(command);
    for (const command of extensions?.commands.list() ?? []) commands.register(command);

    const printed: string[] = [];
    const command = await commands.execute(args.prompt, {
      inject: () => {},
      print: (text) => printed.push(text),
      getModel: () => agent.modelRef,
      setModel: (ref) => agent.setModel(ref),
    });
    if (command.handled) {
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
    const result = await agent.run(args.prompt);
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
    await agent.shutdown();
    unsubscribe();
  }
}
