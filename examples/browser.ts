// A browser agent from the SDK: drives the mu-managed Chrome profile (sign in once
// with `mu browser login`), asks before consequential actions, and returns text.
//
//   bun examples/browser.ts "What's the top story on news.ycombinator.com?"
import { createAgent } from "@mu-agent/mu";

const agent = await createAgent({
  profile: "browser",
  profileOptions: { browserProfile: "default", vision: "auto" },
  // Approve or deny each consequential action (send, buy, delete…), secret, upload or script.
  onPermission: async (request) => {
    console.error(`asked: ${request.description}`);
    return request.permission === "browser:commit" ? "deny" : "allow";
  },
  budget: { maxTurns: 30, maxCostUsd: 1 },
});

const result = await agent.run(process.argv[2] ?? "Open example.com and tell me its heading.");
console.log(result.text);
await agent.shutdown();
