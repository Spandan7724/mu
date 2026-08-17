import { AgentViewClient } from "../src/agent-view-client.ts";
import { agentViewPaths } from "../src/agent-view-store.ts";

const [root, prompt, profile] = process.argv.slice(2);
if (!root || !prompt || !profile) throw new Error("missing isolated dispatch fixture arguments");

const waitFor = async (predicate: () => boolean, timeout = 4_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for supervisor state");
    await Bun.sleep(10);
  }
};

const client = new AgentViewClient({
  paths: agentViewPaths(root),
  scope: "project",
  cwd: root,
});

try {
  await client.connect(false);
  let dispatchError = "";
  try {
    await client.dispatch({ prompt, cwd: root, profile });
  } catch (error) {
    dispatchError = error instanceof Error ? error.message : String(error);
  }
  await waitFor(() => client.records[0]?.state === "failed");
  process.stdout.write(`${JSON.stringify({ dispatchError, record: client.records[0] })}\n`);
} finally {
  client.close();
}
