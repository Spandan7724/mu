// How well element descriptions are grounded to the right element, on real sites and
// fixtures: code's exact match first, then Jev with and without option context.
// Usage: JEV_API_KEY=… bun scripts/bench-ground.ts [--runs N]
import { rmSync } from "node:fs";
import { navigateTo } from "../src/actions/navigate.ts";
import { BrowserManager } from "../src/browser/manager.ts";
import { jevFromEnv } from "../src/jev/client.ts";
import { exactMatch, ground, NONE } from "../src/jev/ground.ts";
import { type Candidate, pageCandidates } from "../src/jev/page.ts";
import { capturePage } from "../src/page/snapshot.ts";
import { tempUserDataDir, testBrowserPath } from "../src/testing/chrome.ts";
import { startFixtureSite } from "../src/testing/fixture-site.ts";

interface Case {
  page: string;
  kind: "click" | "type";
  target: string;
  expect: RegExp;
}

const BOOKS = "https://books.toscrape.com/";
const HN = "https://news.ycombinator.com/";
const WIKI = "https://en.wikipedia.org/wiki/Iceland";
const PIZZA = "https://httpbin.org/forms/post";
const cases: Case[] = [
  { page: BOOKS, kind: "click", target: "the Mystery category link", expect: /^link "Mystery"/ },
  { page: BOOKS, kind: "click", target: "Travel", expect: /^link "Travel"/ },
  { page: BOOKS, kind: "click", target: "the next page link", expect: /^link "next"/ },
  {
    page: BOOKS,
    kind: "click",
    target: "the Add to basket button for Tipping the Velvet",
    expect: /^button "Add to basket".*Tipping the Velvet/,
  },
  {
    page: BOOKS,
    kind: "click",
    target: "the first book in the list",
    expect: /a-light-in-the-attic/,
  },
  {
    page: HN,
    kind: "click",
    target: "the comments link of the top story",
    expect: /comments" .*row above: 1\./,
  },
  { page: HN, kind: "click", target: "the More link at the bottom", expect: /^link "More"/ },
  { page: HN, kind: "click", target: "login", expect: /^link "login"/ },
  { page: HN, kind: "type", target: "the search box", expect: /^textbox/ },
  { page: WIKI, kind: "type", target: "the Wikipedia search box", expect: /Search Wikipedia/i },
  { page: WIKI, kind: "click", target: 'the "Talk" tab', expect: /"Talk"/ },
  {
    page: WIKI,
    kind: "click",
    target: "the Demographics section in the contents",
    expect: /^link "Demographics"/,
  },
  { page: PIZZA, kind: "type", target: "the telephone field", expect: /Telephone/ },
  { page: PIZZA, kind: "click", target: "the Large pizza size", expect: /^radio "Large"/ },
  { page: PIZZA, kind: "click", target: "Submit order", expect: /^button "Submit order"/ },
  {
    page: "shop-mock",
    kind: "click",
    target: "Add to cart for the blue mug",
    expect: /Travel Mug/,
  },
  { page: "shop-mock", kind: "click", target: "the Tall Mug's add button", expect: /Tall Mug/ },
  { page: "wizard", kind: "click", target: "Next", expect: /^button "Next"/ },
];

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1] || 1) || 1;
const jev = jevFromEnv();
if (!jev) {
  console.error("Set JEV_API_KEY (or TYPESAFE_API_KEY).");
  process.exit(1);
}
const home = tempUserDataDir();
const site = startFixtureSite();
const browser = new BrowserManager({
  connect: "managed",
  profileName: "bench-ground",
  userDataDir: home,
  executable: testBrowserPath,
  headless: true,
  viewport: { width: 1280, height: 800 },
  keepOpen: false,
});
type Arm = "context" | "bare" | "context+page";
const score: Record<Arm | "code", { right: number; wrong: number; none: number; ms: number }> = {
  code: { right: 0, wrong: 0, none: 0, ms: 0 },
  context: { right: 0, wrong: 0, none: 0, ms: 0 },
  bare: { right: 0, wrong: 0, none: 0, ms: 0 },
  "context+page": { right: 0, wrong: 0, none: 0, ms: 0 },
};
try {
  const tab = await browser.activeTab(AbortSignal.timeout(10_000));
  let current = "";
  for (const item of cases) {
    if (item.page !== current) {
      current = item.page;
      try {
        await navigateTo(
          tab,
          item.page.startsWith("http") ? item.page : site.url(item.page),
          AbortSignal.timeout(30_000),
        );
      } catch (error) {
        console.log(`skipped ${item.page}: ${error instanceof Error ? error.message : error}`);
        current = `failed:${item.page}`;
      }
    }
    if (current.startsWith("failed:")) continue;
    const model = await capturePage(tab, { scope: "full", signal: AbortSignal.timeout(10_000) });
    const pages = {
      context: pageCandidates(model),
      bare: pageCandidates(model, { context: false }),
    };
    const of = (page: typeof pages.context): Candidate[] =>
      item.kind === "click" ? page.clicks : page.typing;
    const truth = (ref: string) =>
      item.expect.test(of(pages.context).find((candidate) => candidate.ref === ref)?.line ?? "");
    const code = exactMatch(item.target, of(pages.context));
    const tally = (arm: Arm | "code", ref: string | undefined, ms = 0) => {
      const entry = score[arm];
      entry.ms += ms;
      if (!ref || ref === NONE) entry.none++;
      else if (truth(ref)) entry.right++;
      else entry.wrong++;
    };
    tally("code", code?.ref);
    const results: string[] = [`code=${code ? (truth(code.ref) ? "✓" : "✗") : "-"}`];
    for (let run = 0; run < runs; run++) {
      for (const arm of ["context", "bare", "context+page"] as Arm[]) {
        const candidates = of(arm === "bare" ? pages.bare : pages.context);
        const started = performance.now();
        const { grounded } = await ground(
          jev,
          item.target,
          item.kind,
          candidates,
          { title: model.title, url: model.url },
          AbortSignal.timeout(30_000),
          {
            jevOnly: true,
            ...(arm === "context+page" ? { content: pages.context.text } : {}),
          },
        );
        const ms = performance.now() - started;
        const ref = grounded.ref;
        const p = grounded.probability;
        tally(arm, ref, ms);
        results.push(
          `${arm}=${!ref || ref === NONE ? "-" : truth(ref) ? "✓" : "✗"}${p.toFixed(2)}(${Math.round(ms)}ms)`,
        );
      }
    }
    console.log(
      `${item.kind} ${JSON.stringify(item.target)} [${of(pages.context).length}] ${results.join(" ")}`,
    );
  }
} finally {
  await browser.shutdown({ close: true });
  site.stop();
  rmSync(home, { recursive: true, force: true });
}
console.log("");
for (const [arm, entry] of Object.entries(score)) {
  const total = entry.right + entry.wrong + entry.none;
  const asked = arm === "code" ? 1 : total;
  console.log(
    `${arm.padEnd(13)} right ${entry.right}/${total}, wrong ${entry.wrong}, none ${entry.none}${arm === "code" ? "" : `, ${Math.round(entry.ms / asked)} ms/question`}`,
  );
}
