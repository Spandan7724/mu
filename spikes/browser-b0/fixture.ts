const port = Number.parseInt(process.env.B0_FIXTURE_PORT ?? "4173", 10);
const sessionCookie = "b0_session=fixture-authenticated";

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      body { font: 18px system-ui, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 24px; }
      main { display: grid; gap: 18px; }
      label { display: grid; gap: 6px; }
      input, button, a { font: inherit; }
      button, input { padding: 8px 12px; }
      output { min-height: 1.5em; color: #075985; }
    </style>
  </head>
  <body><main>${body}</main></body>
</html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    console.log(`${request.method} ${url.pathname}`);

    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

    if (url.pathname === "/establish-session") {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": `${sessionCookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
        },
      });
    }

    if (url.pathname === "/clear-session") {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": "b0_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        },
      });
    }

    if (url.pathname === "/second") {
      return page(
        "B0 second page",
        `
        <h1>Navigation succeeded</h1>
        <p id="second-state">This is the second fixture page.</p>
        <a href="/">Return to fixture</a>`,
      );
    }

    if (url.pathname === "/popup") {
      return page(
        "B0 popup",
        `
        <h1>Popup succeeded</h1>
        <p id="popup-state">This tab was opened by the fixture.</p>`,
      );
    }

    if (url.pathname !== "/") return new Response("Not found", { status: 404 });

    const authenticated =
      request.headers.get("cookie")?.split(/;\s*/).includes(sessionCookie) ?? false;
    return page(
      "Mu browser B0 fixture",
      `
      <h1>Mu browser B0 fixture</h1>
      <p id="auth-state">Session state: ${authenticated ? "authenticated" : "anonymous"}</p>
      ${
        authenticated
          ? '<a href="/clear-session">Clear synthetic session</a>'
          : '<a href="/establish-session">Establish synthetic authenticated state</a>'
      }
      <label>Display name <input name="displayName" autocomplete="off"></label>
      <button id="save" type="button">Save draft</button>
      <output id="result" aria-live="polite"></output>
      <a href="/second">Go to second page</a>
      <button id="popup" type="button">Open popup</button>
      <script>
        document.querySelector('#save').addEventListener('click', () => {
          const value = document.querySelector('input').value;
          document.querySelector('#result').textContent = 'Draft saved for ' + value;
        });
        document.querySelector('#popup').addEventListener('click', () => {
          window.open('/popup', '_blank');
        });
      </script>`,
    );
  },
});

console.log(`B0 fixture listening at ${server.url}`);

const stop = async () => {
  await server.stop(true);
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
