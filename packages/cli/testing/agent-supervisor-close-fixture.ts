import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSupervisor } from "../src/agent-supervisor.ts";
import { AgentViewClient } from "../src/agent-view-client.ts";
import { agentViewPaths } from "../src/agent-view-store.ts";

const root = await mkdtemp(join(tmpdir(), "mu-supervisor-close-fixture-"));
const paths = agentViewPaths(root);
const workerFixture = join(import.meta.dir, "agent-worker-fixture.ts");
const supervisor = new AgentSupervisor({
  paths,
  forceStopMs: 60_000,
  command: (args) => [process.execPath, workerFixture, ...args],
});
const client = new AgentViewClient({ paths, scope: "project", cwd: root });

try {
  await supervisor.start();
  await client.connect(false);
  await client.dispatch({ prompt: "ordinary", cwd: root, profile: "coding" });
  client.close();
  await supervisor.close();
} finally {
  client.close();
  await supervisor.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
