#!/usr/bin/env bun
import { HELP_TEXT, parseArgs } from "./args.ts";
import { EXIT, runHeadless } from "./headless.ts";

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
    case "rpc":
      io.stderr("mu: --rpc is not implemented yet (M4)\n");
      return EXIT.usage;
    default:
      io.stderr("mu: the interactive terminal app is not implemented yet (M6). Use -p for now.\n");
      return EXIT.usage;
  }
}

process.exitCode = await main();
