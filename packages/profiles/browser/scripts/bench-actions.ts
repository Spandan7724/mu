// Action overhead on the fixture site: bun packages/profiles/browser/scripts/bench-actions.ts [iterations]
import { rmSync } from "node:fs";
import { benchActions, formatActionBench } from "../src/testing/bench.ts";
import { tempUserDataDir } from "../src/testing/chrome.ts";

const iterations = Number(process.argv[2] ?? 20);
const home = tempUserDataDir();
try {
  console.log(formatActionBench(await benchActions(home, iterations)));
} finally {
  rmSync(home, { recursive: true, force: true });
}
