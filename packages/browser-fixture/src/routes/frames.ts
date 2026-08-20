import { parseForm } from "../form.ts";
import { esc, page, textField } from "../html.ts";
import type { RouteTable } from "../router.ts";
import { readCookie, SESSION_COOKIE } from "../session.ts";
import { finishSubmission } from "./outcomes.ts";

function embeddedForm(action: string, note: string): string {
  return `<p>${esc(note)}</p>
<form method="post" action="${esc(action)}" enctype="multipart/form-data">
${textField({ name: "frame_field", label: "Field inside the frame" })}
<button type="submit">Submit from frame</button>
</form>`;
}

export const frameRoutes: RouteTable = {
  "GET /frames/same-origin": () =>
    page({
      id: "frames-same-origin",
      title: "Same-origin frame",
      body: `<p>The nested document shares this page's origin, so it inherits the same origin decision.</p>
<iframe title="Same-origin application form" src="/embedded/form"></iframe>`,
    }),

  "GET /frames/cross-origin": (ctx) =>
    page({
      id: "frames-cross-origin",
      title: "Cross-origin frame",
      body: `<p>The nested document is served by a second loopback origin
(${esc(ctx.origins.secondary)}) and must receive its own origin decision.</p>
<iframe title="Cross-origin application form" src="${esc(ctx.origins.secondary)}/embedded/form"></iframe>`,
    }),

  "GET /frames/nested": (ctx) =>
    page({
      id: "frames-nested",
      title: "Nested frames",
      body: `<p>Same-origin frame containing a cross-origin frame.</p>
<iframe title="Outer frame" src="/embedded/nested-host?inner=${encodeURIComponent(`${ctx.origins.secondary}/embedded/form`)}"></iframe>`,
    }),

  "GET /embedded/nested-host": (ctx) => {
    const inner = ctx.url.searchParams.get("inner") ?? "/embedded/form";
    const safe =
      inner.startsWith("http://127.0.0.1:") || inner.startsWith("/") ? inner : "/embedded/form";
    return page({
      id: "embedded-nested-host",
      title: "Outer frame",
      body: `<iframe title="Inner frame" src="${esc(safe)}"></iframe>`,
    });
  },

  "GET /embedded/form": (ctx) =>
    page({
      id: "embedded-form",
      title: "Frame form",
      body: embeddedForm(
        "/embedded/form",
        `This document was served by ${ctx.origins[ctx.role]}. Posting stays on that origin.`,
      ),
    }),

  "POST /embedded/form": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/embedded/form",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  /**
   * Cross-origin review target for the job-application `iframe-cross-origin` variant. The
   * session cookie is not sent cross-origin, so the session id arrives in the query.
   */
  "GET /embedded/apply-review": (ctx) => {
    const id = ctx.url.searchParams.get("sid") ?? readCookie(ctx.req, SESSION_COOKIE);
    const session = ctx.sessions.get(id ?? undefined);
    if (!session)
      return page({
        id: "embedded-apply-review",
        title: "Review unavailable",
        status: 404,
        body: "<p>No application session.</p>",
      });
    const rows = session.fields
      .filter((f) => f.name !== "action")
      .map((f) => `<input type="hidden" name="${esc(f.name)}" value="${esc(f.value)}">`)
      .join("");
    return page({
      id: "embedded-apply-review",
      title: "Review and submit",
      body: `<p>Cross-origin review frame for application ${esc(session.id)}.</p>
<form method="post" action="${esc(ctx.origins.primary)}/apply/submit?sid=${encodeURIComponent(session.id)}" enctype="multipart/form-data">
${rows}
<button type="submit" data-role="submit">Submit application</button>
</form>`,
    });
  },
};
