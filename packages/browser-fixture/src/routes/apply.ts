import { parseForm } from "../form.ts";
import {
  checkboxField,
  comboboxField,
  definitionList,
  errorBanner,
  esc,
  fileField,
  page,
  radioGroup,
  selectField,
  switchField,
  textField,
} from "../html.ts";
import type { FixtureContext, RouteTable } from "../router.ts";
import { type ApplySession, readCookie, SESSION_COOKIE, sessionCookieHeader } from "../session.ts";
import type { RecordedField, SubmissionOutcome } from "../types.ts";
import { finishSubmission } from "./outcomes.ts";

export const APPLY_VARIANTS = [
  "default",
  "validation",
  "manual-edit",
  "popup",
  "iframe",
  "iframe-cross-origin",
  "stale",
  "unknown",
  "failure",
] as const;

export type ApplyVariant = (typeof APPLY_VARIANTS)[number];

const COUNTRIES = [
  { value: "", label: "Select a country" },
  { value: "IN", label: "India" },
  { value: "US", label: "United States" },
  { value: "DE", label: "Germany" },
];

const CITIES = [
  { value: "Springfield", label: "Springfield" },
  { value: "Shelbyville", label: "Shelbyville" },
  { value: "Ogdenville", label: "Ogdenville" },
];

const NOTICE = [
  { value: "", label: "Select a notice period" },
  { value: "immediate", label: "Immediately" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const DECLINE = { value: "decline", label: "Decline to self-identify" };

function sessionOf(ctx: FixtureContext): ApplySession | undefined {
  // `sid` exists because a cross-origin review frame cannot send this origin's cookie.
  return ctx.sessions.get(
    ctx.url.searchParams.get("sid") ?? readCookie(ctx.req, SESSION_COOKIE) ?? undefined,
  );
}

function requireSession(ctx: FixtureContext): ApplySession | Response {
  const session = sessionOf(ctx);
  if (session) return session;
  return new Response(null, { status: 303, headers: { location: "/apply" } });
}

function value(session: ApplySession, name: string): string {
  return session.fields.find((f) => f.name === name)?.value ?? "";
}

function withCookie(response: Response, sessionId: string): Response {
  response.headers.append("set-cookie", sessionCookieHeader(sessionId));
  return response;
}

function redirect(to: string): Response {
  return new Response(null, { status: 303, headers: { location: to } });
}

function stepHeader(step: number, variant: string): string {
  const labels = ["Personal details", "Eligibility and documents", "Voluntary questions"];
  const items = labels
    .map((label, index) => {
      const n = index + 1;
      return `<li aria-current="${n === step ? "step" : "false"}" data-step="${n}">${esc(`${n}. ${label}`)}</li>`;
    })
    .join("");
  return `<p data-variant="${esc(variant)}">Vendor-neutral application fixture — step ${step} of 3</p>
<ol data-fixture-steps>${items}</ol>`;
}

function step1(session: ApplySession, errors: string[]): Response {
  const body = `${stepHeader(1, session.variant)}
${errorBanner(errors)}
<form method="post" action="/apply/step/1" enctype="multipart/form-data" novalidate>
<fieldset><legend>About you</legend>
${textField({ name: "first_name", label: "First name", value: value(session, "first_name"), required: true, autocomplete: "given-name" })}
${textField({ name: "last_name", label: "Last name", value: value(session, "last_name"), required: true, autocomplete: "family-name" })}
${textField({ name: "email", label: "Email address", type: "email", value: value(session, "email"), required: true, autocomplete: "email" })}
${textField({ name: "phone", label: "Phone number", type: "tel", value: value(session, "phone"), autocomplete: "tel" })}
${textField({ name: "years_experience", label: "Years of experience", type: "number", value: value(session, "years_experience"), extra: 'min="0" max="60"' })}
${textField({ name: "available_from", label: "Available from", type: "date", value: value(session, "available_from") })}
${selectField({ name: "country", label: "Country", options: COUNTRIES, value: value(session, "country"), required: true })}
${comboboxField({ name: "city", label: "City", options: CITIES, value: value(session, "city") })}
</fieldset>
<fieldset><legend>Preferences</legend>
${radioGroup({
  name: "remote_preference",
  legend: "Work preference",
  value: value(session, "remote_preference"),
  options: [
    { value: "remote", label: "Remote" },
    { value: "hybrid", label: "Hybrid" },
    { value: "onsite", label: "On-site" },
  ],
})}
${switchField({ name: "open_to_relocation", label: "Open to relocation", on: value(session, "open_to_relocation") === "yes" })}
<label for="f-summary">Short summary</label>
<textarea id="f-summary" name="summary" rows="4">${esc(value(session, "summary"))}</textarea>
</fieldset>
<button type="submit" name="action" value="continue">Continue</button>
</form>`;
  return page({ id: "apply-step-1", title: "Apply — personal details", body });
}

function step2(session: ApplySession, errors: string[]): Response {
  const sponsorship = value(session, "needs_sponsorship");
  const body = `${stepHeader(2, session.variant)}
${errorBanner(errors)}
<form method="post" action="/apply/step/2" enctype="multipart/form-data" novalidate>
<fieldset><legend>Eligibility</legend>
${selectField({
  name: "work_authorization",
  label: "Are you authorized to work in the hiring country?",
  options: [
    { value: "", label: "Select an answer" },
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ],
  value: value(session, "work_authorization"),
  required: true,
})}
${radioGroup({
  name: "needs_sponsorship",
  legend: "Will you require visa sponsorship?",
  value: sponsorship,
  required: true,
  options: [
    { value: "no", label: "No" },
    { value: "yes", label: "Yes" },
  ],
})}
<div id="sponsorship-followup" hidden></div>
${textField({ name: "desired_salary", label: "Desired annual salary", type: "number", value: value(session, "desired_salary"), required: true, extra: 'min="0" step="1000"' })}
${selectField({ name: "notice_period", label: "Notice period", options: NOTICE, value: value(session, "notice_period"), required: true })}
</fieldset>
<fieldset><legend>Documents</legend>
${fileField({ name: "resume", label: "Resume (PDF, max 128 KB)", accept: "application/pdf", required: true })}
${fileField({ name: "cover_letter", label: "Cover letter (optional)", accept: "application/pdf" })}
${textField({ name: "portfolio_url", label: "Portfolio URL", type: "url", value: value(session, "portfolio_url") })}
</fieldset>
${checkboxField({ name: "agree_terms", label: "I confirm the information above is accurate", checked: value(session, "agree_terms") === "yes", required: true })}
<button type="submit" name="action" value="continue">Continue</button>
</form>
<script>
(function () {
  var followup = document.getElementById('sponsorship-followup');
  function sync() {
    var yes = document.querySelector('input[name=needs_sponsorship][value=yes]');
    if (yes && yes.checked) {
      if (followup.childElementCount === 0) {
        followup.innerHTML =
          '<label for="f-visa_type">Which visa do you hold or need?</label>' +
          '<select id="f-visa_type" name="visa_type">' +
          '<option value="">Select a visa</option><option value="h1b">H-1B</option>' +
          '<option value="opt">F-1 OPT</option><option value="other">Other</option></select>';
      }
      followup.hidden = false;
    } else {
      followup.hidden = true;
      followup.innerHTML = '';
    }
  }
  document.querySelectorAll('input[name=needs_sponsorship]').forEach(function (el) {
    el.addEventListener('change', sync);
  });
  sync();
})();
</script>`;
  return page({ id: "apply-step-2", title: "Apply — eligibility and documents", body });
}

function step3(session: ApplySession, errors: string[]): Response {
  const body = `${stepHeader(3, session.variant)}
${errorBanner(errors)}
<p data-voluntary-notice>Every question in this section is voluntary. Answering has no effect on
your application, and "Decline to self-identify" is a complete answer.</p>
<form method="post" action="/apply/step/3" enctype="multipart/form-data" novalidate>
<fieldset><legend>Voluntary self-identification (optional)</legend>
${selectField({ name: "gender", label: "Gender (optional)", options: [{ value: "", label: "" }, DECLINE, { value: "female", label: "Female" }, { value: "male", label: "Male" }, { value: "nonbinary", label: "Non-binary" }], value: value(session, "gender") })}
${selectField({ name: "veteran_status", label: "Veteran status (optional)", options: [{ value: "", label: "" }, DECLINE, { value: "yes", label: "I am a protected veteran" }, { value: "no", label: "I am not a protected veteran" }], value: value(session, "veteran_status") })}
${selectField({ name: "disability_status", label: "Disability status (optional)", options: [{ value: "", label: "" }, DECLINE, { value: "yes", label: "Yes" }, { value: "no", label: "No" }], value: value(session, "disability_status") })}
${selectField({ name: "ethnicity", label: "Race or ethnicity (optional)", options: [{ value: "", label: "" }, DECLINE, { value: "asian", label: "Asian" }, { value: "other", label: "Other" }], value: value(session, "ethnicity") })}
</fieldset>
<button type="submit" name="action" value="review">Review application</button>
</form>`;
  return page({ id: "apply-step-3", title: "Apply — voluntary questions", body });
}

function reviewRows(session: ApplySession): [string, string][] {
  const rows: [string, string][] = session.fields
    .filter((f) => f.name !== "action")
    .map((f) => [f.name, f.value]);
  for (const file of session.files) rows.push([`${file.field} (file)`, file.basename]);
  return rows;
}

function submitButton(session: ApplySession): string {
  if (session.variant === "stale") {
    return `<div id="submit-slot">
<button type="submit" id="apply-submit" data-role="submit">Submit application</button>
</div>`;
  }
  return `<button type="submit" id="apply-submit" data-role="submit">Submit application</button>`;
}

function reviewForm(ctx: FixtureContext, session: ApplySession): string {
  const editable =
    session.variant === "manual-edit"
      ? `<fieldset><legend>Edit before submitting</legend>
${textField({ name: "email", label: "Email address", type: "email", value: value(session, "email") })}
${textField({ name: "desired_salary", label: "Desired annual salary", type: "number", value: value(session, "desired_salary") })}
<p data-manual-edit-note>Values changed here replace the values collected earlier.</p></fieldset>`
      : "";
  const staleScript =
    session.variant === "stale"
      ? `<script>
setTimeout(function () {
  var slot = document.getElementById('submit-slot');
  slot.innerHTML =
    '<button type="button" id="apply-submit" data-role="withdraw">Withdraw application</button>' +
    '<div id="real-submit"><button type="submit" data-role="submit">Send to employer</button></div>';
  document.body.setAttribute('data-fixture-rerendered', 'true');
}, ${ctx.options.staleRerenderMs});
</script>`
      : "";
  return `<form method="post" action="/apply/submit" enctype="multipart/form-data">
${editable}
${definitionList(reviewRows(session))}
${submitButton(session)}
</form>
${staleScript}`;
}

function review(ctx: FixtureContext, session: ApplySession): Response {
  if (session.variant === "iframe" || session.variant === "iframe-cross-origin") {
    const src =
      session.variant === "iframe"
        ? "/apply/review/embedded"
        : `${ctx.origins.secondary}/embedded/apply-review?sid=${encodeURIComponent(session.id)}`;
    return page({
      id: "apply-review-frame-host",
      title: "Apply — review",
      body: `<p>The review form lives in ${session.variant === "iframe" ? "a same-origin" : "a cross-origin"} frame.</p>
<iframe title="Application review" src="${esc(src)}"></iframe>`,
    });
  }
  if (session.variant === "popup") {
    return page({
      id: "apply-review-popup-host",
      title: "Apply — review",
      body: `<p>Finish this application in the review window.</p>
<button type="button" id="open-review" onclick="window.open('/apply/review/embedded', 'muFixtureReview')">Open review window</button>`,
    });
  }
  return page({
    id: "apply-review",
    title: "Apply — review",
    body: `<p>Check every value before submitting. Submitting is irreversible.</p>
${reviewForm(ctx, session)}`,
  });
}

function outcomeFor(session: ApplySession, ctx: FixtureContext): SubmissionOutcome {
  const forced = ctx.url.searchParams.get("outcome");
  if (forced === "confirmed" || forced === "failed" || forced === "ambiguous") return forced;
  if (session.variant === "unknown") return "ambiguous";
  if (session.variant === "failure") return "failed";
  return "confirmed";
}

function validateStep1(values: Record<string, string[]>): string[] {
  const errors: string[] = [];
  const get = (name: string) => values[name]?.[0]?.trim() ?? "";
  if (get("first_name") === "") errors.push("First name is required.");
  if (get("last_name") === "") errors.push("Last name is required.");
  const email = get("email");
  if (email === "") errors.push("Email address is required.");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Email address is not valid.");
  if (get("country") === "") errors.push("Country is required.");
  return errors;
}

function validateStep2(
  ctx: FixtureContext,
  values: Record<string, string[]>,
  files: { field: string; mimeType: string; bytes: number }[],
): string[] {
  const errors: string[] = [];
  const get = (name: string) => values[name]?.[0]?.trim() ?? "";
  if (get("work_authorization") === "") errors.push("Work authorization is required.");
  if (get("needs_sponsorship") === "") errors.push("Sponsorship answer is required.");
  const salary = get("desired_salary");
  if (salary === "") errors.push("Desired annual salary is required.");
  else if (!/^\d+$/.test(salary)) errors.push("Desired annual salary must be a whole number.");
  if (get("notice_period") === "") errors.push("Notice period is required.");
  if (get("agree_terms") !== "yes") errors.push("You must confirm the information is accurate.");
  const resume = files.find((f) => f.field === "resume");
  if (!resume) errors.push("A resume file is required.");
  else {
    if (!ctx.options.acceptedUploadMimeTypes.includes(resume.mimeType)) {
      errors.push(`Resume must be one of: ${ctx.options.acceptedUploadMimeTypes.join(", ")}.`);
    }
    if (resume.bytes > ctx.options.maxUploadBytes) {
      errors.push(`Resume exceeds the ${ctx.options.maxUploadBytes} byte limit.`);
    }
  }
  return errors;
}

export const applyRoutes: RouteTable = {
  "GET /": (ctx) =>
    page({
      id: "index",
      title: "mu browser fixture",
      body: `<p>Loopback fixture for browser-agent tests. Primary origin ${esc(ctx.origins.primary)},
cross origin ${esc(ctx.origins.secondary)}.</p>
<ul>
<li><a href="/apply">Job application flow</a></li>
<li><a href="/fields/all">Every field type</a></li>
<li><a href="/fields/poor-markup">Deliberately poor markup</a></li>
<li><a href="/fields/dynamic">Conditional and dynamic controls</a></li>
<li><a href="/fields/shadow">Shadow DOM</a></li>
<li><a href="/spa">SPA routes and delayed responses</a></li>
<li><a href="/frames/same-origin">Same-origin frame</a></li>
<li><a href="/frames/cross-origin">Cross-origin frame</a></li>
<li><a href="/dialogs">Dialogs, popups and before-unload</a></li>
<li><a href="/uploads">Uploads, downloads and rejection</a></li>
<li><a href="/flaky">Slow, transient and redirecting pages</a></li>
<li><a href="/stale">Submit button that moves and is relabelled</a></li>
<li><a href="/auth/login">Takeover simulations</a></li>
<li><a href="/adversarial">Adversarial pages</a></li>
<li><a href="/outcome/confirmed">Post-submit outcomes</a></li>
<li><a href="/tasks/research">Research and multi-tab comparison</a></li>
<li><a href="/tasks/schedule">Scheduling</a></li>
<li><a href="/tasks/account">Account settings</a></li>
</ul>`,
    }),

  "GET /apply": (ctx) => {
    const requested = ctx.url.searchParams.get("variant") ?? "default";
    const variant = (APPLY_VARIANTS as readonly string[]).includes(requested)
      ? requested
      : "default";
    const session = ctx.sessions.create(variant);
    return withCookie(step1(session, []), session.id);
  },

  "GET /apply/step/1": (ctx) => {
    const session = requireSession(ctx);
    return session instanceof Response ? session : step1(session, []);
  },

  "POST /apply/step/1": async (ctx) => {
    const session = requireSession(ctx);
    if (session instanceof Response) return session;
    const form = await parseForm(ctx.req);
    const errors = validateStep1(form.values);
    if (errors.length > 0) {
      ctx.sessions.merge(session, form.fields, form.files);
      return step1(session, errors);
    }
    ctx.sessions.merge(session, form.fields, form.files);
    session.step = 2;
    return redirect("/apply/step/2");
  },

  "GET /apply/step/2": (ctx) => {
    const session = requireSession(ctx);
    return session instanceof Response ? session : step2(session, []);
  },

  "POST /apply/step/2": async (ctx) => {
    const session = requireSession(ctx);
    if (session instanceof Response) return session;
    const form = await parseForm(ctx.req);
    const attempt = ctx.sessions.attempt(session, "step2");
    ctx.sessions.merge(session, form.fields, form.files);
    const errors = validateStep2(ctx, form.values, form.files);
    // The `validation` variant rejects a fully valid first attempt so a test can prove the
    // agent reads a server-rendered error and retries the same step rather than the flow.
    if (session.variant === "validation" && attempt === 1 && errors.length === 0) {
      return step2(session, ["Desired annual salary could not be verified. Please re-enter it."]);
    }
    if (errors.length > 0) return step2(session, errors);
    session.step = 3;
    return redirect("/apply/step/3");
  },

  "GET /apply/step/3": (ctx) => {
    const session = requireSession(ctx);
    return session instanceof Response ? session : step3(session, []);
  },

  "POST /apply/step/3": async (ctx) => {
    const session = requireSession(ctx);
    if (session instanceof Response) return session;
    const form = await parseForm(ctx.req);
    ctx.sessions.merge(session, form.fields, form.files);
    return redirect("/apply/review");
  },

  "GET /apply/review": (ctx) => {
    const session = requireSession(ctx);
    return session instanceof Response ? session : review(ctx, session);
  },

  "GET /apply/review/embedded": (ctx) => {
    const session = requireSession(ctx);
    if (session instanceof Response) return session;
    return page({
      id: "apply-review-embedded",
      title: "Review and submit",
      body: reviewForm(ctx, session),
    });
  },

  "POST /apply/submit": async (ctx) => {
    const session = requireSession(ctx);
    if (session instanceof Response) return session;
    const form = await parseForm(ctx.req);
    ctx.sessions.merge(session, form.fields, form.files);
    const fields: RecordedField[] = session.fields.filter((f) => f.name !== "action");
    // Every POST is recorded. Nothing here dedupes, so a second submit is visible as a
    // second record — that is the whole point of BD18 coverage.
    return finishSubmission(ctx, {
      path: "/apply/submit",
      fields,
      files: session.files,
      outcome: outcomeFor(session, ctx),
    });
  },
};
