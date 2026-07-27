// The browser-facing side of the localhost OAuth callback. Kept apart from the flow in
// auth.ts so the markup stays reviewable as a design surface, and so a second account
// provider only supplies its display name.

export interface AuthPageOptions {
  provider: string;
  status: "success" | "error";
  heading: string;
  detail: string;
}

const ACCENT = "#2dd4bf";
const ERROR = "#f87171";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderAuthPage(options: AuthPageOptions): string {
  const mark = options.status === "success" ? ACCENT : ERROR;
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
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
      "Liberation Mono", monospace;
    font-size: 3.25rem;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.04em;
    color: ${mark};
  }
  h1 {
    margin: 2.25rem 0 0;
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: #fff;
  }
  p {
    margin: 0.75rem 0 0;
    font-size: 0.9375rem;
    line-height: 1.5;
    color: #8a8a8a;
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
  <div class="mark">mu</div>
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
