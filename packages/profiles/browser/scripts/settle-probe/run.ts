// Records what happens around every browser action, for replaying settle rules offline:
//   bun packages/profiles/browser/scripts/settle-probe/run.ts --out /tmp/probe
//     [--only <regex>] [--synthetic | --real | --signed-in] [--runs cold,warm,plain]
//     [--browser-profile <name>] [--window-class <class>]
// --window-class sets Chrome's window class, so a compositor rule can place the window
// (for example on a hidden workspace, to check rendering there).
// Runs: cold = first visit with snapshot sampling; warm = repeat visit with sampling;
// plain = repeat visit without sampling (shows how much sampling itself costs).
// Uses a temporary signed-out profile unless --browser-profile names a managed one
// (that browser must not be open elsewhere).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { navigateTo } from "../../src/actions/navigate.ts";
import { BrowserManager } from "../../src/browser/manager.ts";
import type { Tab } from "../../src/browser/tabs.ts";
import { resolveBrowserOptions } from "../../src/config.ts";
import { renderSnapshot } from "../../src/page/render.ts";
import { type SettleTrace, settleTraces } from "../../src/page/settle.ts";
import { capturePage } from "../../src/page/snapshot.ts";
import { tempUserDataDir, testBrowserPath } from "../../src/testing/chrome.ts";
import { interactionTools } from "../../src/tools/interact.ts";
import { navigateTool } from "../../src/tools/navigate.ts";
import { startProbeSite } from "./pages.ts";
import {
  REAL_SCENARIOS,
  type Scenario,
  SIGNED_IN_SCENARIOS,
  type Step,
  syntheticScenarios,
} from "./scenarios.ts";

export interface ProbeRequest {
  id: string;
  type: string;
  method: string;
  url: string;
  start: number;
  end?: number;
  failed?: boolean;
}

export interface ProbeSample {
  t: number;
  tEnd: number;
  lines?: string[];
  busy?: boolean;
  error?: string;
}

export interface ActionLog {
  scenario: string;
  kind: "synthetic" | "real";
  marker?: string;
  run: string;
  step: number;
  tool: string;
  startedAt: number;
  endedAt: number;
  outcome: string;
  // What the tool returned to the model.
  observation?: string;
  timings?: Record<string, number>;
  traces: SettleTrace[];
  requests: ProbeRequest[];
  page: { t: number; kind: string; loaderId?: string }[];
  mutations: number[];
  samples: ProbeSample[];
}

const now = () => performance.timeOrigin + performance.now();
const SAMPLE_MS = 250;
const TAIL_MS = 4_000;
const PROBE = 'Symbol.for("mu.settle-probe")';
const MUTATION_SCRIPT = `(function(){var k=${PROBE};if(window[k])return;var log=[];Object.defineProperty(window,k,{value:log});new MutationObserver(function(rs){for(var i=0;i<rs.length;i++){if(rs[i].type!=="attributes"||rs[i].attributeName!=="style"){log.push(Date.now());return}}}).observe(document,{subtree:true,childList:true,characterData:true,attributes:true});})()`;
const BUSY_SCRIPT = `(function(){var els=document.querySelectorAll('[aria-busy="true"],[role="progressbar"],progress');for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();if(r.width>0&&r.height>0)return true}return false})()`;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const outDir = flag("--out") ?? "/tmp/settle-probe";
const only = flag("--only") ? new RegExp(flag("--only") as string, "i") : undefined;
const runs = (flag("--runs") ?? "cold,warm,plain").split(",");
const managed = flag("--browser-profile");
const windowClass = flag("--window-class");

const site = startProbeSite();
const scenarios = (
  argv.includes("--signed-in")
    ? SIGNED_IN_SCENARIOS
    : [
        ...(argv.includes("--real") ? [] : syntheticScenarios(site.url)),
        ...(argv.includes("--synthetic") ? [] : REAL_SCENARIOS),
      ]
).filter((scenario) => !only || only.test(scenario.name));

const home = tempUserDataDir();
const userDataDir = managed
  ? resolveBrowserOptions({ browserProfile: managed }).userDataDir
  : tempUserDataDir();
const config = resolveBrowserOptions({
  home,
  headless: !managed,
  vision: "off",
  keepOpen: Boolean(managed),
});
const manager = new BrowserManager({
  connect: "managed",
  profileName: managed ?? "settle-probe",
  userDataDir,
  executable: testBrowserPath,
  headless: !managed,
  viewport: config.viewport,
  keepOpen: Boolean(managed),
  ...(windowClass ? { args: [`--class=${windowClass}`] } : {}),
});
const deps = { browser: manager, config, vision: () => false };
const interaction = interactionTools(deps);
const tools = {
  navigate: navigateTool(deps),
  click: interaction.click,
  type: interaction.type,
  press: interaction.press,
};

let current: ActionLog | undefined;
const live = new Map<string, ProbeRequest>();
const instrumented = new WeakSet<Tab>();
settleTraces.listener = (trace) => current?.traces.push(trace);

async function instrument(tab: Tab): Promise<void> {
  if (instrumented.has(tab)) return;
  instrumented.add(tab);
  tab.frames.onSession((session) => {
    const finish = (id: string, failed = false) => {
      const request = live.get(id);
      if (!request) return;
      live.delete(id);
      request.end = now();
      if (failed) request.failed = true;
    };
    const offs = [
      session.on("Network.requestWillBeSent", (event) => {
        const url = new URL(event.request.url, "http://x");
        const request: ProbeRequest = {
          id: event.requestId,
          type: event.type ?? "Other",
          method: event.request.method,
          url: event.request.url.startsWith("data:") ? "data:" : `${url.host}${url.pathname}`,
          start: now(),
        };
        // A redirect re-sends under the same id; the tracker restarts its clock too.
        const previous = live.get(event.requestId);
        if (previous) previous.end = request.start;
        live.set(event.requestId, request);
        current?.requests.push(request);
      }),
      session.on("Network.loadingFinished", (event) => finish(event.requestId)),
      session.on("Network.loadingFailed", (event) => finish(event.requestId, true)),
      session.on("Network.requestServedFromCache", (event) => finish(event.requestId)),
    ];
    return () => {
      for (const off of offs) off();
    };
  });
  const main = (frameId: string) => frameId === tab.frames.mainFrameId;
  const mark = (kind: string, loaderId?: string) =>
    current?.page.push({ t: now(), kind, ...(loaderId ? { loaderId } : {}) });
  tab.session.on("Page.frameStartedNavigating", (event) => {
    if (main(event.frameId)) mark(`startedNavigating:${event.navigationType}`, event.loaderId);
  });
  tab.session.on("Page.frameNavigated", (event) => {
    if (!event.frame.parentId) mark("navigated", event.frame.loaderId);
  });
  tab.session.on("Page.lifecycleEvent", (event) => {
    if (main(event.frameId) && (event.name === "DOMContentLoaded" || event.name === "load"))
      mark(event.name, event.loaderId);
  });
  tab.session.on("Page.navigatedWithinDocument", (event) => {
    if (main(event.frameId)) mark("sameDocument");
  });
  await tab.session.send("Page.addScriptToEvaluateOnNewDocument", { source: MUTATION_SCRIPT });
}

async function mutationLog(tab: Tab, clear: boolean): Promise<number[]> {
  const result = await tab.session
    .send(
      "Runtime.evaluate",
      {
        expression: `(function(){${MUTATION_SCRIPT};var l=window[${PROBE}];var c=l.slice();${clear ? "l.length=0;" : ""}return c})()`,
        returnByValue: true,
      },
      { timeoutMs: 3_000 },
    )
    .catch(() => undefined);
  return (result?.result.value as number[] | undefined) ?? [];
}

async function sample(tab: Tab): Promise<ProbeSample> {
  const t = now();
  try {
    const signal = AbortSignal.timeout(3_000);
    const model = await capturePage(tab, { scope: "viewport", signal });
    const lines = renderSnapshot(model, { scope: "viewport" }).canonical.split("\n");
    const contextId = await tab.frames.isolatedWorld(tab.frames.mainFrameId ?? "", signal);
    const busy = await tab.session.send(
      "Runtime.evaluate",
      { expression: BUSY_SCRIPT, contextId, returnByValue: true },
      { signal },
    );
    return { t, tEnd: now(), lines, busy: busy.result.value === true };
  } catch (error) {
    return { t, tEnd: now(), error: error instanceof Error ? error.message : String(error) };
  }
}

async function runStep(
  scenario: Scenario,
  run: string,
  index: number,
  step: Step,
  previousText: string,
): Promise<{ log: ActionLog; text: string } | undefined> {
  let args: Record<string, unknown>;
  if (step.tool === "navigate") args = { url: step.url };
  else {
    const ref = step.find ? step.find.exec(previousText)?.[1] : undefined;
    if (step.find && !ref) {
      console.log(`  step ${index}: no element matches ${step.find} — skipped`);
      return undefined;
    }
    args = { ...step.args, ...(ref ? { ref } : {}) };
  }
  const tab = await manager.activeTab();
  await instrument(tab);
  await mutationLog(tab, true);
  const log: ActionLog = {
    scenario: scenario.name,
    kind: scenario.kind,
    ...(scenario.marker ? { marker: scenario.marker } : {}),
    run,
    step: index,
    tool: step.tool,
    startedAt: now(),
    endedAt: 0,
    outcome: "",
    traces: [],
    requests: [],
    page: [],
    mutations: [],
    samples: [],
  };
  current = log;
  // Requests already in flight count toward settle's network clock too.
  log.requests.push(...live.values());
  let sampling = run !== "plain";
  const sampler = (async () => {
    while (sampling) {
      const started = now();
      log.samples.push(await sample(await manager.activeTab()));
      await Bun.sleep(Math.max(0, SAMPLE_MS - (now() - started)));
    }
  })();
  const result = await tools[step.tool].execute(
    "probe",
    args as never,
    AbortSignal.timeout(60_000),
  );
  log.endedAt = now();
  const details = (result.details ?? {}) as {
    summary?: string;
    details?: { timings?: Record<string, number>; settle?: string };
  };
  log.outcome = `${details.summary ?? ""}${details.details?.settle ? ` · ${details.details.settle}` : ""}`;
  if (details.details?.timings) log.timings = details.details.timings;
  await Bun.sleep(run === "plain" ? 500 : TAIL_MS);
  sampling = false;
  await sampler;
  current = undefined;
  log.mutations = await mutationLog(await manager.activeTab(), false);
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  log.observation = text;
  return { log, text };
}

const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
try {
  for (const run of runs) {
    mkdirSync(join(outDir, run), { recursive: true });
    for (const scenario of scenarios) {
      console.log(`[${run}] ${scenario.name}`);
      try {
        await navigateTo(await manager.activeTab(), "about:blank");
        let text = "";
        for (const [index, step] of scenario.steps.entries()) {
          const done = await runStep(scenario, run, index, step, text);
          if (!done) break;
          text = done.text;
          writeFileSync(
            join(outDir, run, `${slug(scenario.name)}.${index}.json`),
            JSON.stringify(done.log),
          );
          const trace = done.log.traces.at(-1);
          console.log(
            `  step ${index} ${step.tool}: ${Math.round(done.log.endedAt - done.log.startedAt)} ms · ${trace?.reason ?? "no settle"}`,
          );
        }
      } catch (error) {
        console.log(`  failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
} finally {
  settleTraces.listener = undefined;
  await manager.shutdown();
  site.stop();
  if (!managed) rmSync(userDataDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
// A kept-open browser leaves its connection holding the process.
process.exit(0);
