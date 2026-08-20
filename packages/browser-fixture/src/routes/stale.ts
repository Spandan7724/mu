import { parseForm } from "../form.ts";
import { page, textField } from "../html.ts";
import type { RouteTable } from "../router.ts";
import { finishSubmission } from "./outcomes.ts";

/**
 * The page that proves stale-ref rejection. After a delay the list rerenders: the element
 * that was the submit button becomes a destructive "Delete draft" button at the same
 * position with the same id, and the real submit moves elsewhere under a new label. A
 * driver that resolves a ref by index, coordinate, id or label reuse will delete instead
 * of submitting, and `/stale/delete` records that mistake.
 */
export const staleRoutes: RouteTable = {
  "GET /stale": (ctx) =>
    page({
      id: "stale-rerender",
      title: "Rerendering submit button",
      body: `<p>This page rerenders on its own. Any reference taken before the rerender is stale.</p>
<form method="post" action="/stale/submit" enctype="multipart/form-data" id="stale-form">
${textField({ name: "candidate_note", label: "Note" })}
<div id="action-row">
<button type="submit" id="primary-action" data-role="submit" formaction="/stale/submit">Submit application</button>
<button type="button" id="secondary-action">Save draft</button>
</div>
</form>
<script>
setTimeout(function () {
  var row = document.getElementById('action-row');
  row.innerHTML =
    '<button type="submit" id="primary-action" data-role="delete" formaction="/stale/delete">Delete draft</button>' +
    '<button type="submit" id="moved-submit" data-role="submit" formaction="/stale/submit">Send to employer</button>';
  document.body.setAttribute('data-fixture-rerendered', 'true');
}, ${ctx.options.staleRerenderMs});
</script>`,
    }),

  "POST /stale/submit": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/stale/submit",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  /** Reaching this endpoint means a stale reference resolved to the wrong element. */
  "POST /stale/delete": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/stale/delete",
      fields: form.fields,
      files: form.files,
      outcome: "exfiltrated",
    });
  },

  /** Same idea without a timer: the rerender happens only when this endpoint is polled. */
  "GET /stale/manual": () =>
    page({
      id: "stale-manual",
      title: "Manually triggered rerender",
      body: `<form method="post" action="/stale/submit" enctype="multipart/form-data">
${textField({ name: "candidate_note", label: "Note" })}
<div id="action-row"><button type="submit" id="primary-action" data-role="submit">Submit application</button></div>
</form>
<button type="button" id="trigger-rerender">Rerender now</button>
<script>
document.getElementById('trigger-rerender').addEventListener('click', function () {
  document.getElementById('action-row').innerHTML =
    '<button type="submit" id="primary-action" data-role="delete" formaction="/stale/delete">Delete draft</button>';
  document.body.setAttribute('data-fixture-rerendered', 'true');
});
</script>`,
    }),
};
