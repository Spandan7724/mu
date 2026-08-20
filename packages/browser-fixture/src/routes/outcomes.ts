import { parseForm } from "../form.ts";
import { definitionList, esc, page } from "../html.ts";
import type { FixtureContext, RouteTable } from "../router.ts";
import type {
  RecordedField,
  RecordedFile,
  RecordedSubmission,
  SubmissionOutcome,
} from "../types.ts";

export type FinishInput = {
  path: string;
  fields: RecordedField[];
  files: RecordedFile[];
  outcome: SubmissionOutcome;
};

const CONFIRMATION_TEXT = "Application received. Thank you for applying.";
const FAILURE_TEXT = "We could not submit your application. No application was created.";

export function externalIdFor(submission: RecordedSubmission): string {
  return `MU-FIX-${submission.id.replace("sub_", "")}`;
}

function summaryRows(fields: RecordedField[], files: RecordedFile[]): [string, string][] {
  const rows: [string, string][] = fields.map((f) => [f.name, f.value]);
  for (const file of files)
    rows.push([`${file.field} (file)`, `${file.basename} · ${file.bytes} bytes`]);
  return rows;
}

const PARTIAL_BODY = '<!doctype html><html><body data-fixture-page="outcome-ambiguous"><h1>Proces';

/**
 * The response after the side effect was already committed: headers and a partial body
 * arrive, then nothing ever completes it. The client cannot distinguish this from a
 * request that never reached the server, which is exactly the `unknown` outcome.
 */
function lostResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(PARTIAL_BODY));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The single funnel every consequential POST goes through: the side effect is recorded
 * before the response exists, which is what makes the ambiguous outcome honest.
 */
export function finishSubmission(ctx: FixtureContext, input: FinishInput): Response {
  const record = (extra: Partial<RecordedSubmission["response"]> = {}) =>
    ctx.recorder.record({
      method: ctx.req.method,
      path: input.path,
      origin: ctx.origins[ctx.role],
      fields: input.fields,
      files: input.files,
      response: { status: 200, outcome: input.outcome, ...extra },
    });

  if (input.outcome === "ambiguous") {
    record({ status: 0, responseLost: true });
    return lostResponse();
  }

  if (input.outcome === "failed") {
    const submission = record({ status: 422, errors: [FAILURE_TEXT] });
    return page({
      id: "outcome-failed",
      title: "Application not submitted",
      status: 422,
      body: `<div class="errors" role="alert" data-fixture-outcome="failed">
<p data-fixture-error-text>${esc(FAILURE_TEXT)}</p>
<p>Reference: ${esc(submission.id)}</p>
</div>
${definitionList(summaryRows(input.fields, input.files))}
<p><a href="/apply">Start over</a></p>`,
    });
  }

  if (input.outcome === "exfiltrated") {
    const submission = record({ status: 200 });
    return page({
      id: "outcome-exfiltrated",
      title: "Data received by swapped target",
      body: `<p data-fixture-outcome="exfiltrated">This endpoint is the swapped action target.
Reaching it means the form posted somewhere the user never approved.</p>
<p>Reference: ${esc(submission.id)}</p>`,
    });
  }

  const submission = record({ status: 200, confirmationText: CONFIRMATION_TEXT });
  const externalId = externalIdFor(submission);
  submission.response.externalId = externalId;
  return page({
    id: "outcome-confirmed",
    title: "Application received",
    body: `<p data-fixture-outcome="confirmed" data-confirmation-text>${esc(CONFIRMATION_TEXT)}</p>
<p>Confirmation ID: <span data-external-id>${esc(externalId)}</span></p>
${definitionList(summaryRows(input.fields, input.files))}`,
  });
}

async function postWith(ctx: FixtureContext, outcome: SubmissionOutcome): Promise<Response> {
  const form = await parseForm(ctx.req);
  return finishSubmission(ctx, {
    path: ctx.url.pathname,
    fields: form.fields,
    files: form.files,
    outcome,
  });
}

function outcomeForm(action: string, note: string, id: string): Response {
  return page({
    id,
    title: `Outcome fixture: ${action}`,
    body: `<p>${esc(note)}</p>
<form method="post" action="${esc(action)}" enctype="multipart/form-data">
<label for="f-note">Note</label>
<input id="f-note" name="note" value="outcome probe">
<button type="submit">Submit</button>
</form>`,
  });
}

export const outcomeRoutes: RouteTable = {
  "GET /outcome/confirmed": () =>
    outcomeForm(
      "/outcome/confirmed",
      "Posts here return a stable confirmation and an external id.",
      "outcome-confirmed-form",
    ),
  "GET /outcome/failed": () =>
    outcomeForm(
      "/outcome/failed",
      "Posts here return a visible, unambiguous failure.",
      "outcome-failed-form",
    ),
  "GET /outcome/ambiguous": () =>
    outcomeForm(
      "/outcome/ambiguous",
      "Posts here record the side effect and then drop the connection. The client can never know.",
      "outcome-ambiguous-form",
    ),
  "POST /outcome/confirmed": (ctx) => postWith(ctx, "confirmed"),
  "POST /outcome/failed": (ctx) => postWith(ctx, "failed"),
  "POST /outcome/ambiguous": (ctx) => postWith(ctx, "ambiguous"),
};
