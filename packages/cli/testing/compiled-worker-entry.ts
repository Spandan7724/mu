#!/usr/bin/env bun
import { parseArgs } from "@mu/cli-runtime";
import { runAgentWorker } from "../src/agent-worker.ts";
import { codingProduct } from "../src/product.ts";

const input = process.env.MU_COMPILED_WORKER_INPUT;
const lines = input
  ? (async function* () {
      for (const line of (await Bun.file(input).text()).split("\n")) {
        if (line) yield line;
      }
    })()
  : undefined;

process.exitCode = await runAgentWorker(parseArgs(process.argv.slice(2), codingProduct), {
  ...(lines ? { lines } : {}),
});
