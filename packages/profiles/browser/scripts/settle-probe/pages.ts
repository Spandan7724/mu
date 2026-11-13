// Synthetic pages for the settle probe. Each models one general page behaviour and
// shows MARKER exactly when its content is ready, so "returned too early" is known.
export const MARKER = "PROBE-READY";

const page = (title: string, body: string, script = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><main><h1>${title}</h1>${body}</main><script>${script}</script></body></html>`;

const ready = `function ready(text){var p=document.createElement('p');p.textContent='${MARKER} '+(text||'');document.querySelector('main').appendChild(p);}`;

const PAGES: Record<string, string> = {
  // Nothing but content.
  static: page("Static", `<p>Plain article text.</p><p>${MARKER}</p><a href="/static">Link</a>`),
  // Content is final at once; the page posts telemetry forever.
  "beacon-noise": page(
    "Beacon noise",
    `<p>Article.</p><p>${MARKER}</p>`,
    "function b(){fetch('/collect',{method:'POST',body:'x'})}b();setInterval(b,400);",
  ),
  // Content is final at once; images keep arriving slowly.
  "image-stream": page(
    "Image stream",
    `<p>Gallery.</p><p>${MARKER}</p><div id=g></div>`,
    "var i=0;var t=setInterval(function(){var im=new Image();im.width=40;im.height=40;im.alt='photo '+i;im.src='/img?ms='+(800+(i*397)%3200)+'&i='+i;document.getElementById('g').appendChild(im);if(++i>=25)clearInterval(t)},300);",
  ),
  // A busy indicator, then data from a slow request that starts a little later.
  "spinner-slow": page(
    "Spinner",
    `<div id=s role=progressbar aria-busy=true>Loading…</div>`,
    `${ready}setTimeout(function(){fetch('/api/slow?ms=2500').then(function(){document.getElementById('s').remove();ready('data')})},300);`,
  ),
  // Placeholder blocks with no busy semantics, filled by a slow request.
  "skeleton-slow": page(
    "Skeleton",
    `<div class=sk>&nbsp;</div><div class=sk>&nbsp;</div>`,
    `${ready}fetch('/api/slow?ms=3000').then(function(){ready('rows')});`,
  ),
  // Content is final at once; a long-poll stays open.
  longpoll: page(
    "Long poll",
    `<p>Chat.</p><p>${MARKER}</p>`,
    "function poll(){fetch('/api/hold').then(poll,poll)}poll();",
  ),
  // Content is final at once except a clock that ticks forever.
  ticker: page(
    "Ticker",
    `<p>Dashboard.</p><p>${MARKER}</p><p id=c>0</p>`,
    "var n=0;setInterval(function(){document.getElementById('c').textContent=String(++n)},250);",
  ),
  // Content arrives from a script that loads slowly.
  "late-script": page(
    "Late script",
    `<p>Shell.</p>`,
    `${ready}var s=document.createElement('script');s.src='/late.js?ms=1500';document.head.appendChild(s);`,
  ),
  // The page renders, then streams its body in chunks over several seconds.
  "progressive-feed": page(
    "Feed",
    `<ul id=f></ul>`,
    `${ready}var k=0;function more(){fetch('/api/slow?ms=400').then(function(){var li=document.createElement('li');li.textContent='item '+k;document.getElementById('f').appendChild(li);if(++k<6)more();else ready('feed')})}more();`,
  ),
  // In-page actions, each behind a button.
  "click-fetch-fast": page(
    "Fast load",
    "<button id=b>Load</button>",
    `${ready}document.getElementById('b').onclick=function(){fetch('/api/slow?ms=300').then(function(){ready('loaded')})};`,
  ),
  "click-fetch-slow-plain": page(
    "Slow load",
    "<button id=b>Load</button>",
    `${ready}document.getElementById('b').onclick=function(){fetch('/api/slow?ms=2500').then(function(){ready('loaded')})};`,
  ),
  "click-fetch-slow-spinner": page(
    "Slow load spinner",
    "<button id=b>Load</button><div id=s></div>",
    `${ready}document.getElementById('b').onclick=function(){var s=document.getElementById('s');s.setAttribute('role','progressbar');s.setAttribute('aria-busy','true');s.textContent='Loading…';fetch('/api/slow?ms=2500').then(function(){s.remove();ready('loaded')})};`,
  ),
  // The save starts after a debounce, as many editors do.
  autosave: page(
    "Autosave",
    "<button id=b>Save</button>",
    `${ready}document.getElementById('b').onclick=function(){setTimeout(function(){fetch('/api/save',{method:'POST',body:'d'}).then(function(){ready('saved')})},600)};`,
  ),
  // A submit whose request is the save, answered slowly.
  "click-post-slow": page(
    "Submit",
    "<button id=b>Submit</button>",
    `${ready}document.getElementById('b').onclick=function(){fetch('/api/save?ms=2000',{method:'POST',body:'d'}).then(function(){ready('sent')})};`,
  ),
  "click-noop": page("No-op", "<button id=b>Nothing</button>", ""),
  // A plain text field that searches once typing pauses for 500 ms.
  "search-debounced": page(
    "Search",
    `<input aria-label="Search" placeholder="Search"><ul id=r></ul>`,
    `${ready}var t;document.querySelector('input').oninput=function(){clearTimeout(t);t=setTimeout(function(){fetch('/api/slow?ms=300').then(function(){document.getElementById('r').innerHTML='<li>Result one</li><li>Result two</li>';ready('results')})},500)};`,
  ),
  // A search box (input type=search) that filters after a 350 ms pause.
  "filter-debounced": page(
    "Filter",
    `<input type=search aria-label="Filter by name"><ul id=r></ul>`,
    `${ready}var t;document.querySelector('input').oninput=function(){clearTimeout(t);t=setTimeout(function(){fetch('/api/slow?ms=300').then(function(){document.getElementById('r').innerHTML='<li>Model one</li>';ready('filtered')})},350)};`,
  ),
  // The response arrives after 1.4 s and its rows are drawn over the next 600 ms.
  "click-fetch-render": page(
    "Rows",
    "<button id=b>Load</button><ul id=r></ul>",
    `${ready}document.getElementById('b').onclick=function(){fetch('/api/slow?ms=1400').then(function(){var i=0;var t=setInterval(function(){var li=document.createElement('li');li.textContent='Row '+i;document.getElementById('r').appendChild(li);if(++i>=6){clearInterval(t);ready('rows')}},100)})};`,
  ),
  // The page's own data request takes longer than the in-page time limit.
  "click-fetch-own-slow": page(
    "Slow data",
    "<button id=b>Load</button>",
    `${ready}document.getElementById('b').onclick=function(){fetch('/api/slow?ms=3500').then(function(){ready('loaded')})};`,
  ),
  // Nothing is drawn until the app boots 3 s after load, with no network meanwhile.
  "empty-then-render":
    "<!doctype html><html><head><meta charset=utf-8><title>App</title></head><body><main></main>" +
    `<script>${ready}setTimeout(function(){var m=document.querySelector('main');m.innerHTML='<h1>App</h1><p>Dashboard</p><a href=/static>Link</a>';ready('app')},3000);</script></body></html>`,
  // A form posts and the server answers slowly with a new page.
  "submit-nav": page(
    "Form",
    `<form method=post action="/submit"><input name=q value=x><button>Send</button></form>`,
  ),
  submitted: page("Submitted", `<p>${MARKER} thanks</p>`),
  // Client-side route change after a fetch.
  "spa-route": page(
    "SPA",
    `<a id=l href="/spa-route/next">Next page</a>`,
    `${ready}document.getElementById('l').onclick=function(e){e.preventDefault();history.pushState({},'','/spa-route/next');fetch('/api/slow?ms=800').then(function(){document.querySelector('h1').textContent='Next';ready('route')})};`,
  ),
};

export interface ProbeSite {
  url: (name: string) => string;
  stop: () => void;
}

export function startProbeSite(): ProbeSite {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const wait = (ms: number) => Bun.sleep(Math.min(ms, 60_000));
      if (path === "/collect") return new Response(null, { status: 204 });
      if (path === "/api/slow") {
        await wait(Number(url.searchParams.get("ms") ?? 500));
        return Response.json({ ok: true });
      }
      if (path === "/api/hold") {
        await wait(25_000);
        return Response.json({});
      }
      if (path === "/api/save") {
        await wait(Number(url.searchParams.get("ms") ?? 1_000));
        return Response.json({ saved: true });
      }
      if (path === "/img") {
        await wait(Number(url.searchParams.get("ms") ?? 500));
        const gif = Uint8Array.from(
          atob("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="),
          (c) => c.charCodeAt(0),
        );
        return new Response(gif, { headers: { "content-type": "image/gif" } });
      }
      if (path === "/late.js") {
        await wait(Number(url.searchParams.get("ms") ?? 1_000));
        return new Response("ready('script')", { headers: { "content-type": "text/javascript" } });
      }
      if (path === "/submit" && request.method === "POST") {
        await wait(1_500);
        return Response.redirect(new URL("/submitted", url).href, 303);
      }
      const name = path.slice(1).split("/")[0] || "static";
      const html = PAGES[name];
      if (!html) return new Response("not found", { status: 404 });
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  return {
    url: (name) => `http://127.0.0.1:${server.port}/${name}`,
    stop: () => server.stop(true),
  };
}
