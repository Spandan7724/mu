#!/usr/bin/env bun
import { runAgentWorker } from "../src/agent-worker.ts";
import { parseArgs } from "../src/args.ts";

const input = process.env.MU_COMPILED_WORKER_INPUT;
const lines = input
  ? (async function* () {
      for (const line of (await Bun.file(input).text()).split("\n")) {
        if (line) yield line;
      }
    })()
  : undefined;

process.exitCode = await runAgentWorker(parseArgs(process.argv.slice(2)), {
  ...(lines ? { lines } : {}),
});
