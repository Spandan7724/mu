// The browser-facing side of the localhost OAuth callback. Kept apart from the flow in
// auth.ts so the markup stays reviewable as a design surface, and so a second account
// provider only supplies its display name.

export interface AuthPageOptions {
  provider: string;
  status: "success" | "error";
  heading: string;
  detail: string;
}

const MUTED = "#8a8a8a";
const ERROR = "#f87171";

// "mu" on a 10x5 pixel grid, drawn as runs rather than per-pixel rects. A bitmap keeps the
// mark self-contained: the callback is served off localhost, so no font can be fetched.
const WORDMARK_PIXELS = [
  { x: 0, y: 0, w: 5, h: 1 },
  { x: 0, y: 1, w: 1, h: 4 },
  { x: 2, y: 1, w: 1, h: 4 },
  { x: 4, y: 1, w: 1, h: 4 },
  { x: 6, y: 0, w: 1, h: 5 },
  { x: 9, y: 0, w: 1, h: 5 },
  { x: 7, y: 4, w: 2, h: 1 },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wordmark(): string {
  const pixels = WORDMARK_PIXELS.map(
    (pixel) => `<rect x="${pixel.x}" y="${pixel.y}" width="${pixel.w}" height="${pixel.h}"/>`,
  ).join("");
  return `<svg class="mark" viewBox="0 0 10 5" role="img" aria-label="mu">${pixels}</svg>`;
}

export function renderAuthPage(options: AuthPageOptions): string {
  const heading = options.status === "success" ? "#fff" : ERROR;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>mu — ${escapeHtml(options.heading.toLowerCase())}</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    color: #ededed;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    padding: 2rem;
    text-align: center;
    animation: rise 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .mark {
    display: block;
    width: 90px;
    height: 45px;
    margin: 0 auto;
    fill: ${MUTED};
    shape-rendering: crispEdges;
  }
  h1 {
    margin: 2.25rem 0 0;
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: ${heading};
  }
  p {
    margin: 0.75rem 0 0;
    font-size: 0.9375rem;
    line-height: 1.5;
    color: ${MUTED};
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    main { animation: none; }
  }
</style>
</head>
<body>
<main>
  ${wordmark()}
  <h1>${escapeHtml(options.heading)}</h1>
  <p>${escapeHtml(options.detail)}</p>
</main>
</body>
</html>
`;
}

export function authSuccessPage(provider: string): string {
  return renderAuthPage({
    provider,
    status: "success",
    heading: "Authentication successful",
    detail: `${provider} authentication completed. You can close this window.`,
  });
}

export function authErrorPage(provider: string, detail: string): string {
  return renderAuthPage({ provider, status: "error", heading: "Authentication failed", detail });
}
