import { AgentViewClient } from "../src/agent-view-client.ts";
import { agentViewPaths } from "../src/agent-view-store.ts";

const root = process.argv[2];
if (!root) throw new Error("missing agent-view fixture root");

const client = new AgentViewClient({
  paths: agentViewPaths(root),
  scope: "project",
  cwd: root,
});

const run = async () => {
  await client.connect(false);
  try {
    await client.dispatch({ prompt: "stale generation", cwd: root, profile: "stale-output" });
    return { error: "dispatch unexpectedly succeeded", state: client.records[0]?.state };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      state: client.records[0]?.state,
      lastError: client.records[0]?.lastError,
    };
  }
};

let timeout: ReturnType<typeof setTimeout> | undefined;
const result = await Promise.race([
  run(),
  new Promise<{ error: string; state: undefined }>((resolve) => {
    timeout = setTimeout(
      () => resolve({ error: "client timed out after 5000ms", state: undefined }),
      5_000,
    );
  }),
]).finally(() => {
  if (timeout) clearTimeout(timeout);
});
client.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
if (
  !result.error.includes("stale ownership generation") ||
  result.state !== "failed" ||
  !("lastError" in result) ||
  !result.lastError?.includes("stale ownership generation")
) {
  process.exitCode = 1;
}
