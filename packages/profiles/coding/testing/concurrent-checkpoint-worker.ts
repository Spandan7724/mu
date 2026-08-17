import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, optionsFromProfile } from "mu";
import { codingProfile } from "../src/index.ts";

const [root, name, gate] = process.argv.slice(2);
if (!root || !name || !gate) throw new Error("expected root, worker name, and gate path");

while (!(await Bun.file(gate).exists())) await Bun.sleep(5);

const profile = await codingProfile({ root, instructions: { enabled: false } });
const provider = new FakeProvider([
  {
    content: [
      {
        type: "toolCall",
        id: `write-${name}`,
        name: "write",
        arguments: { path: `${name}.txt`, content: `${name}\n` },
      },
    ],
  },
  { content: [{ type: "text", text: `${name} complete` }] },
]);
const options = await optionsFromProfile(profile, "fake/fake-1", {
  provider,
  model: fakeModel,
  permissions: [{ permission: "*", pattern: "*", action: "allow" }],
});
const agent = new Agent(options);
try {
  await agent.run(`create ${name}.txt`);
  const history = agent.checkpointHistory.all();
  await writeFile(
    join(root, `${name}.result.json`),
    JSON.stringify({ checkpoints: history.length }),
  );
} finally {
  await agent.shutdown();
}
