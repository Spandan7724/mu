// B7's acceptance run: the motivating task, against a real browser and a real server.
//
// The evidence is the fixture's own record of what arrived, not the transcript. A page
// authors its own confirmation text, so believing it would let the thing under test
// grade its own work.
//
//   MU_BROWSER_LIVE=1 \
//   MU_BROWSER_MCP_CLI=<@playwright/mcp cli.js> \
//   MU_BROWSER_EXECUTABLE=<installed chrome-family browser> \
//   MU_BROWSER_LIVE_PROFILE=<a Mu-owned user-data dir> \
//   MU_BROWSER_LIVE_OUTPUT=<a Mu-owned output dir> \
//   bun test packages/profiles/browser/src/acceptance/apply.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApplicantPolicy } from "../contracts/applicant.ts";
import { createFactStore } from "../data/facts.ts";
import { policyFact, SAMPLE_TIME } from "../data/samples.ts";
import { mcpPersistentFactory } from "../drivers/mcp/modes.ts";
import { browserProfile } from "../profile/profile.ts";
import { verifyProvenance } from "../testing/provenance.ts";
import {
  type ApplyOptions,
  advance,
  clickControl,
  commit,
  emptyLog,
  fillCurrentStep,
  openApplication,
  type ScenarioContext,
  switchToPopup,
  waitForText,
} from "./scenario.ts";

const LIVE = process.env.MU_BROWSER_LIVE === "1";
type BrowserPermissionMode =
  | "read-only"
  | "confirm-submission"
  | "confirm-every-write"
  | "autonomous-submit";

interface LiveFixture {
  url: string;
  crossOrigin: { url: string };
  recorder: {
    all(): readonly RecordedFixtureSubmission[];
    only(path?: string): RecordedFixtureSubmission;
  };
  stop(): Promise<void>;
}

interface RecordedFixtureSubmission {
  path: string;
  fields: { name: string; value: string }[];
  files: { field: string; basename: string; sha256: string }[];
  response: { outcome: string; responseLost?: boolean };
}

async function startLiveFixture(): Promise<LiveFixture> {
  const specifier = new URL(
    "../../../../browser-fixture/src/index.ts",
    new URL(".", import.meta.url),
  ).href;
  const module = (await import(specifier)) as { startFixture: () => Promise<LiveFixture> };
  return module.startFixture();
}

// The resume the applicant actually has. Written to disk because a document is
// authorized by its bytes, and its hash is what proves the uploaded file is this one.
const RESUME = [
  "Ada Testwell",
  "ada.testwell@example.invalid",
  "+1-555-0100",
  "Springfield",
  "Senior Engineer, 2019 - present",
].join("\n");

// The saved answers, in the vocabulary `data/fields.ts` defines.
const PROFILE: Record<string, string> = {
  full_name: "Ada Testwell",
  first_name: "Ada",
  last_name: "Testwell",
  email: "ada.testwell@example.invalid",
  phone: "+1-555-0100",
  city: "Springfield",
  // The answer as a person gives it. A form's internal code ("IN") is not something a
  // profile holds, and the accessibility tree only ever exposes the visible label.
  country: "India",
  years_experience: "6",
  available_from: "2026-10-01",
  notice_period: "30 days",
  portfolio_url: "https://example.invalid/ada",
};

const POLICY_AUTH = policyFact("work_authorization", "yes", "fact-auth");
const POLICY_SPONSORSHIP = policyFact("sponsorship", "no", "fact-sponsorship");
const POLICY_RELOCATION = policyFact("relocation", "yes", "fact-relocation");
const POLICY: ApplicantPolicy = {
  workAuthorizationFactId: POLICY_AUTH.id,
  sponsorshipFactId: POLICY_SPONSORSHIP.id,
  relocationFactId: POLICY_RELOCATION.id,
  // BD-level requirement: a voluntary demographic question is never answered by
  // inference. Declining is a policy the user set, not a value Mu chose.
  defaultDemographicBehavior: "decline",
};

if (!LIVE) {
  describe("the job application acceptance run", () => {
    test("is skipped unless MU_BROWSER_LIVE=1 (CI never requires a browser)", () => {
      expect(LIVE).toBe(false);
    });
  });
} else {
  async function scenarioContext(
    fixture: LiveFixture,
    mode: BrowserPermissionMode,
    extraAllowedOrigins: readonly string[] = [],
    callTimeoutMs = 90_000,
  ): Promise<{
    context: ScenarioContext;
    home: string;
    shutdown: () => Promise<void>;
  }> {
    // Not /tmp: a snap-packaged browser has a private /tmp, so it cannot read a
    // document staged there when the form is finally submitted.
    const home = await mkdtemp(join(homedir(), ".mu-acceptance-"));
    const resumePath = join(home, "ada-testwell-resume.pdf");
    const applicantPath = join(home, "applicant.json");
    await writeFile(resumePath, RESUME, { mode: 0o600 });

    const saved = createFactStore({ policy: POLICY, now: () => SAMPLE_TIME });
    saved.adopt(POLICY_AUTH);
    saved.adopt(POLICY_SPONSORSHIP);
    saved.adopt(POLICY_RELOCATION);
    for (const [field, value] of Object.entries(PROFILE)) {
      saved.add({
        field,
        value,
        source: { kind: "user" },
        confidence: "exact",
        updatedAt: SAMPLE_TIME + 1,
      });
    }
    await writeFile(applicantPath, `${JSON.stringify(saved.profile(), null, 2)}\n`, {
      mode: 0o600,
    });

    const allowedOrigins = [fixture.url, ...extraAllowedOrigins];
    const profile = await browserProfile({
      home,
      browser: "chrome",
      documents: [resumePath],
      applicantProfile: applicantPath,
      allowedOrigins,
      factory: mcpPersistentFactory({
        home,
        // The public browser package owns the sidecar dependency. Resolve from the
        // same package location its shipped driverFactoryFor() uses.
        resolve: {
          resolveFrom: [new URL("../../../../browser-cli/src/drivers.ts", import.meta.url).href],
        },
        ...(process.env.MU_BROWSER_LIVE_OUTPUT === undefined
          ? {}
          : { outputDir: process.env.MU_BROWSER_LIVE_OUTPUT }),
        startupTimeoutMs: 60_000,
        callTimeoutMs,
      }),
    });
    const facts = profile.facts;
    if (facts === undefined) throw new Error("the applicant profile did not load");
    // This helper calls tools directly, so permission-mode behavior is tested at the
    // Agent boundary rather than simulated with a second browser-specific evaluator.
    void mode;
    return {
      context: {
        session: profile.session,
        facts,
        policy: facts.policy(),
        documents: profile.documents,
        receipts: {
          sessionId: `acceptance-${mode}`,
          store: profile.artifacts,
        },
        tools: {
          observe: profile.toolset.find((tool) => tool.name === "browser_observe") as NonNullable<
            ScenarioContext["tools"]
          >["observe"],
          navigate: profile.toolset.find((tool) => tool.name === "browser_navigate") as NonNullable<
            ScenarioContext["tools"]
          >["navigate"],
          act: profile.toolset.find((tool) => tool.name === "browser_act") as NonNullable<
            ScenarioContext["tools"]
          >["act"],
          tabs: profile.toolset.find((tool) => tool.name === "browser_tabs") as NonNullable<
            ScenarioContext["tools"]
          >["tabs"],
          upload: profile.toolset.find((tool) => tool.name === "browser_upload") as NonNullable<
            ScenarioContext["tools"]
          >["upload"],
          submit: profile.toolset.find((tool) => tool.name === "browser_submit") as NonNullable<
            ScenarioContext["tools"]
          >["submit"],
          wait: profile.toolset.find((tool) => tool.name === "browser_wait") as NonNullable<
            ScenarioContext["tools"]
          >["wait"],
          takeover: profile.toolset.find((tool) => tool.name === "browser_takeover") as NonNullable<
            ScenarioContext["tools"]
          >["takeover"],
        },
      },
      home,
      shutdown: () => profile.runtime.shutdown(),
    };
  }

  const ANSWERS = {
    "Desired annual salary *": "185000",
    "I confirm the information above is accurate": "yes",
  };

  async function driveApplication(options: ApplyOptions): Promise<void> {
    await openApplication(options);
    const SUBMIT = "Submit application";
    for (let step = 0; step < 10; step += 1) {
      const record = options.context.session.record();
      const has = (label: string) =>
        record?.observation.elements.some(
          (entry) => entry.label === label || entry.name === label,
        ) === true;
      if (has(SUBMIT)) return;
      if (has("Open review window")) {
        await clickControl(options, "Open review window");
        if ((await switchToPopup(options, "/apply/review/embedded")) === undefined) {
          throw new Error("the popup review tab did not become controllable");
        }
        continue;
      }

      await fillCurrentStep({
        ...options,
        answers: ANSWERS,
        documentIds: options.context.documents.ids(),
      });
      const nextLabel = ["Continue", "Review application"].find((label) =>
        options.context.session
          .record()
          ?.observation.elements.some((entry) => entry.label === label || entry.name === label),
      );
      if (nextLabel === undefined) break;
      await advance(options, nextLabel);
    }
  }

  async function receiptFor(context: ScenarioContext) {
    const receiptStore = context.receipts?.store;
    if (receiptStore === undefined) throw new Error("the acceptance receipt store is missing");
    const receipts = await receiptStore.list("receipt");
    const receipt = await receiptStore.readReceipt(
      receipts[0]?.name.replace(/\.json$/, "") ?? "missing",
    );
    return { receiptStore, receipts, receipt };
  }

  async function reportAndClose(
    log: ReturnType<typeof emptyLog>,
    shutdown: () => Promise<void>,
    fixture: LiveFixture,
    home: string,
  ): Promise<void> {
    for (const step of log.steps) {
      const head = step.detail.split("\n")[0] ?? "";
      console.log(`[apply] ${step.ok ? "ok  " : "FAIL"} ${step.what} — ${head}`);
      if (step.what.startsWith("submit via ")) {
        console.log(`[apply] submit evidence — ${step.detail.replace(/\n/g, " | ")}`);
      }
    }
    console.log(`[apply] unanswered: ${log.unanswered.join(", ") || "none"}`);
    for (const skipped of log.plans[0]?.skipped ?? []) {
      if (skipped.reason === "asked") continue;
      console.log(`[apply] skipped ${skipped.label}: ${skipped.reason} — ${skipped.detail}`);
    }
    await shutdown();
    await fixture.stop();
    await rm(home, { recursive: true, force: true });
  }

  async function variantRun(
    variant: string,
    options: {
      mode?: BrowserPermissionMode;
      allowCrossOrigin?: boolean;
      callTimeoutMs?: number;
    } = {},
  ) {
    const fixture = await startLiveFixture();
    const { context, home, shutdown } = await scenarioContext(
      fixture,
      options.mode ?? "confirm-submission",
      options.allowCrossOrigin === true ? [fixture.crossOrigin.url] : [],
      options.callTimeoutMs,
    );
    const log = emptyLog();
    const apply: ApplyOptions = {
      context,
      url: `${fixture.url}/apply?variant=${variant}`,
      signal: AbortSignal.timeout(240_000),
      log,
    };
    return { fixture, context, home, shutdown, log, apply };
  }

  describe("one job application, end to end", () => {
    for (const mode of ["confirm-submission", "autonomous-submit"] as const)
      test(`${mode}: the server receives exactly the grounded values, the authorized file, once`, async () => {
        const fixture = await startLiveFixture();
        const { context, home, shutdown } = await scenarioContext(fixture, mode);
        const log = emptyLog();
        const signal = AbortSignal.timeout(240_000);
        const options: ApplyOptions = {
          context,
          url: `${fixture.url}/apply`,
          signal,
          log,
        };

        try {
          await driveApplication(options);

          const result = await commit(options, "Submit application");
          expect(result?.isError ?? true).toBe(false);
          expect(result?.status).toBe("confirmed");

          const submissions = fixture.recorder
            .all()
            .filter((entry) => entry.path.includes("submit"));
          // BD18, and the single most important assertion in this file.
          expect(submissions).toHaveLength(1);

          const submitted = submissions[0];
          if (submitted === undefined) throw new Error("no submission was recorded");

          const report = verifyProvenance({
            submission: {
              path: submitted.path,
              fields: submitted.fields,
              files: submitted.files,
            },
            plan: log.plans,
            observation: log.observed,
            answers: [
              { field: "desired_salary", text: "185000" },
              { field: "notice_period", text: "30d" },
            ],
            documents: context.documents.entries(),
          });
          expect(report.problems).toEqual([]);

          // Only the authorized document, and only its bytes.
          expect(submitted.files.map((file) => file.basename)).toEqual(["ada-testwell-resume.pdf"]);
          const authorized = context.documents.entries()[0];
          expect(submitted.files[0]?.sha256).toBe(authorized?.sha256);

          const { receiptStore, receipts, receipt } = await receiptFor(context);
          expect(receipts).toHaveLength(1);
          expect(receiptStore).toBeDefined();
          expect(receipt?.intent).toBe("submit-form");
          expect(receipt?.status).toBe("confirmed");
          expect(receipt?.uploadedFiles.map((file) => file.documentId)).toEqual(
            context.documents.ids(),
          );

          // Nothing invented for a question the user never answered.
          const demographics = ["gender", "veteran_status", "disability_status", "ethnicity"];
          for (const field of demographics) {
            const values = submitted.fields
              .filter((entry) => entry.name === field)
              .map((entry) => entry.value);
            expect({ field, values }).toEqual({
              field,
              values: values.map((value) => (value === "decline" ? "decline" : "")),
            });
          }
        } finally {
          // A live acceptance run that reports only pass or fail cannot be diagnosed,
          // and it fails most usefully partway through.
          await reportAndClose(log, shutdown, fixture, home);
        }
      }, 300_000);
  });

  describe("application variants", () => {
    test("read-only research compares two sources across controlled tabs without a write", async () => {
      const run = await variantRun("default", { mode: "read-only" });
      try {
        await openApplication({ ...run.apply, url: `${run.fixture.url}/tasks/research` });
        await run.context.tools?.observe.execute("observe-comparison", {}, run.apply.signal);
        expect(run.context.session.record()?.observation.snapshot).toContain("USD 12");
        expect(run.context.session.record()?.observation.snapshot).toContain("USD 18");

        const sources = ["atlas", "beacon"];
        const snapshots: string[] = [];
        for (const source of sources) {
          const opened = await run.context.tools?.tabs.execute(
            `open-${source}`,
            { action: "open", url: `${run.fixture.url}/tasks/research/${source}` },
            run.apply.signal,
          );
          expect(opened?.isError).not.toBe(true);
          await run.context.tools?.observe.execute(`observe-${source}`, {}, run.apply.signal);
          snapshots.push(run.context.session.record()?.observation.snapshot ?? "");
        }
        expect(snapshots[0]).toContain("Four-hour response");
        expect(snapshots[1]).toContain("One-hour response");
        const listed = await run.context.tools?.tabs.execute(
          "list-research-tabs",
          { action: "list" },
          run.apply.signal,
        );
        const tabDetails = listed?.details as { tabs?: unknown[] } | undefined;
        expect(tabDetails?.tabs).toHaveLength(3);
        expect(run.fixture.recorder.all()).toEqual([]);
        expect(await run.context.receipts?.store.list("receipt")).toEqual([]);
      } finally {
        await reportAndClose(run.log, run.shutdown, run.fixture, run.home);
      }
    }, 300_000);

    test("scheduling and account settings use distinct explicit commitment intents", async () => {
      const run = await variantRun("default");
      try {
        const schedule = { ...run.apply, url: `${run.fixture.url}/tasks/schedule` };
        await openApplication(schedule);
        await fillCurrentStep({
          ...schedule,
          answers: {
            "Interview date *": "2026-10-15",
            "Time slot": "14:00 UTC",
            Note: "Synthetic fixture interview",
          },
        });
        expect((await commit(schedule, "Book interview"))?.status).toBe("confirmed");

        const account = { ...run.apply, url: `${run.fixture.url}/tasks/account` };
        await openApplication(account);
        await fillCurrentStep({
          ...account,
          answers: { "Time zone": "Asia/Kolkata", "Weekly digest": "yes" },
        });
        expect((await commit(account, "Update account", "account-change"))?.status).toBe(
          "confirmed",
        );

        expect(run.fixture.recorder.only("/tasks/schedule").fields).toEqual([
          { name: "interview_date", value: "2026-10-15" },
          { name: "time_slot", value: "14:00Z" },
          { name: "note", value: "Synthetic fixture interview" },
        ]);
        expect(run.fixture.recorder.only("/tasks/account").fields).toEqual([
          { name: "time_zone", value: "Asia/Kolkata" },
          { name: "weekly_digest", value: "yes" },
        ]);
        const receiptStore = run.context.receipts?.store;
        if (receiptStore === undefined) throw new Error("missing receipt store");
        const receipts = await receiptStore.list("receipt");
        expect(receipts).toHaveLength(2);
        const intents = await Promise.all(
          receipts.map(
            async (entry) =>
              (await receiptStore.readReceipt(entry.name.replace(/\.json$/, "")))?.intent,
          ),
        );
        expect(intents.sort()).toEqual(["account-change", "submit-form"]);
      } finally {
        await reportAndClose(run.log, run.shutdown, run.fixture, run.home);
      }
    }, 300_000);

    test("a real credential page forces takeover and resumes with fresh references", async () => {
      const run = await variantRun("default");
      run.apply.url = `${run.fixture.url}/auth/login`;
      try {
        await openApplication(run.apply);
        await run.context.tools?.observe.execute(
          "observe-login",
          { screenshot: "viewport" },
          run.apply.signal,
        );
        const before = run.context.session.record();
        const password = before?.observation.elements.find((entry) =>
          /\bPassword\b/.test(entry.label ?? entry.name ?? ""),
        );
        const username = before?.observation.elements.find((entry) =>
          /Email or username/.test(entry.label ?? entry.name ?? ""),
        );
        expect(password?.value).toBe("[redacted]");
        expect(password?.risk).toContain("password");
        expect(before?.observation.risks).toContain("password");
        expect(before?.observation.screenshot).toBeUndefined();
        if (username === undefined) throw new Error("the username control was not observed");
        const oldRef = {
          ref: username.ref,
          revision: username.revision,
          tabId: username.tabId,
        };

        const takeover = await run.context.tools?.takeover.execute(
          "takeover-password",
          {
            reason: "password",
            instructions: "Sign in directly in the browser, then resume.",
          },
          run.apply.signal,
        );
        expect(takeover?.terminate).toBe(true);
        expect(run.context.session.runtime.status().phase).toBe("takeover");
        expect(run.context.session.record()).toBeUndefined();

        const pausedAction = await run.context.tools?.act.execute(
          "act-during-takeover",
          { action: "fill", target: oldRef, value: "still-not-sent" },
          run.apply.signal,
        );
        expect(pausedAction?.isError).toBe(true);

        const resumed = await run.context.session.runtime.resume(run.apply.signal);
        run.context.session.resumeTakeover(resumed);
        const after = run.context.session.record();
        if (after === undefined) throw new Error("resume did not adopt the observation");
        expect(after.revision).toBeGreaterThan(before?.revision ?? -1);
        expect(run.context.session.resolve(oldRef, after).kind).toBe("stale");
        expect(
          after.observation.elements.find((entry) =>
            /\bPassword\b/.test(entry.label ?? entry.name ?? ""),
          )?.value,
        ).toBe("[redacted]");
        expect(run.fixture.recorder.all()).toEqual([]);
      } finally {
        await reportAndClose(run.log, run.shutdown, run.fixture, run.home);
      }
    }, 300_000);

    test("a delayed SPA route is waited for, grounded, and submitted once", async () => {
      const run = await variantRun("default");
      run.apply.url = `${run.fixture.url}/spa`;
      try {
        await openApplication(run.apply);
        await waitForText(run.apply, "Start");
        expect(await clickControl(run.apply, "Details")).toBeDefined();
        expect(await waitForText(run.apply, "Full name")).toBeDefined();
        await fillCurrentStep({ ...run.apply, answers: { Role: "Engineer" } });

        const result = await commit(run.apply, "Send", "send");
        expect(result?.status).toBe("confirmed");
        const submissions = run.fixture.recorder
          .all()
          .filter((entry) => entry.path === "/spa/submit");
        expect(submissions).toHaveLength(1);
        expect(submissions[0]?.fields).toEqual([
          { name: "full_name", value: "Ada Testwell" },
          { name: "role", value: "eng" },
        ]);
        const { receipts, receipt } = await receiptFor(run.context);
        expect(receipts).toHaveLength(1);
        expect(receipt?.status).toBe("confirmed");
        expect(receipt?.intent).toBe("send");
      } finally {
        await reportAndClose(run.log, run.shutdown, run.fixture, run.home);
      }
    }, 300_000);

    test("a server-side validation bounce is observed, refilled, and submitted once", async () => {
      const run = await variantRun("validation");
      try {
        await driveApplication(run.apply);
        const result = await commit(run.apply, "Submit application");
        expect(result?.status).toBe("confirmed");
        expect(
          run.log.steps.some(
            (step) =>
              step.what === "advance via Continue" &&
              step.detail.includes("validation did not accept this step"),
          ),
        ).toBe(true);
        expect(
          run.fixture.recorder.all().filter((entry) => entry.path === "/apply/submit"),
        ).toHaveLength(1);
      } finally {
        await reportAndClose(run.log, run.shutdown, run.fixture, run.home);
      }
    }, 300_000);

    test("a visible server failure is receipted as failed without being reported as success", async () => {
      const run = await variantRun("failure");
      try {
        await driveApplication(run.apply);
        const result = await commit(run.apply, "Submit application");
        expect(result?.status).toBe("failed");
        const submissions = run.fixture.recorder
          .all()
          .filter((entry) => entry.path === "/apply/submit");
        expect(submissions).toHaveLength(1);
        expect(submissions[0]?.response.outcome).toBe("failed");
        const { receipts, receipt } = await receiptFor(run.context);
        expect(receipts).toHaveLength(1);
        expect(receipt?.status).toBe("failed");
      } finally {
        await reportAndClose(run.log, run.shutdown, run.fixture, run.home);
      }
    }, 300_000);

    test("a lost response is unknown, receipted once, and never resubmitted", async () => {
      const run = await variantRun("unknown", { callTimeoutMs: 15_000 });
      try {
        await driveApplication(run.apply);
        const result = await commit(run.apply, "Submit application");
        expect(result?.status).toBe("unknown");
        const submissions = run.fixture.recorder
          .all()
          .filter((entry) => entry.path === "/apply/submit");
        expect(submissions).toHaveLength(1);
        expect(submissions[0]?.response).toMatchObject({
          outcome: "ambiguous",
          responseLost: true,
        });
        const { receipts, receipt } = await receiptFor(run.context);
        expect(receipts).toHaveLength(1);
        expect(receipt?.status).toBe("unknown");
        expect(result?.text).toContain("Do not repeat this");
        expect(
          run.fixture.recorder.all().filter((entry) => entry.path === "/apply/submit"),
        ).toHaveLength(1);
      } finally {
        await reportAndClose(run.log, run.shutdown, run.fixture, run.home);
      }
    }, 300_000);

    for (const variant of ["iframe", "iframe-cross-origin", "popup"] as const) {
      test(`${variant} review reaches the framed or popup submit control semantically`, async () => {
        const run = await variantRun(variant, {
          allowCrossOrigin: variant === "iframe-cross-origin",
        });
        try {
          await driveApplication(run.apply);
          const result = await commit(run.apply, "Submit application");
          expect(result?.status).toBe("confirmed");
          expect(
            run.fixture.recorder.all().filter((entry) => entry.path === "/apply/submit"),
          ).toHaveLength(1);
        } finally {
          await reportAndClose(run.log, run.shutdown, run.fixture, run.home);
        }
      }, 300_000);
    }

    test("a rerendered submit target cannot be retargeted to withdrawal", async () => {
      const run = await variantRun("stale");
      try {
        await driveApplication(run.apply);
        await new Promise((resolve) => setTimeout(resolve, 900));
        const result = await commit(run.apply, "Submit application");
        expect(result).toBeUndefined();
        expect(
          run.log.steps.some(
            (step) =>
              step.what === "submit via Submit application" &&
              step.ok === false &&
              step.detail.includes("no such control"),
          ),
        ).toBe(true);
        expect(
          run.fixture.recorder.all().filter((entry) => entry.path === "/apply/submit"),
        ).toEqual([]);
      } finally {
        await reportAndClose(run.log, run.shutdown, run.fixture, run.home);
      }
    }, 300_000);
  });
}
