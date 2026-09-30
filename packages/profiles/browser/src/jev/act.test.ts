import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { navigateTo } from "../actions/navigate.ts";
import { Stopwatch } from "../actions/types.ts";
import { BrowserManager } from "../browser/manager.ts";
import { resolveBrowserOptions } from "../config.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";
import { minimalPdf } from "../testing/pdf.ts";
import { actTool } from "../tools/act.ts";
import { type ActInput, runAct } from "./act.ts";
import type { JevAnswer, JevQuestion, JevResponse, JevUsage } from "./client.ts";

setDefaultTimeout(60_000);

interface Rules {
  // Which option description a value named `item` belongs to.
  fields: Record<string, RegExp>;
  next: (options: Record<string, string>, lastStep: string) => RegExp | undefined;
  done?: (content: string) => boolean;
  blocked?: boolean;
  risky?: RegExp;
}

// Answers like a perfectly calibrated Jev would, from simple rules over the
// option descriptions, and records every state it was shown.
class ScriptedJev {
  readonly states: unknown[] = [];
  constructor(private readonly rules: Rules) {}

  async ask(
    state: unknown,
    questions: Record<string, JevQuestion>,
    _signal: AbortSignal,
    usage?: JevUsage,
  ): Promise<JevResponse> {
    this.states.push(state);
    if (usage) usage.calls++;
    const { page, last_step: lastStep = "" } = state as {
      page: { content: string };
      last_step?: string;
    };
    const answers: Record<string, JevAnswer> = {};
    const pickFrom = (options: Record<string, unknown>, pattern: RegExp | undefined) => {
      const ref = Object.entries(options).find(
        ([key, text]) => key !== "none" && pattern?.test(String(text)),
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
      if (question.type === "choice" && id.startsWith("field")) {
        const item = (question.instructions as { item: { name: string } }).item.name;
        answers[id] = pickFrom(question.criteria, this.rules.fields[item]);
      } else if (question.type === "choice" && id.startsWith("next")) {
        answers[id] = pickFrom(
          question.criteria,
          this.rules.next(question.criteria as Record<string, string>, lastStep),
        );
      } else if (id === "done") {
        answers[id] = { type: "noul", noul: this.rules.done?.(page.content) ? 0.95 : 0.05 };
      } else if (id === "blocked") {
        answers[id] = { type: "noul", noul: this.rules.blocked ? 0.95 : 0.02 };
      } else if (id === "error") {
        answers[id] = { type: "noul", noul: /Please fill in/.test(page.content) ? 0.9 : 0.05 };
      } else if (id === "risky") {
        const control = String((state as { control: string }).control);
        answers[id] = { type: "noul", noul: this.rules.risky?.test(control) ? 0.9 : 0.05 };
      }
    }
    return { model: "scripted", answers, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

describeWithBrowser(
  "act drives a page with Jev's decisions and stops where the model must decide",
  () => {
    const home = tempUserDataDir();
    const workspace = join(home, "work");
    let site: FixtureSite;
    let browser: BrowserManager;

    const wizardRules = (overrides: Partial<Rules> = {}): Rules => ({
      fields: {
        "full name": /Full name/,
        email: /Email/,
        "how did you hear about us": /hear about us/,
        "please specify": /Please specify/,
        "start month": /Start month/,
        "authorized to work": /authorized to work/,
        resume: /Resume/,
      },
      next: (_options, lastStep) => (/covered by/.test(lastStep) ? /Accept/ : /"Next"|Submit/),
      ...overrides,
    });
    const values = {
      "full name": "Grace Hopper",
      email: "grace@example.com",
      "how did you hear about us": "Friend",
      "start month": "2026-11",
      "authorized to work": "Yes",
    };

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
    }

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

    test("fills and advances a multi-step wizard, uploads the resume, and stops before the final submit", async () => {
      await open("wizard");
      const jev = new ScriptedJev(wizardRules());
      const report = await act(jev, {
        goal: "the application is filled in up to its final submit",
        values,
        files: { resume: ["resume.pdf"] },
      });
      expect(report.summary).toContain(
        'act needs-approval: the next step is button "Submit application"',
      );
      expect(report.stop).toBe("needs-approval");
      expect(report.extra).toContain("full name");
      expect(report.extra).toContain("file resume");
      expect(report.extra).not.toContain("values not used");
      const tab = await browser.activeTab(AbortSignal.timeout(5_000));
      const review = await tab.session.send("Runtime.evaluate", {
        expression: "document.getElementById('review').innerText",
        returnByValue: true,
      });
      expect(review.result.value).toContain("Name: Grace Hopper");
      expect(review.result.value).toContain("Start month: 2026-11");
      expect(review.result.value).toContain("Resume: resume.pdf");
      expect(review.result.value).toContain("Authorized to work: yes");
      expect(site.submissions).toHaveLength(0);
      // Every decision saw the goal and values, never another field's secret.
      expect(JSON.stringify(jev.states[0])).toContain("Grace Hopper");
      expect(report.jev.calls).toBeGreaterThanOrEqual(4);
    });

    test("a required field revealed by an answer, with no value for it, hands back for input", async () => {
      await open("wizard");
      const report = await act(new ScriptedJev(wizardRules()), {
        goal: "the application is filled in up to its final submit",
        values: { ...values, "how did you hear about us": "Other" },
      });
      expect(report.stop).toBe("needs-input");
      expect(report.summary).toContain('textbox "Please specify *"');
    });

    test("a control Jev rates as consequential is not clicked, even when the classifier allows it", async () => {
      await open("wizard");
      const report = await act(new ScriptedJev(wizardRules({ risky: /Next/ })), {
        goal: "the application is filled in up to its final submit",
        values,
      });
      expect(report.stop).toBe("needs-approval");
      expect(report.summary).toContain('button "Next"');
      expect(report.summary).toContain("looks consequential");
      const tab = await browser.activeTab(AbortSignal.timeout(5_000));
      const step = await tab.session.send("Runtime.evaluate", {
        expression: "document.querySelector('.step.active').id",
        returnByValue: true,
      });
      expect(step.result.value).toBe("step1");
    });

    test("a sign-in wall stops at once, and a reached goal ends the run", async () => {
      await open("wizard");
      const blocked = await act(new ScriptedJev(wizardRules({ blocked: true })), {
        goal: "the application is filled in",
        values,
      });
      expect(blocked.stop).toBe("blocked");
      expect(blocked.jev.calls).toBe(1);

      await open("tabs-popups");
      const done = await act(
        new ScriptedJev({
          fields: {},
          next: () => /link ".*" .*→ \/form-basic/,
          done: (content) => /heading "Contact us"/.test(content),
        }),
        { goal: "the contact form is showing" },
      );
      expect(done.stop).toBe("done");
      expect(done.extra).toMatch(/1\. clicked link/);
    });

    test("the tool asks to upload when given files, lists values in the approval, and refuses secrets", async () => {
      await open("wizard");
      const config = resolveBrowserOptions({ home, workspace, headless: true });
      const tool = actTool(
        { browser, config, vision: () => false },
        new ScriptedJev(wizardRules()) as never,
      );
      const goal = "the application is filled in";
      const files = { resume: ["resume.pdf"] };
      expect(await tool.permissionScope?.({ goal, values })).toBe("browser:interact");
      expect(await tool.permissionScope?.({ goal, values, files })).toBe("browser:upload");
      const details = await tool.permissionDetails?.({ goal, values, files });
      expect(details?.description).toStartWith("Upload files on");
      const lines = details?.preview?.kind === "text" ? details.preview.lines : [];
      expect(lines).toContain('  full name = "Grace Hopper"');
      expect(lines.some((line) => line.startsWith("  resume: upload resume.pdf (PDF"))).toBe(true);
      const refused = await tool.execute(
        "a1",
        { goal, values: { email: "grace@example.com", password: "hunter22" } },
        AbortSignal.timeout(5_000),
      );
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).not.toContain("hunter22");
    });
  },
);
