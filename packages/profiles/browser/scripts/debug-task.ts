// Runs one live eval task and prints the tool-call trail: bun …/debug-task.ts <task>
import { getProvider } from "@mu/ai";
import { Agent, createCredentialResolver, optionsFromProfile } from "mu";
import { TASKS } from "../src/evals/live.ts";
import { browserProfile } from "../src/index.ts";
import { tempUserDataDir, testBrowserPath } from "../src/testing/chrome.ts";
import { startFixtureSite } from "../src/testing/fixture-site.ts";

const task = TASKS.find((candidate) => candidate.id === Number(process.argv[2]));
if (!task) throw new Error("unknown task");
const modelRef = process.argv[3] ?? "openai-codex/gpt-5.6-luna";
const site = startFixtureSite();
const profile = await browserProfile({
  home: tempUserDataDir(),
  headless: true,
  keepOpen: false,
  ...(testBrowserPath ? { executable: testBrowserPath } : {}),
});
const agent = new Agent(
  await optionsFromProfile(profile, modelRef, {
    provider: getProvider(modelRef.split("/")[0] as string),
    model: modelRef,
    getCredentials: createCredentialResolver(),
    budget: { maxTurns: 25 },
    onPermission: async () => "allow",
  } as never),
);
agent.subscribe((event) => {
  if (event.type === "tool_execution_end") {
    const text = event.result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    console.log(`→ ${event.result.toolName}: ${text.split("\n")[0]?.slice(0, 200)}`);
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "toolCall")
        console.log(`  call ${block.name} ${JSON.stringify(block.arguments).slice(0, 200)}`);
      if (block.type === "text" && block.text.trim())
        console.log(`  says: ${block.text.slice(0, 200)}`);
    }
    if (event.message.errorMessage) console.log(`  ERROR ${event.message.errorMessage}`);
  }
});
const result = await agent.run(task.prompt({ site }));
console.log(`\n${result.reason} · ${result.text.slice(0, 400)}`);
await agent.shutdown();
await profile.browser.shutdown({ close: true });
site.stop();
