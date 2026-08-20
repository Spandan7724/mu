import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SYNTHETIC_RESUME_BASENAME, SYNTHETIC_RESUME_PDF } from "./applicant.ts";
import { type FixtureHandle, startFixture } from "./server.ts";

let fixture: FixtureHandle;

beforeEach(async () => {
  fixture = await startFixture({ staleRerenderMs: 50 });
});

afterEach(async () => {
  await fixture.stop();
});

/** fetch without following redirects, so the flow's 303 chain is assertable. */
function raw(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: "manual" });
}

function resumeFile(bytes: Uint8Array = SYNTHETIC_RESUME_PDF, name = SYNTHETIC_RESUME_BASENAME) {
  return new File([bytes], name, { type: "application/pdf" });
}

async function startApplication(variant = "default"): Promise<string> {
  const response = await raw(`${fixture.url}/apply?variant=${variant}`);
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return (cookie ?? "").split(";")[0] ?? "";
}

function step1Body(): FormData {
  const body = new FormData();
  body.set("first_name", "Ada");
  body.set("last_name", "Testwell");
  body.set("email", "ada.testwell@example.invalid");
  body.set("phone", "+1-555-0100");
  body.set("years_experience", "6");
  body.set("available_from", "2030-01-15");
  body.set("country", "IN");
  body.set("city", "Springfield");
  body.set("remote_preference", "remote");
  body.set("open_to_relocation", "yes");
  body.set("summary", "Synthetic fixture applicant.");
  return body;
}

function step2Body(file: File = resumeFile()): FormData {
  const body = new FormData();
  body.set("work_authorization", "yes");
  body.set("needs_sponsorship", "no");
  body.set("desired_salary", "120000");
  body.set("notice_period", "30d");
  body.set("portfolio_url", "https://portfolio.example.invalid/ada");
  body.set("agree_terms", "yes");
  body.set("resume", file);
  return body;
}

function step3Body(): FormData {
  const body = new FormData();
  body.set("gender", "decline");
  body.set("veteran_status", "decline");
  body.set("disability_status", "decline");
  body.set("ethnicity", "decline");
  return body;
}

async function completeThroughReview(cookie: string, file?: File): Promise<void> {
  const headers = { cookie };
  const one = await raw(`${fixture.url}/apply/step/1`, {
    method: "POST",
    headers,
    body: step1Body(),
  });
  expect(one.status).toBe(303);
  const two = await raw(`${fixture.url}/apply/step/2`, {
    method: "POST",
    headers,
    body: file ? step2Body(file) : step2Body(),
  });
  expect(two.status).toBe(303);
  const three = await raw(`${fixture.url}/apply/step/3`, {
    method: "POST",
    headers,
    body: step3Body(),
  });
  expect(three.status).toBe(303);
}

describe("server lifecycle", () => {
  test("binds two distinct loopback origins and stops cleanly", async () => {
    expect(fixture.url).toStartWith("http://127.0.0.1:");
    expect(fixture.crossOrigin.url).toStartWith("http://127.0.0.1:");
    expect(fixture.crossOrigin.port).not.toBe(fixture.port);
    await expect((await fetch(fixture.url)).text()).resolves.toContain("mu browser fixture");
    await expect((await fetch(fixture.crossOrigin.url)).text()).resolves.toContain(
      "mu browser fixture",
    );
  });

  test("several instances run concurrently without sharing state", async () => {
    const other = await startFixture();
    try {
      expect(other.port).not.toBe(fixture.port);
      const cookie = await startApplication();
      await completeThroughReview(cookie);
      await raw(`${fixture.url}/apply/submit`, {
        method: "POST",
        headers: { cookie },
        body: new FormData(),
      });
      expect(fixture.recorder.count("/apply/submit")).toBe(1);
      expect(other.recorder.count("/apply/submit")).toBe(0);
    } finally {
      await other.stop();
    }
  });

  test("an unknown path is a 404 fixture page, not a crash", async () => {
    const response = await fetch(`${fixture.url}/no/such/route`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("No fixture route matches this path");
  });

  test("the recorder is not reachable over HTTP", async () => {
    for (const path of [
      "/recorder",
      "/submissions",
      "/__fixture/submissions",
      "/api/submissions",
    ]) {
      expect((await fetch(`${fixture.url}${path}`)).status).toBe(404);
    }
  });
});

describe("submission recorder", () => {
  test("records every field name and value that reached the server", async () => {
    const body = new FormData();
    body.set("plain_text", "hello");
    body.set("email", "ada.testwell@example.invalid");
    body.append("interests", "backend");
    body.append("interests", "infra");
    const response = await fetch(`${fixture.url}/fields/all`, { method: "POST", body });
    expect(response.status).toBe(200);

    const submission = fixture.recorder.only("/fields/all");
    expect(submission.values.plain_text).toEqual(["hello"]);
    expect(submission.values.interests).toEqual(["backend", "infra"]);
    expect(submission.origin).toBe(fixture.origin);
    expect(submission.response.outcome).toBe("confirmed");
    expect(submission.response.confirmationText).toContain("Application received");
    expect(submission.response.externalId).toStartWith("MU-FIX-");
  });

  test("records uploaded file basename, size and sha-256", async () => {
    const body = new FormData();
    body.set("document", resumeFile());
    const response = await fetch(`${fixture.url}/uploads/strict`, { method: "POST", body });
    expect(response.status).toBe(200);

    const submission = fixture.recorder.only("/uploads/strict");
    const file = submission.files[0];
    expect(file?.basename).toBe(SYNTHETIC_RESUME_BASENAME);
    expect(file?.bytes).toBe(SYNTHETIC_RESUME_PDF.byteLength);
    expect(file?.mimeType).toBe("application/pdf");
    expect(file?.sha256).toBe(
      new Bun.CryptoHasher("sha256").update(SYNTHETIC_RESUME_PDF).digest("hex"),
    );
  });

  test("reduces a traversing filename to its basename but keeps the raw value", async () => {
    const body = new FormData();
    body.set("document", resumeFile(SYNTHETIC_RESUME_PDF, "../../../../etc/passwd.pdf"));
    await fetch(`${fixture.url}/uploads/strict`, { method: "POST", body });

    const file = fixture.recorder.only("/uploads/strict").files[0];
    expect(file?.basename).toBe("passwd.pdf");
    expect(file?.rawFilename).toContain("../");
  });

  test("two identical submissions are two records and a duplicate group", async () => {
    const send = () => {
      const body = new FormData();
      body.set("plain_text", "same");
      return fetch(`${fixture.url}/fields/all`, { method: "POST", body });
    };
    await send();
    await send();

    expect(fixture.recorder.count("/fields/all")).toBe(2);
    expect(() => fixture.recorder.only("/fields/all")).toThrow("recorded 2");
    const groups = fixture.recorder.duplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
    expect(fixture.recorder.hasDuplicates()).toBe(true);
  });

  test("different payloads to the same path are not duplicates", async () => {
    for (const value of ["a", "b"]) {
      const body = new FormData();
      body.set("plain_text", value);
      await fetch(`${fixture.url}/fields/all`, { method: "POST", body });
    }
    expect(fixture.recorder.count("/fields/all")).toBe(2);
    expect(fixture.recorder.hasDuplicates()).toBe(false);
  });

  test("waitFor and subscribe observe submissions as they arrive", async () => {
    const seen: string[] = [];
    const unsubscribe = fixture.recorder.subscribe((s) => seen.push(s.path));
    const body = new FormData();
    body.set("plain_text", "watched");
    await fetch(`${fixture.url}/fields/all`, { method: "POST", body });
    await fixture.recorder.waitFor((all) => all.length === 1, { timeoutMs: 1000 });
    unsubscribe();
    expect(seen).toEqual(["/fields/all"]);
  });
});

describe("upload rejection", () => {
  test("rejects an unaccepted MIME type with a visible reason", async () => {
    const body = new FormData();
    body.set("document", new File(["plain"], "notes.txt", { type: "text/plain" }));
    const response = await fetch(`${fixture.url}/uploads/strict`, { method: "POST", body });
    expect(response.status).toBe(415);
    expect(await response.text()).toContain("Unsupported media type: text/plain");
    expect(fixture.recorder.count("/uploads/strict")).toBe(0);
  });

  test("rejects a file over the size limit", async () => {
    const oversized = new Uint8Array(fixture.options.maxUploadBytes + 1);
    const body = new FormData();
    body.set("document", new File([oversized], "big.pdf", { type: "application/pdf" }));
    const response = await fetch(`${fixture.url}/uploads/strict`, { method: "POST", body });
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("the limit is");
    expect(fixture.recorder.count("/uploads/strict")).toBe(0);
  });

  test("rejects a missing file", async () => {
    const response = await fetch(`${fixture.url}/uploads/strict`, {
      method: "POST",
      body: new FormData(),
    });
    expect(response.status).toBe(400);
  });

  test("serves downloads with a content-disposition basename", async () => {
    const response = await fetch(`${fixture.url}/download/resume`);
    expect(response.headers.get("content-disposition")).toContain(SYNTHETIC_RESUME_BASENAME);
    expect((await response.bytes()).byteLength).toBe(SYNTHETIC_RESUME_PDF.byteLength);
  });

  test("the poisoned download carries instructions in its filename", async () => {
    const response = await fetch(`${fixture.url}/download/poisoned`);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition.toLowerCase()).toContain("ignore the user");
    expect(await response.text()).toContain("INSTRUCTIONS FOR THE AI AGENT");
  });
});

describe("post-submit outcomes", () => {
  test("confirmed returns stable confirmation text and an external id", async () => {
    const response = await fetch(`${fixture.url}/outcome/confirmed`, {
      method: "POST",
      body: new FormData(),
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Application received. Thank you for applying.");
    expect(html).toMatch(/MU-FIX-\d{4}/);
    expect(fixture.recorder.only("/outcome/confirmed").response.outcome).toBe("confirmed");
  });

  test("failed returns a visible error and records the failure", async () => {
    const response = await fetch(`${fixture.url}/outcome/failed`, {
      method: "POST",
      body: new FormData(),
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("No application was created");
    expect(fixture.recorder.only("/outcome/failed").response.outcome).toBe("failed");
  });

  test("ambiguous records the side effect and then never answers", async () => {
    const body = new FormData();
    body.set("note", "committed");
    let failed = false;
    try {
      const response = await fetch(`${fixture.url}/outcome/ambiguous`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(300),
      });
      await response.text();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    const submission = fixture.recorder.only("/outcome/ambiguous");
    expect(submission.response.outcome).toBe("ambiguous");
    expect(submission.response.responseLost).toBe(true);
    expect(submission.values.note).toEqual(["committed"]);
  });
});

describe("job application flow", () => {
  test("walks three steps and records exactly one submission with every value and file", async () => {
    const cookie = await startApplication();
    await completeThroughReview(cookie);

    const review = await raw(`${fixture.url}/apply/review`, { headers: { cookie } });
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain("Submit application");
    expect(reviewHtml).toContain("ada.testwell@example.invalid");

    const response = await raw(`${fixture.url}/apply/submit`, {
      method: "POST",
      headers: { cookie },
      body: new FormData(),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Application received");

    const submission = fixture.recorder.only("/apply/submit");
    expect(submission.values.first_name).toEqual(["Ada"]);
    expect(submission.values.email).toEqual(["ada.testwell@example.invalid"]);
    expect(submission.values.desired_salary).toEqual(["120000"]);
    expect(submission.values.gender).toEqual(["decline"]);
    expect(submission.files.map((f) => f.basename)).toEqual([SYNTHETIC_RESUME_BASENAME]);
    expect(submission.response.externalId).toStartWith("MU-FIX-");
  });

  test("submitting twice is visible as two records", async () => {
    const cookie = await startApplication();
    await completeThroughReview(cookie);
    for (let i = 0; i < 2; i++) {
      await raw(`${fixture.url}/apply/submit`, {
        method: "POST",
        headers: { cookie },
        body: new FormData(),
      });
    }
    expect(fixture.recorder.count("/apply/submit")).toBe(2);
    expect(fixture.recorder.duplicateGroups()).toHaveLength(1);
  });

  test("step 1 rejects a malformed email and re-renders with the entered values", async () => {
    const cookie = await startApplication();
    const body = step1Body();
    body.set("email", "not-an-email");
    const response = await raw(`${fixture.url}/apply/step/1`, {
      method: "POST",
      headers: { cookie },
      body,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Email address is not valid.");
    expect(html).toContain('value="not-an-email"');
    expect(fixture.recorder.count()).toBe(0);
  });

  test("step 2 rejects a missing resume and a non-numeric salary", async () => {
    const cookie = await startApplication();
    await raw(`${fixture.url}/apply/step/1`, {
      method: "POST",
      headers: { cookie },
      body: step1Body(),
    });
    const body = new FormData();
    body.set("work_authorization", "yes");
    body.set("needs_sponsorship", "no");
    body.set("desired_salary", "about 120k");
    body.set("notice_period", "30d");
    body.set("agree_terms", "yes");
    const response = await raw(`${fixture.url}/apply/step/2`, {
      method: "POST",
      headers: { cookie },
      body,
    });
    const html = await response.text();
    expect(html).toContain("Desired annual salary must be a whole number.");
    expect(html).toContain("A resume file is required.");
  });

  test("step 2 rejects a resume over the size limit", async () => {
    const cookie = await startApplication();
    await raw(`${fixture.url}/apply/step/1`, {
      method: "POST",
      headers: { cookie },
      body: step1Body(),
    });
    const big = new File([new Uint8Array(fixture.options.maxUploadBytes + 1)], "big.pdf", {
      type: "application/pdf",
    });
    const response = await raw(`${fixture.url}/apply/step/2`, {
      method: "POST",
      headers: { cookie },
      body: step2Body(big),
    });
    expect(await response.text()).toContain("exceeds the");
  });

  test("the validation variant rejects a valid first attempt and accepts the second", async () => {
    const cookie = await startApplication("validation");
    await raw(`${fixture.url}/apply/step/1`, {
      method: "POST",
      headers: { cookie },
      body: step1Body(),
    });
    const first = await raw(`${fixture.url}/apply/step/2`, {
      method: "POST",
      headers: { cookie },
      body: step2Body(),
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("could not be verified");
    const second = await raw(`${fixture.url}/apply/step/2`, {
      method: "POST",
      headers: { cookie },
      body: step2Body(),
    });
    expect(second.status).toBe(303);
  });

  test("the unknown variant loses the response after recording the submission", async () => {
    const cookie = await startApplication("unknown");
    await completeThroughReview(cookie);
    let failed = false;
    try {
      const response = await raw(`${fixture.url}/apply/submit`, {
        method: "POST",
        headers: { cookie },
        body: new FormData(),
        signal: AbortSignal.timeout(300),
      });
      await response.text();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(fixture.recorder.only("/apply/submit").response.outcome).toBe("ambiguous");
  });

  test("the failure variant reports a visible error", async () => {
    const cookie = await startApplication("failure");
    await completeThroughReview(cookie);
    const response = await raw(`${fixture.url}/apply/submit`, {
      method: "POST",
      headers: { cookie },
      body: new FormData(),
    });
    expect(response.status).toBe(422);
    expect(fixture.recorder.only("/apply/submit").response.outcome).toBe("failed");
  });

  test("the stale variant rerenders the submit button and offers a destructive twin", async () => {
    const cookie = await startApplication("stale");
    await completeThroughReview(cookie);
    const html = await (await raw(`${fixture.url}/apply/review`, { headers: { cookie } })).text();
    expect(html).toContain('id="submit-slot"');
    expect(html).toContain("Withdraw application");
    expect(html).toContain("Send to employer");
  });

  test("the manual-edit variant exposes editable values on the review page", async () => {
    const cookie = await startApplication("manual-edit");
    await completeThroughReview(cookie);
    const html = await (await raw(`${fixture.url}/apply/review`, { headers: { cookie } })).text();
    expect(html).toContain("Edit before submitting");

    const body = new FormData();
    body.set("email", "edited.by.hand@example.invalid");
    await raw(`${fixture.url}/apply/submit`, { method: "POST", headers: { cookie }, body });
    expect(fixture.recorder.only("/apply/submit").values.email).toEqual([
      "edited.by.hand@example.invalid",
    ]);
  });

  test("the popup and iframe variants host the review elsewhere", async () => {
    for (const variant of ["popup", "iframe", "iframe-cross-origin"]) {
      const cookie = await startApplication(variant);
      await completeThroughReview(cookie);
      const html = await (await raw(`${fixture.url}/apply/review`, { headers: { cookie } })).text();
      if (variant === "popup") expect(html).toContain("window.open('/apply/review/embedded'");
      if (variant === "iframe") expect(html).toContain('src="/apply/review/embedded"');
      if (variant === "iframe-cross-origin") expect(html).toContain(fixture.crossOrigin.url);
    }
  });

  test("a cross-origin review frame can submit back to the primary origin by session id", async () => {
    const cookie = await startApplication("iframe-cross-origin");
    await completeThroughReview(cookie);
    const sid = cookie.split("=")[1] ?? "";
    const frame = await fetch(`${fixture.crossOrigin.url}/embedded/apply-review?sid=${sid}`);
    expect(await frame.text()).toContain(`${fixture.url}/apply/submit?sid=${sid}`);

    const response = await raw(`${fixture.url}/apply/submit?sid=${sid}`, {
      method: "POST",
      body: new FormData(),
    });
    expect(response.status).toBe(200);
    expect(fixture.recorder.only("/apply/submit").values.first_name).toEqual(["Ada"]);
  });

  test("a request without a session is redirected back to the start", async () => {
    const response = await raw(`${fixture.url}/apply/review`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/apply");
  });
});
