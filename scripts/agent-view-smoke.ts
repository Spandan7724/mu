import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AgentViewClient } from "../packages/cli/src/agent-view-client.ts";
import { agentViewPaths } from "../packages/cli/src/agent-view-store.ts";

const requested = process.argv[2];
if (!requested) throw new Error("usage: bun scripts/agent-view-smoke.ts <mu executable>");
const executable = isAbsolute(requested) ? requested : resolve(requested);
const root = await mkdtemp(join(tmpdir(), "mu-agent-view-compiled-"));
const muHome = join(root, ".mu");
const paths = agentViewPaths(join(muHome, "agents"));
const supervisor = Bun.spawn([executable, "__agents-supervisor"], {
  env: { ...process.env, MU_HOME: muHome },
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
  windowsHide: true,
});
const client = new AgentViewClient({ paths, scope: "compiled-smoke", cwd: root });

try {
  let connected = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await client.connect(false);
      connected = true;
      break;
    } catch (error) {
      lastError = error;
      await Bun.sleep(25);
    }
  }
  if (!connected) {
    throw new Error(
      `compiled supervisor did not accept connections: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  await client.list();
  if (client.records.length !== 0) throw new Error("fresh compiled supervisor roster is not empty");
  process.stdout.write("compiled agent-view supervisor smoke passed\n");
} finally {
  client.close();
  supervisor.kill("SIGKILL");
  await supervisor.exited;
  await rm(root, { recursive: true, force: true });
}
