#!/usr/bin/env bun
import { Agent } from "mu";
import { HELP_TEXT, parseArgs } from "./args.ts";
import { EXIT, runHeadless } from "./headless.ts";
import { runInteractive } from "./interactive.ts";
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
      const agent = new Agent({
        ...(args.model ? { model: args.model } : {}),
        permissions: args.allowAll
          ? [{ permission: "*", pattern: "*", action: "allow" as const }]
          : [{ permission: "*", pattern: "*", action: "ask" as const }],
        onPermission: (request) =>
          new Promise<"allow" | "deny">((resolve) => pending.set(request.id, resolve)),
      });
      await runRpc(
        { write: io.stdout, lines: linesFrom(process.stdin) },
        {
          agent,
          resolvePermission: (requestId, outcome) => {
            const resolve = pending.get(requestId);
            if (!resolve) return false;
            pending.delete(requestId);
            resolve(outcome);
            return true;
          },
        },
      );
      return 0;
    }
    default:
      return runInteractive(args);
  }
}

process.exitCode = await main();
