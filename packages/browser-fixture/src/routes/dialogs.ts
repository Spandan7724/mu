import { parseForm } from "../form.ts";
import { esc, page, textField } from "../html.ts";
import type { RouteTable } from "../router.ts";
import { finishSubmission } from "./outcomes.ts";

export const dialogRoutes: RouteTable = {
  "GET /dialogs": () =>
    page({
      id: "dialogs",
      title: "Dialogs, popups and before-unload",
      body: `<p>Each control below produces a different interruption a driver must handle explicitly.</p>
<button type="button" id="do-alert" onclick="alert('Your session will expire in 5 minutes.'); document.body.setAttribute('data-last-dialog','alert')">Show alert</button>
<button type="button" id="do-confirm" onclick="document.body.setAttribute('data-last-dialog', confirm('Discard this application?') ? 'confirm:accepted' : 'confirm:dismissed')">Show confirm</button>
<button type="button" id="do-prompt" onclick="document.body.setAttribute('data-last-dialog', 'prompt:' + String(prompt('Reference code?', '')))">Show prompt</button>
<button type="button" id="do-popup" onclick="window.open('/dialogs/popup', 'muFixturePopup', 'width=520,height=420')">Open popup window</button>
<p><a href="/dialogs/new-tab" target="_blank" rel="noopener" id="do-new-tab">Open in a new tab</a></p>
<p><a href="/" id="leave-page">Leave this page</a></p>
<form method="post" action="/dialogs/submit" enctype="multipart/form-data" id="guarded">
${textField({ name: "draft_note", label: "Draft note" })}
<button type="submit">Save draft</button>
</form>
<script>
(function () {
  var dirty = false;
  document.getElementById('f-draft_note').addEventListener('input', function () { dirty = true; });
  window.addEventListener('beforeunload', function (e) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = 'You have an unsaved draft.';
    return 'You have an unsaved draft.';
  });
  document.getElementById('guarded').addEventListener('submit', function () { dirty = false; });
})();
</script>`,
    }),

  "POST /dialogs/submit": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/dialogs/submit",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  "GET /dialogs/popup": () =>
    page({
      id: "dialogs-popup",
      title: "Popup window",
      body: `<p data-popup-marker>This document is a popup opened by window.open.</p>
<form method="post" action="/dialogs/popup" enctype="multipart/form-data">
${textField({ name: "popup_field", label: "Answer in the popup" })}
<button type="submit">Submit from popup</button>
</form>
<button type="button" onclick="window.close()">Close this window</button>`,
    }),

  "POST /dialogs/popup": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/dialogs/popup",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  "GET /dialogs/new-tab": () =>
    page({
      id: "dialogs-new-tab",
      title: "New tab",
      body: `<p data-new-tab-marker>Opened with target="_blank".</p>
<p>Origin: ${esc("this document was served by the fixture")}.</p>`,
    }),

  "GET /dialogs/before-unload": () =>
    page({
      id: "dialogs-before-unload",
      title: "Before-unload guard",
      body: `<p>This page always blocks navigation away.</p>
<p><a href="/">Go home</a></p>
<script>
window.addEventListener('beforeunload', function (e) {
  e.preventDefault();
  e.returnValue = 'Leave without finishing?';
  return 'Leave without finishing?';
});
</script>`,
    }),
};
