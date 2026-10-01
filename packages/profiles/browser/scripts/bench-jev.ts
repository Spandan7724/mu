// Live Jev benchmark for the act tool's step plans, on the fixture site and real sites
// (read-only; nothing is submitted), headless with temp dirs.
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
const WIZARD: ActInput["steps"] = [
  { action: "fill" },
  { action: "click", target: "Next" },
  { action: "fill" },
  { action: "click", target: "Next" },
  { action: "click", target: "Submit application" },
];
const BOOKS = "https://books.toscrape.com/";
const scenarios: Scenario[] = [
  {
    name: "wizard",
    page: "wizard",
    input: { steps: WIZARD, values: applicant, files: { resume: ["resume.pdf"] } },
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
    name: "wizard-eval13",
    page: "wizard",
    input: {
      steps: WIZARD,
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
    stops: ["needs-approval"],
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
    name: "contact",
    page: "form-basic",
    input: {
      steps: [{ action: "fill" }, { action: "click", target: "Send message" }],
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
    stops: ["needs-approval"],
    check: {
      expression:
        "JSON.stringify(Object.fromEntries(new FormData(document.querySelector('form')))) + ' newsletter=' + document.querySelector('[type=checkbox]').checked",
      contains: ['"email":"ada@example.com"', '"plan":"pro"', '"country":"fr"', "newsletter=false"],
    },
  },
  {
    name: "shop-blue",
    page: "shop-mock",
    input: { steps: [{ action: "click", target: "Add to cart for the blue mug" }] },
    stops: ["done"],
    check: { expression: "document.getElementById('count').textContent", contains: ["1"] },
  },
  {
    name: "shop-filter",
    page: "shop-mock",
    input: {
      steps: [
        { action: "select", target: "the Color filter", text: "red" },
        { action: "select", target: "Sort", text: "price low to high" },
      ],
    },
    stops: ["done"],
    check: {
      expression:
        "document.getElementById('color').value + '|' + document.getElementById('sort').value",
      contains: ["red|price"],
    },
  },
  {
    name: "shop-search",
    page: "shop-mock",
    input: { steps: [{ action: "type", target: "the search box", text: "travel", submit: true }] },
    stops: ["done"],
    check: {
      expression:
        "document.getElementById('main').innerText.includes('Classic Mug') ? 'unfiltered' : document.getElementById('main').innerText",
      contains: ["Travel Mug"],
    },
  },
  {
    name: "shop-checkout-gate",
    page: "shop-mock",
    input: {
      steps: [
        { action: "click", target: "Add to cart for the Travel Mug" },
        { action: "click", target: "the cart link" },
        { action: "fill" },
        { action: "click", target: "Place order" },
      ],
      values: { name: "Ada Lovelace" },
    },
    stops: ["needs-approval"],
    check: { expression: "document.body.innerText", contains: ["Travel Mug $15.00"] },
  },
  {
    name: "spa",
    page: "spa-nav",
    input: {
      steps: [
        { action: "click", target: "Reports" },
        { action: "wait", text: "Q2 revenue" },
      ],
    },
    stops: ["done"],
    check: { expression: "document.body.innerText", contains: ["Q2 revenue"] },
  },
  {
    name: "infinite",
    page: "infinite",
    input: {
      steps: [
        { action: "scroll", direction: "down" },
        { action: "click", target: "Post 15" },
      ],
    },
    stops: ["done", "error"],
    check: { expression: "location.pathname", contains: ["/post/15"] },
  },
  {
    name: "cookies",
    page: "modal",
    input: { steps: [{ action: "click", target: "Reject in the cookie banner" }] },
    stops: ["done"],
    check: {
      expression: "String(!document.body.innerText.includes('Accept all'))",
      contains: ["true"],
    },
  },
  {
    name: "buy-gate",
    page: "chrome",
    input: { steps: [{ action: "click", target: "Buy one" }] },
    stops: ["needs-approval"],
    check: { expression: "document.body.innerText", contains: ["In stock: 3"] },
  },
  {
    name: "real:books-nav",
    page: BOOKS,
    input: {
      steps: [
        { action: "click", target: "the Mystery category link" },
        { action: "click", target: "the next page link" },
        { action: "click", target: "the first book in the list" },
      ],
    },
    stops: ["done"],
    check: {
      expression: "document.querySelector('h1')?.innerText ?? ''",
      contains: ["Mysterious Affair at Styles"],
    },
  },
  {
    name: "real:books-basket-gate",
    page: BOOKS,
    input: { steps: [{ action: "click", target: "Add to basket for Tipping the Velvet" }] },
    stops: ["needs-approval", "done"],
    check: { expression: "location.href", contains: ["books.toscrape.com"] },
  },
  {
    name: "real:hn-comments",
    page: "https://news.ycombinator.com/",
    input: { steps: [{ action: "click", target: "the comments link of the top story" }] },
    stops: ["done"],
    check: { expression: "location.href", contains: ["item?id="] },
  },
  {
    name: "real:wiki-search",
    page: "https://en.wikipedia.org/wiki/Iceland",
    input: {
      steps: [
        { action: "type", target: "the Wikipedia search box", text: "Reykjavik", submit: true },
      ],
    },
    stops: ["done"],
    check: { expression: "document.title", contains: ["Reykjav"] },
  },
  {
    name: "real:wiki-toc",
    page: "https://en.wikipedia.org/wiki/Iceland",
    input: { steps: [{ action: "click", target: "the Demographics section in the contents" }] },
    stops: ["done"],
    check: { expression: "location.hash", contains: ["Demographics"] },
  },
  {
    name: "real:pizza",
    page: "https://httpbin.org/forms/post",
    input: {
      steps: [{ action: "fill" }, { action: "click", target: "Submit order" }],
      values: {
        "customer name": "Ada Lovelace",
        telephone: "555-0100",
        email: "ada@example.com",
        "pizza size": "Medium",
        toppings: ["Bacon", "Extra Cheese"],
        "preferred delivery time": "19:30",
        "delivery instructions": "Ring twice",
      },
    },
    stops: ["needs-approval"],
    check: {
      expression: "new URLSearchParams(new FormData(document.querySelector('form'))).toString()",
      contains: [
        "custname=Ada+Lovelace",
        "size=medium",
        "topping=bacon",
        "topping=cheese",
        "delivery=19%3A30",
      ],
    },
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
let handedBack = 0;
let total = 0;
try {
  for (const scenario of scenarios.filter((s) => only.length === 0 || only.includes(s.name))) {
    for (let run = 1; run <= runs; run++) {
      site?.stop();
      site = startFixtureSite();
      const tab: Tab = await browser.activeTab(AbortSignal.timeout(10_000));
      try {
        await navigateTo(
          tab,
          scenario.page.startsWith("http") ? scenario.page : site.url(scenario.page),
          AbortSignal.timeout(30_000),
        );
      } catch (error) {
        console.log(
          `SKIP ${scenario.name} #${run}: could not open the page (${error instanceof Error ? error.message : error})`,
        );
        continue;
      }
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
          {
            jev,
            uploadRoots: [workspace],
            ...(args.includes("--trace")
              ? {
                  trace: (round, answers) => {
                    const brief = Object.entries(answers)
                      .filter(([id]) => !id.startsWith("risky:") && !id.startsWith("value:"))
                      .map(([id, answer]) =>
                        answer.type === "noul"
                          ? `${id}=${answer.noul.toFixed(2)}`
                          : answer.type === "choice"
                            ? `${id}=${answer.choice}(${(answer.probabilities[answer.choice] ?? 0).toFixed(2)})`
                            : id,
                      );
                    console.log(`    round ${round}: ${brief.join(" ")}`);
                  },
                }
              : {}),
          },
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
        // Stopping to hand the step back is slower but never wrong, unless something was submitted.
        const handback =
          !ok &&
          report.stop === "not-found" &&
          (scenario.submissions === undefined || site.submissions.length === scenario.submissions);
        if (ok) passed++;
        if (handback) handedBack++;
        const perCall = report.jev.calls ? Math.round(report.jev.ms / report.jev.calls) : 0;
        line = `${ok ? "PASS" : handback ? "HANDBACK" : "FAIL"} ${scenario.name} #${run}: ${report.stop} · ${wall.toFixed(1)} s · jev ${report.jev.calls} calls, ${Math.round(report.jev.ms)} ms (${perCall} ms/call), ${report.jev.inputTokens} tok${ok ? "" : ` · ${problems.join("; ")}`}`;
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
console.log(
  `\n${passed}/${total} passed, ${handedBack} handed back, ${total - passed - handedBack} failed`,
);
for (const row of rows) console.log(row);
