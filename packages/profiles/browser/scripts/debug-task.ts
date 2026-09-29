// Runs one live eval task and prints the tool-call trail: bun …/debug-task.ts <task>
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getProvider } from "@mu/ai";
import { Agent, createCredentialResolver, optionsFromProfile } from "mu";
import { TASKS } from "../src/evals/live.ts";
import { browserProfile } from "../src/index.ts";
import { tempUserDataDir, testBrowserPath } from "../src/testing/chrome.ts";
import { startFixtureSite } from "../src/testing/fixture-site.ts";

// A task number from the eval matrix, or any prompt in quotes.
const arg = process.argv[2] ?? "";
const task = /^\d+$/.test(arg)
  ? TASKS.find((candidate) => candidate.id === Number(arg))
  : { prompt: () => arg };
if (!task) throw new Error("unknown task");
const modelRef = process.argv[3] ?? "openai-codex/gpt-5.6-luna";
const site = startFixtureSite();
// Delegation runs the freshly built mu, not whatever is on PATH.
const builtMu = join(import.meta.dir, "../../../../dist/mu");
// MU_PROFILE: use that managed (signed-in) profile, headed, instead of a temporary one.
const profile = await browserProfile({
  ...(process.env.MU_PROFILE
    ? { browserProfile: process.env.MU_PROFILE, headless: false, keepOpen: true }
    : { home: tempUserDataDir(), headless: true, keepOpen: false }),
  ...(testBrowserPath ? { executable: testBrowserPath } : {}),
  ...(existsSync(builtMu) ? { codingCommand: [builtMu] } : {}),
});
const agent = new Agent(
  await optionsFromProfile(profile, modelRef, {
    provider: getProvider(modelRef.split("/")[0] as string),
    model: modelRef,
    getCredentials: createCredentialResolver(),
    budget: { maxTurns: 25 },
    // MU_APPROVE_ONLY: a regex; asks whose preview does not match are denied.
    onPermission: async (request: import("@mu/core").PermissionRequest) => {
      const preview = request.preview?.kind === "text" ? request.preview.lines.join(" | ") : "";
      const only = process.env.MU_APPROVE_ONLY;
      const answer = !only || new RegExp(only).test(preview) ? "allow" : "deny";
      console.log(`  ASK ${request.permission} → ${answer}: ${preview.slice(0, 260)}`);
      return answer;
    },
  } as never),
);
agent.subscribe((event) => {
  if (event.type === "tool_execution_end") {
    const text = event.result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    console.log(`→ ${event.result.toolName}: ${text.split("\n")[0]?.slice(0, 200)}`);
    // MU_TRACE: a file that receives every full tool result.
    if (process.env.MU_TRACE)
      appendFileSync(process.env.MU_TRACE, `\n===== ${event.result.toolName}\n${text}\n`);
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
// Free-form prompts can name fixture pages as {site:<page>}.
const prompt = task.prompt({ site }).replace(/\{site:([\w-]+)\}/g, (_, page) => site.url(page));
const result = await agent.run(prompt);
console.log(`\n${result.reason} · ${result.text.slice(0, 400)}`);
console.log(`open tabs at the end: ${profile.browser.tabs().length}`);
await agent.shutdown();
await profile.browser.shutdown({ close: true });
site.stop();
