import { parseForm } from "../form.ts";
import { page } from "../html.ts";
import type { RouteTable } from "../router.ts";
import { finishSubmission } from "./outcomes.ts";

/**
 * A history-API single-page app. Routes change without a document load, and each step's
 * content arrives from a deliberately delayed fetch so an observation taken too early sees
 * a loading state rather than the form.
 */
export const spaRoutes: RouteTable = {
  "GET /spa": () =>
    page({
      id: "spa-shell",
      title: "SPA application",
      body: `<nav>
<button type="button" data-route="/spa/start">Start</button>
<button type="button" data-route="/spa/details">Details</button>
<button type="button" data-route="/spa/confirm">Confirm</button>
</nav>
<main id="view" data-spa-route="/spa/start" data-spa-state="loading">Loading…</main>
<script>
(function () {
  var view = document.getElementById('view');
  function render(route) {
    view.setAttribute('data-spa-route', route);
    view.setAttribute('data-spa-state', 'loading');
    view.innerHTML = '<p>Loading…</p>';
    fetch('/spa/data?route=' + encodeURIComponent(route))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        view.innerHTML = data.html;
        view.setAttribute('data-spa-state', 'ready');
      });
  }
  document.querySelectorAll('[data-route]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var route = btn.getAttribute('data-route');
      history.pushState({ route: route }, '', route);
      render(route);
    });
  });
  window.addEventListener('popstate', function (e) {
    render((e.state && e.state.route) || '/spa/start');
  });
  render(location.pathname.indexOf('/spa/') === 0 ? location.pathname : '/spa/start');
})();
</script>`,
    }),

  "GET /spa/data": async (ctx) => {
    const route = ctx.url.searchParams.get("route") ?? "/spa/start";
    const delayMs = Number(ctx.url.searchParams.get("delayMs") ?? "400");
    await Bun.sleep(Number.isFinite(delayMs) ? Math.min(Math.max(delayMs, 0), 5000) : 400);
    const views: Record<string, string> = {
      "/spa/start": "<h2>Start</h2><p>Choose Details to continue.</p>",
      "/spa/details":
        '<h2>Details</h2><form method="post" action="/spa/submit" enctype="multipart/form-data">' +
        '<label for="s-name">Full name</label><input id="s-name" name="full_name" required>' +
        '<label for="s-role">Role</label><select id="s-role" name="role">' +
        '<option value="">Select</option><option value="eng">Engineer</option>' +
        '<option value="design">Designer</option></select>' +
        '<button type="submit">Send</button></form>',
      "/spa/confirm": "<h2>Confirm</h2><p data-spa-confirm>Nothing has been sent yet.</p>",
    };
    return Response.json({ route, html: views[route] ?? "<h2>Not found</h2>" });
  },

  "POST /spa/submit": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/spa/submit",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },
};

/** Deep links into the SPA shell so a driver can navigate straight to a route. */
export const spaPrefixRoutes: RouteTable = {
  "GET /spa/start": () => new Response(null, { status: 303, headers: { location: "/spa" } }),
  "GET /spa/details": () => new Response(null, { status: 303, headers: { location: "/spa" } }),
  "GET /spa/confirm": () => new Response(null, { status: 303, headers: { location: "/spa" } }),
};
