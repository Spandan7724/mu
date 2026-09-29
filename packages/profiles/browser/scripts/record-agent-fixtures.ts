// Records agent cassettes against the live Codex-plan model:
//   bun packages/profiles/browser/scripts/record-agent-fixtures.ts [model] [scenario…]
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProvider, recordFetch } from "@mu/ai";
import { createCredentialResolver } from "mu";
import { browserProfile } from "../src/index.ts";
import { runScenario, SCENARIOS, withFetch } from "../src/testing/agent-scenarios.ts";
import { tempUserDataDir, testBrowserPath } from "../src/testing/chrome.ts";
import { FIXTURE_DIR, startFixtureSite } from "../src/testing/fixture-site.ts";

const modelRef = process.argv[2] ?? "openai-codex/gpt-5.6-luna";
const only = process.argv.slice(3);
const site = startFixtureSite();
try {
  for (const scenario of SCENARIOS.filter(
    (candidate) => only.length === 0 || only.includes(candidate.name),
  )) {
    const home = tempUserDataDir();
    const profile = await browserProfile({
      home,
      headless: true,
      keepOpen: false,
      vision: "off",
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
    const recorder = recordFetch();
    const provider = withFetch(getProvider(modelRef.split("/")[0] as string), recorder.fetch);
    const started = performance.now();
    const run = await runScenario(scenario, profile, site, provider, modelRef, {
      getCredentials: createCredentialResolver(),
    });
    const file = join(FIXTURE_DIR, "..", "agent", `${scenario.name}.json`);
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          origin: site.origin,
          crossOrigin: site.crossOrigin,
          model: modelRef,
          // Request bodies are not needed for replay and would only bloat the fixture.
          interactions: recorder.cassette.interactions.map(({ request, response }) => ({
            request: { method: request.method, url: request.url },
            // Account identifiers never belong in a committed fixture.
            response: {
              ...response,
              body: response.body.replace(/user-[A-Za-z0-9]{8,}/g, "user-redacted"),
            },
          })),
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `${scenario.name}: ${recorder.cassette.interactions.length} requests, ${Math.round(performance.now() - started)} ms, asks=${run.asks.map((ask) => ask.permission).join(",") || "none"}\n  → ${run.text.replace(/\s+/g, " ").slice(0, 200)}`,
    );
    await run.agent.shutdown();
    await profile.browser.shutdown({ close: true });
    rmSync(home, { recursive: true, force: true });
  }
} finally {
  site.stop();
}
