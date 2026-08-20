import { esc, page } from "../html.ts";
import type { FixtureContext, RouteTable } from "../router.ts";

function nextAttempt(ctx: FixtureContext, key: string): number {
  const next = (ctx.counters.get(key) ?? 0) + 1;
  ctx.counters.set(key, next);
  return next;
}

function clampedNumber(raw: string | null, fallback: number, max: number): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), max);
}

function hopTarget(hop: number, total: number): string {
  return hop >= total ? "/flaky/redirect-target" : `/flaky/redirect?hop=${hop + 1}&hops=${total}`;
}

export const flakyRoutes: RouteTable = {
  "GET /flaky/slow": async (ctx) => {
    const delayMs = clampedNumber(ctx.url.searchParams.get("ms"), 1200, 10_000);
    await Bun.sleep(delayMs);
    return page({
      id: "flaky-slow",
      title: "Slow page",
      body: `<p data-slow-ms="${delayMs}">This document was held for ${delayMs}ms before the first byte.</p>`,
    });
  },

  "GET /flaky/slow-body": (ctx) => {
    const delayMs = clampedNumber(ctx.url.searchParams.get("ms"), 800, 10_000);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            '<!doctype html><html><body data-fixture-page="flaky-slow-body"><h1>Loading</h1>',
          ),
        );
        await Bun.sleep(delayMs);
        controller.enqueue(
          encoder.encode('<p data-slow-body="ready">Rest of the document.</p></body></html>'),
        );
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/html; charset=utf-8" } });
  },

  /** Fails with 503 for the first `fail` requests, then succeeds. Retry behaviour is testable. */
  "GET /flaky/transient": (ctx) => {
    const failures = clampedNumber(ctx.url.searchParams.get("fail"), 2, 20);
    const key = `${ctx.role}:transient:${ctx.url.searchParams.get("key") ?? "default"}`;
    const attempt = nextAttempt(ctx, key);
    if (attempt <= failures) {
      return page({
        id: "flaky-transient",
        title: "Temporarily unavailable",
        status: 503,
        headers: { "retry-after": "1" },
        body: `<p data-attempt="${attempt}">Attempt ${attempt} of ${failures + 1} failed on purpose.</p>`,
      });
    }
    return page({
      id: "flaky-transient",
      title: "Recovered",
      body: `<p data-attempt="${attempt}" data-recovered="true">Recovered on attempt ${attempt}.</p>`,
    });
  },

  "GET /flaky/redirect": (ctx) => {
    const hops = clampedNumber(ctx.url.searchParams.get("hops"), 3, 10);
    const hop = clampedNumber(ctx.url.searchParams.get("hop"), 1, 10);
    return new Response(null, { status: 302, headers: { location: hopTarget(hop, hops) } });
  },

  "GET /flaky/redirect-target": () =>
    page({
      id: "flaky-redirect-target",
      title: "End of the redirect chain",
      body: '<p data-redirect-target="true">Final document after the redirect chain.</p>',
    }),

  "GET /flaky/status": (ctx) => {
    const code = clampedNumber(ctx.url.searchParams.get("code"), 500, 599);
    return page({
      id: "flaky-status",
      title: `HTTP ${code}`,
      status: code < 200 ? 500 : code,
      body: `<p data-status-code="${code}">Requested status ${code}.</p>`,
    });
  },

  /** Headers and a partial body arrive, then the response never finishes. */
  "GET /flaky/stall": () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('<!doctype html><html><body data-stalled="true">'),
        );
      },
    });
    return new Response(stream, { headers: { "content-type": "text/html; charset=utf-8" } });
  },

  "GET /flaky": (ctx) =>
    page({
      id: "flaky-index",
      title: "Unreliable pages",
      body: `<ul>
<li><a href="/flaky/slow?ms=1200">Slow first byte</a></li>
<li><a href="/flaky/slow-body?ms=800">Slow body</a></li>
<li><a href="/flaky/transient?fail=2">Transient 503 then success</a></li>
<li><a href="/flaky/redirect?hops=3">Three-hop redirect</a></li>
<li><a href="/flaky/status?code=500">Explicit server error</a></li>
<li><a href="/flaky/stall">Response that never finishes</a></li>
</ul>
<p>Served by ${esc(ctx.origins[ctx.role])}.</p>`,
    }),
};
