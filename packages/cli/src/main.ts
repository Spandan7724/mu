#!/usr/bin/env bun
import {
  Agent,
  loadMarkdownCommands,
  optionsFromProfile,
  refreshModels,
  registryWithCoreCommands,
  toCommand,
} from "mu";
import { HELP_TEXT, parseArgs } from "./args.ts";
import { resolveCliModel } from "./config.ts";
import { loadBuiltInExtensions } from "./extensions.ts";
import { EXIT, runHeadless } from "./headless.ts";
import { runInteractive } from "./interactive.ts";
import { DEFAULT_PROFILE, resolveProfile } from "./profiles.ts";
import { linesFrom, runRpc } from "./rpc.ts";

const VERSION = "0.0.1";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const io = {
    stdout: (chunk: string) => process.stdout.write(chunk),
    stderr: (chunk: string) => process.stderr.write(chunk),
  };

  if (args.errors.length > 0) {
    for (const error of args.errors) io.stderr(`mu: ${error}\n`);
    io.stderr(HELP_TEXT);
    return EXIT.usage;
  }

  if (args.mode === "tui" || args.mode === "headless" || args.mode === "rpc") {
    await refreshModels().catch(() => {
      // The bundled catalog remains available when discovery is offline.
    });
  }

  switch (args.mode) {
    case "help":
      io.stdout(HELP_TEXT);
      return 0;
    case "version":
      io.stdout(`mu ${VERSION}\n`);
      return 0;
    case "headless":
      return runHeadless(args, {}, io);
    case "rpc": {
      // Permission asks are forwarded to the embedder, which answers with a
      // permission_reply op; nothing is auto-denied in RPC mode.
      const pending = new Map<string, (outcome: "allow" | "deny") => void>();
      const profile = await resolveProfile(args.profile ?? DEFAULT_PROFILE);
      const resolved = await optionsFromProfile(profile, await resolveCliModel(args.model));
      const builtIns = await loadBuiltInExtensions(process.cwd(), resolved.extensions);
      for (const warning of builtIns.warnings) io.stderr(`mu: mcp: ${warning}\n`);
      const agent = new Agent({
        ...resolved,
        extensions: builtIns.host,
        ...(args.allowAll
          ? {
              permissions: [
                ...(resolved.permissions ?? []),
                { permission: "*", pattern: "*", action: "allow" as const },
              ],
            }
          : {}),
        onPermission: (request) =>
          new Promise<"allow" | "deny">((resolve) => pending.set(request.id, resolve)),
      });
      const commands = registryWithCoreCommands({
        requestCompaction: () => agent.requestCompaction(),
        usage: () => ({ costUsd: agent.usage.costUsd ?? 0, contextPercent: agent.contextPercent }),
        undo: () => agent.undo(),
        redo: () => agent.redo(),
        fork: (entryId) => agent.fork(entryId),
        forkPoints: () => agent.forkPoints(),
        diff: () => agent.sessionDiff(),
      });
      for (const markdown of await loadMarkdownCommands({ projectDir: process.cwd() })) {
        commands.register(toCommand(markdown));
      }

      try {
        await runRpc(
          { write: io.stdout, lines: linesFrom(process.stdin) },
          {
            agent,
            runCommand: async (text) => {
              const result = await commands.execute(text, {
                inject: () => {},
                print: () => {},
                getModel: () => agent.modelRef,
                setModel: (ref) => agent.setModel(ref),
              });
              return result;
            },
            resolvePermission: (requestId, outcome) => {
              const resolve = pending.get(requestId);
              if (!resolve) return false;
              pending.delete(requestId);
              resolve(outcome);
              return true;
            },
          },
        );
      } finally {
        for (const [id, resolve] of pending) {
          resolve("deny");
          pending.delete(id);
        }
        await agent.shutdown();
      }
      return 0;
    }
    default:
      return runInteractive(args);
  }
}

process.exitCode = await main();
