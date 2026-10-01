import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { navigateTo } from "../actions/navigate.ts";
import { Stopwatch } from "../actions/types.ts";
import { BrowserManager } from "../browser/manager.ts";
import { resolveBrowserOptions } from "../config.ts";
import { capturePage } from "../page/snapshot.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";
import { minimalPdf } from "../testing/pdf.ts";
import { actTool } from "../tools/act.ts";
import { type ActInput, pageCandidates, runAct } from "./act.ts";
import type { JevAnswer, JevQuestion, JevResponse, JevUsage } from "./client.ts";

setDefaultTimeout(60_000);

interface Rules {
  // Which option a step's target description means.
  targets?: Record<string, RegExp>;
  // Which option a fill value named `item` belongs to.
  fields?: Record<string, RegExp>;
  blocked?: boolean;
  risky?: RegExp;
}

// Answers like a perfectly calibrated Jev would, from simple rules over the option
// descriptions, and records every question it was asked.
class ScriptedJev {
  readonly asked: string[] = [];
  constructor(private readonly rules: Rules) {}

  async ask(
    _state: unknown,
    questions: Record<string, JevQuestion>,
    _signal: AbortSignal,
    usage?: JevUsage,
  ): Promise<JevResponse> {
    if (usage) usage.calls++;
    const answers: Record<string, JevAnswer> = {};
    // Fields are matched on the element's own description, targets with its context.
    const pickFrom = (
      options: Record<string, unknown>,
      pattern: RegExp | undefined,
      own = false,
    ) => {
      const ref = Object.entries(options).find(
        ([key, text]) =>
          key !== "none" &&
          pattern?.test(own ? (String(text).split(" · ")[0] ?? "") : String(text)),
      )?.[0];
      const choice = ref ?? "none";
      return {
        type: "choice" as const,
        choice,
        probabilities: Object.fromEntries(
          Object.keys(options).map((key) => [
            key,
            key === choice ? 0.95 : 0.05 / Object.keys(options).length,
          ]),
        ),
        confidence: 0.9,
      };
    };
    for (const [id, question] of Object.entries(questions)) {
      this.asked.push(id);
      if (question.type === "choice" && id.startsWith("target")) {
        const target = (question.instructions as { target: string }).target;
        answers[id] = pickFrom(question.criteria, this.rules.targets?.[target]);
      } else if (question.type === "choice" && id.startsWith("field")) {
        const item = (question.instructions as { item: { name: string } }).item.name;
        answers[id] = pickFrom(question.criteria, this.rules.fields?.[item], true);
      } else if (question.type === "choice") {
        answers[id] = pickFrom(question.criteria, undefined);
      } else if (id === "blocked") {
        answers[id] = { type: "noul", noul: this.rules.blocked ? 0.95 : 0.02 };
      } else if (id === "error") {
        answers[id] = { type: "noul", noul: 0.03 };
      } else if (id.startsWith("risky")) {
        const control = String((question.instructions as { control: string }).control);
        answers[id] = { type: "noul", noul: this.rules.risky?.test(control) ? 0.9 : 0.05 };
      }
    }
    return { model: "scripted", answers, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

describeWithBrowser(
  "act runs the model's steps, with Jev only finding the elements they name",
  () => {
    const home = tempUserDataDir();
    const workspace = join(home, "work");
    let site: FixtureSite;
    let browser: BrowserManager;

    const wizardFields = {
      "full name": /Full name/,
      email: /Email/,
      "how did you hear about us": /hear about us/,
      "please specify": /Please specify/,
      "start month": /Start month/,
      "authorized to work": /authorized to work/,
      resume: /Resume/,
    };
    const values = {
      "full name": "Grace Hopper",
      email: "grace@example.com",
      "how did you hear about us": "Friend",
      "start month": "2026-11",
      "authorized to work": "Yes",
    };
    const wizardSteps: ActInput["steps"] = [
      { action: "fill" },
      { action: "click", target: "Next" },
      { action: "fill" },
      { action: "click", target: "Next" },
      { action: "click", target: "Submit application" },
    ];

    async function act(jev: ScriptedJev, input: ActInput) {
      const tab = await browser.activeTab(AbortSignal.timeout(10_000));
      return runAct(
        { tab, browser, stopwatch: new Stopwatch(), signal: AbortSignal.timeout(45_000) },
        input,
        { jev, uploadRoots: [workspace] },
      );
    }
    async function open(page: string) {
      const tab = await browser.activeTab(AbortSignal.timeout(10_000));
      await navigateTo(tab, site.url(page), AbortSignal.timeout(15_000));
      return tab;
    }
    const evaluate = async (expression: string) => {
      const tab = await browser.activeTab(AbortSignal.timeout(5_000));
      return (await tab.session.send("Runtime.evaluate", { expression, returnByValue: true }))
        .result.value;
    };

    beforeAll(() => {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "resume.pdf"), minimalPdf(["Grace Hopper", "Compilers"]));
      site = startFixtureSite();
      browser = new BrowserManager({
        connect: "managed",
        profileName: "act-test",
        userDataDir: join(home, "profile"),
        executable: testBrowserPath,
        headless: true,
        viewport: { width: 1280, height: 800 },
        keepOpen: false,
      });
    });
    afterAll(async () => {
      await browser.shutdown({ close: true });
      site.stop();
      rmSync(home, { recursive: true, force: true });
    });

    test("runs a multi-page form plan, carrying values to the page that asks for them, and stops before the final submit", async () => {
      await open("wizard");
      const report = await act(new ScriptedJev({ fields: wizardFields }), {
        steps: wizardSteps,
        values,
        files: { resume: ["resume.pdf"] },
      });
      expect(report.stop).toBe("needs-approval");
      expect(report.summary).toContain(
        'step 5 (click "Submit application") is button "Submit application"',
      );
      expect(report.extra).toContain("steps run (4 of 5");
      expect(report.extra).not.toContain("values not used");
      const review = String(await evaluate("document.getElementById('review').innerText"));
      expect(review).toContain("Name: Grace Hopper");
      expect(review).toContain("Start month: 2026-11");
      expect(review).toContain("Resume: resume.pdf");
      expect(site.submissions).toHaveLength(0);
    });

    test("one fill step with next fills every page of a form and stops before its final submit", async () => {
      await open("wizard");
      const report = await act(new ScriptedJev({ fields: wizardFields }), {
        steps: [
          { action: "fill", next: "Next" },
          { action: "click", target: "Submit application" },
        ],
        values,
        files: { resume: ["resume.pdf"] },
      });
      expect(report.stop).toBe("needs-approval");
      expect(report.summary).toContain('button "Submit application"');
      const review = String(await evaluate("document.getElementById('review').innerText"));
      expect(review).toContain("Name: Grace Hopper");
      expect(review).toContain("Resume: resume.pdf");
      expect(site.submissions).toHaveLength(0);
    });

    test("a description is matched by Jev with the element's context; a ref needs no Jev call at all", async () => {
      const tab = await open("shop-mock");
      const jev = new ScriptedJev({ targets: { "Add to cart for the blue mug": /Travel Mug/ } });
      const added = await act(jev, {
        steps: [{ action: "click", target: "Add to cart for the blue mug" }],
      });
      expect(added.stop).toBe("done");
      expect(await evaluate("document.getElementById('count').textContent")).toBe("1");
      expect(jev.asked.some((id) => id.startsWith("target"))).toBe(true);

      const model = await capturePage(tab, { scope: "full", signal: AbortSignal.timeout(5_000) });
      const cart = pageCandidates(model).clicks.find((c) => c.node.name.startsWith("Cart"));
      const quiet = new ScriptedJev({});
      const opened = await act(quiet, {
        steps: [{ action: "click", target: cart?.ref as string }],
      });
      expect(opened.stop).toBe("done");
      expect(quiet.asked).toEqual([]);
      expect(String(await evaluate("location.hash"))).toBe("#cart");
    });

    test("an element that cannot be found stops with the closest candidates", async () => {
      await open("shop-mock");
      const report = await act(new ScriptedJev({}), {
        steps: [{ action: "click", target: "the gift card banner" }],
      });
      expect(report.stop).toBe("not-found");
      expect(report.summary).toContain('step 1 (click "the gift card banner")');
    });

    test("a button Jev rates as consequential, an empty required field, and a sign-in wall all stop the run", async () => {
      await open("wizard");
      const risky = await act(new ScriptedJev({ fields: wizardFields, risky: /Next/ }), {
        steps: wizardSteps,
        values,
      });
      expect(risky.stop).toBe("needs-approval");
      expect(risky.summary).toContain("looks consequential");
      expect(await evaluate("document.querySelector('.step.active').id")).toBe("step1");

      await open("wizard");
      const missing = await act(new ScriptedJev({ fields: wizardFields }), {
        steps: wizardSteps,
        values: { ...values, "how did you hear about us": "Other" },
      });
      expect(missing.stop).toBe("needs-input");
      expect(missing.summary).toContain('textbox "Please specify *"');

      await open("wizard");
      const blocked = await act(new ScriptedJev({ fields: wizardFields, blocked: true }), {
        steps: wizardSteps,
        values,
      });
      expect(blocked.stop).toBe("blocked");
    });

    test("the tool asks to upload when given files, lists the steps in the approval, and refuses secrets", async () => {
      await open("wizard");
      const config = resolveBrowserOptions({ home, workspace, headless: true });
      const tool = actTool({ browser, config, vision: () => false }, new ScriptedJev({}) as never);
      const steps = wizardSteps;
      const files = { resume: ["resume.pdf"] };
      expect(await tool.permissionScope?.({ steps, values })).toBe("browser:interact");
      expect(await tool.permissionScope?.({ steps, values, files })).toBe("browser:upload");
      const details = await tool.permissionDetails?.({ steps, values, files });
      expect(details?.description).toStartWith("Upload files on");
      const lines = details?.preview?.kind === "text" ? details.preview.lines : [];
      expect(lines).toContain('  click "Next"');
      expect(lines).toContain('  full name = "Grace Hopper"');
      expect(lines.some((line) => line.startsWith("  resume: upload resume.pdf (PDF"))).toBe(true);
      const refused = await tool.execute(
        "a1",
        { steps, values: { email: "grace@example.com", password: "hunter22" } },
        AbortSignal.timeout(5_000),
      );
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).not.toContain("hunter22");
    });
  },
);
