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
import { taskAuthority } from "../policy/authority.ts";
import { autonomousSubmitGrant, type BrowserPermissionMode } from "../policy/modes.ts";
import { browserProfile } from "../profile/profile.ts";
import { verifyProvenance } from "../testing/provenance.ts";
import {
  type ApplyOptions,
  advance,
  commit,
  emptyLog,
  fillCurrentStep,
  openApplication,
  type ScenarioContext,
} from "./scenario.ts";

const LIVE = process.env.MU_BROWSER_LIVE === "1";

interface LiveFixture {
  url: string;
  recorder: {
    all(): readonly {
      path: string;
      fields: { name: string; value: string }[];
      files: { field: string; basename: string; sha256: string }[];
    }[];
  };
  stop(): Promise<void>;
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

    const profile = await browserProfile({
      home,
      connection: "persistent",
      browser: "chrome",
      documents: [resumePath],
      applicantProfile: applicantPath,
      allowedOrigins: [fixture.url],
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
        callTimeoutMs: 90_000,
      }),
    });
    const facts = profile.facts;
    if (facts === undefined) throw new Error("the applicant profile did not load");
    const authority = taskAuthority({ taskId: `acceptance-${mode}` });
    profile.session.setPolicy({
      ...profile.session.policy,
      mode,
      context: { taskId: `acceptance-${mode}` },
      ...(mode === "autonomous-submit"
        ? {
            grant: autonomousSubmitGrant([new URL(fixture.url).origin], authority),
            rules: [
              { permission: "browser:upload", pattern: "*", action: "allow" },
              // Personal disclosure remains a user decision even in autonomous mode;
              // this is the approval supplied by the deterministic acceptance caller.
              { permission: "browser:disclose", pattern: "*", action: "allow" },
            ],
          }
        : {
            // The deterministic caller supplies the approvals confirm mode asks for.
            rules: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
    });
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
      },
      home,
      shutdown: () => profile.runtime.shutdown(),
    };
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
          await openApplication(options);

          // A real form is a loop, not a fixed script: it re-renders the step it could
          // not accept, and nothing tells the caller in advance how many there are.
          const SUBMIT = "Submit application";
          const answers = {
            "Desired annual salary *": "185000",
            "I confirm the information above is accurate": "yes",
          };
          for (let step = 0; step < 8; step += 1) {
            const record = context.session.record();
            const atSubmit = record?.observation.elements.some(
              (entry) => entry.label === SUBMIT || entry.name === SUBMIT,
            );
            if (atSubmit === true) break;
            await fillCurrentStep({ ...options, answers, documentIds: context.documents.ids() });
            const nextLabel = ["Continue", "Review application"].find((label) =>
              context.session
                .record()
                ?.observation.elements.some(
                  (entry) => entry.label === label || entry.name === label,
                ),
            );
            if (nextLabel === undefined || (await advance(options, nextLabel)) === undefined) break;
          }

          const result = await commit(options, "Submit application");
          expect(result?.isError ?? true).toBe(false);

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

          const receiptStore = context.receipts?.store;
          if (receiptStore === undefined)
            throw new Error("the acceptance receipt store is missing");
          const receipts = await receiptStore.list("receipt");
          expect(receipts).toHaveLength(1);
          const receipt = await receiptStore.readReceipt(
            receipts[0]?.name.replace(/\.json$/, "") ?? "missing",
          );
          expect(receipt?.intent).toBe("submit-form");
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
          for (const step of log.steps) {
            const head = step.detail.split("\n")[0] ?? "";
            console.log(`[apply] ${step.ok ? "ok  " : "FAIL"} ${step.what} — ${head}`);
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
      }, 300_000);
  });
}
