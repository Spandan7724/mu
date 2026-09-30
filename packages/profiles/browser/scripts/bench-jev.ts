// Live Jev benchmark for the act tool on the local fixture site (headless, temp dirs).
// Usage: JEV_API_KEY=… bun scripts/bench-jev.ts [--runs N] [--only name,name]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { navigateTo } from "../src/actions/navigate.ts";
import { Stopwatch } from "../src/actions/types.ts";
import { BrowserManager } from "../src/browser/manager.ts";
import type { Tab } from "../src/browser/tabs.ts";
import { type ActInput, type ActStop, runAct } from "../src/jev/act.ts";
import { jevFromEnv } from "../src/jev/client.ts";
import { tempUserDataDir, testBrowserPath } from "../src/testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../src/testing/fixture-site.ts";
import { minimalPdf } from "../src/testing/pdf.ts";

interface Scenario {
  name: string;
  page: string;
  input: ActInput;
  stops: ActStop[];
  // What the page must show afterwards (a JS expression returning a string).
  check?: { expression: string; contains: string[] };
  submissions?: number;
}

const applicant = {
  "full name": "Grace Hopper",
  email: "grace@example.com",
  phone: "+1 555 0100",
  "how did you hear about us": "Friend",
  "start month": "2026-11",
  "authorized to work": "Yes",
};
const REVIEW = "document.getElementById('review').innerText";
const scenarios: Scenario[] = [
  {
    name: "wizard",
    page: "wizard",
    input: {
      goal: "the application is filled in up to its final submit",
      values: applicant,
      files: { resume: ["resume.pdf"] },
    },
    stops: ["needs-approval"],
    check: {
      expression: REVIEW,
      contains: [
        "Name: Grace Hopper",
        "Start month: 2026-11",
        "Resume: resume.pdf",
        "Heard about us: Friend",
      ],
    },
    submissions: 0,
  },
  {
    name: "wizard-other",
    page: "wizard",
    input: {
      goal: "the application is filled in up to its final submit",
      values: {
        ...applicant,
        "how did you hear about us": "Other",
        "where you heard about us, if other": "A meetup talk",
      },
      files: { resume: ["resume.pdf"] },
    },
    stops: ["needs-approval"],
    check: { expression: REVIEW, contains: ["Heard about us: Other (A meetup talk)"] },
    submissions: 0,
  },
  {
    name: "wizard-eval13",
    page: "wizard",
    input: {
      goal: "Complete the application through the final review step, filling all fields with the provided details and uploading the resume, but stop before the final submit",
      values: {
        "full name": "Grace Hopper",
        email: "grace@example.com",
        phone: "+1 555 0142",
        "how did you hear about the job": "Other",
        "please specify how you heard": "a friend at the meetup",
        "start date": "March 2026",
        "authorized to work": "yes",
      },
      files: { resume: ["resume.pdf"] },
    },
    stops: ["needs-approval", "done"],
    check: {
      expression: REVIEW,
      contains: [
        "Other (a friend at the meetup)",
        "Start month: 2026-03",
        "Authorized to work: yes",
      ],
    },
    submissions: 0,
  },
  {
    name: "wizard-missing",
    page: "wizard",
    input: {
      goal: "the application is filled in up to its final submit",
      values: { ...applicant, "how did you hear about us": "Other" },
    },
    stops: ["needs-input", "error"],
    check: { expression: "document.querySelector('.step.active').id", contains: ["step1"] },
    submissions: 0,
  },
  {
    name: "contact",
    page: "form-basic",
    input: {
      goal: "the contact form is filled in, ready to send",
      values: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        age: "36",
        message: "Please send me the analytical engine brochure.",
        "subscribe to the newsletter": false,
        plan: "Pro",
        country: "France",
      },
    },
    stops: ["needs-approval", "done"],
    check: {
      expression:
        "JSON.stringify(Object.fromEntries(new FormData(document.querySelector('form')))) + ' newsletter=' + document.querySelector('[type=checkbox]').checked",
      contains: ['"email":"ada@example.com"', '"plan":"pro"', '"country":"fr"', "newsletter=false"],
    },
  },
  {
    name: "questions",
    page: "questions",
    input: {
      goal: "the answers are saved (the page shows what was sent)",
      values: {
        "worked here before": "No",
        "needs visa sponsorship": "Yes",
        country: "India",
      },
    },
    stops: ["done", "needs-approval"],
    check: { expression: "document.body.innerText", contains: ["India"] },
  },
  {
    name: "shop",
    page: "shop-mock",
    input: { goal: "the blue mug is in the cart (the cart count shows 1)" },
    stops: ["done"],
    check: { expression: "document.getElementById('count').textContent", contains: ["1"] },
  },
  {
    name: "combobox",
    page: "combobox",
    input: { goal: "Paris is chosen as the destination", values: { city: "Paris" } },
    stops: ["done"],
    check: { expression: "document.body.innerText", contains: ["Chosen: Paris"] },
  },
];

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1] || 1) || 1;
const only = args.includes("--only") ? (args[args.indexOf("--only") + 1] ?? "").split(",") : [];
const jev = jevFromEnv();
if (!jev) {
  console.error("Set JEV_API_KEY (or TYPESAFE_API_KEY) to run the Jev benchmark.");
  process.exit(1);
}

const home = tempUserDataDir();
const workspace = join(home, "work");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "resume.pdf"), minimalPdf(["Grace Hopper", "Compilers"]));
const browser = new BrowserManager({
  connect: "managed",
  profileName: "bench-jev",
  userDataDir: join(home, "profile"),
  executable: testBrowserPath,
  headless: true,
  viewport: { width: 1280, height: 800 },
  keepOpen: false,
});
let site: FixtureSite | undefined;
const rows: string[] = [];
let passed = 0;
let total = 0;
try {
  for (const scenario of scenarios.filter((s) => only.length === 0 || only.includes(s.name))) {
    for (let run = 1; run <= runs; run++) {
      site?.stop();
      site = startFixtureSite();
      const tab: Tab = await browser.activeTab(AbortSignal.timeout(10_000));
      await navigateTo(tab, site.url(scenario.page), AbortSignal.timeout(15_000));
      const started = performance.now();
      let line: string;
      try {
        const report = await runAct(
          {
            tab,
            browser,
            stopwatch: new Stopwatch(),
            signal: AbortSignal.timeout(120_000),
          },
          scenario.input,
          { jev, uploadRoots: [workspace] },
        );
        const wall = (performance.now() - started) / 1000;
        const active = await browser.activeTab(AbortSignal.timeout(5_000));
        const shown = scenario.check
          ? String(
              (
                await active.session.send("Runtime.evaluate", {
                  expression: scenario.check.expression,
                  returnByValue: true,
                })
              ).result.value ?? "",
            )
          : "";
        const missing = (scenario.check?.contains ?? []).filter((text) => !shown.includes(text));
        const problems = [
          ...(scenario.stops.includes(report.stop) ? [] : [`stop ${report.stop}`]),
          ...missing.map((text) => `missing ${JSON.stringify(text)}`),
          ...(scenario.submissions !== undefined && site.submissions.length !== scenario.submissions
            ? [`${site.submissions.length} submissions`]
            : []),
        ];
        const ok = problems.length === 0;
        if (ok) passed++;
        const perCall = report.jev.calls ? Math.round(report.jev.ms / report.jev.calls) : 0;
        line = `${ok ? "PASS" : "FAIL"} ${scenario.name} #${run}: ${report.stop} · ${wall.toFixed(1)} s · jev ${report.jev.calls} calls, ${Math.round(report.jev.ms)} ms (${perCall} ms/call), ${report.jev.inputTokens} tok${ok ? "" : ` · ${problems.join("; ")}`}`;
        console.log(line);
        console.log(`  ${report.summary}`);
        for (const step of (report.extra ?? "").split("\n")) console.log(`  ${step}`);
      } catch (error) {
        line = `FAIL ${scenario.name} #${run}: threw ${error instanceof Error ? error.message : String(error)}`;
        console.log(line);
      }
      total++;
      rows.push(line);
    }
  }
} finally {
  await browser.shutdown({ close: true });
  site?.stop();
  rmSync(home, { recursive: true, force: true });
}
console.log(`\n${passed}/${total} passed`);
for (const row of rows) console.log(row);
