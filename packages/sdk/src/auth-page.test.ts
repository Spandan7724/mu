import { describe, expect, test } from "bun:test";
import { authErrorPage, authSuccessPage } from "./auth-page.ts";

describe("auth callback page", () => {
  test("names the provider in the success copy", () => {
    const page = authSuccessPage("OpenAI");
    expect(page).toContain("Authentication successful");
    expect(page).toContain("OpenAI authentication completed. You can close this window.");
    expect(page).toContain("background: #000");
  });

  test("draws the wordmark in the accent as crisp-edged pixels", () => {
    const page = authSuccessPage("OpenAI");
    expect(page).toContain('aria-label="mu"');
    expect(page).toContain("shape-rendering: crispEdges");
    expect(page).toContain("fill: #B1F9DF");
    // The detail copy stays muted — only the mark took the accent.
    expect(page).toContain("color: #8a8a8a");
  });

  test("marks failures in the heading, not the wordmark", () => {
    const page = authErrorPage("OpenAI", "Return to mu and try again.");
    expect(page).toContain("Authentication failed");
    expect(page).toContain("color: #f87171");
    // Identity does not change with the outcome.
    expect(page).toContain("fill: #B1F9DF");
  });

  test("escapes provider-supplied copy", () => {
    expect(authErrorPage("OpenAI", '<script>"x"</script>')).toContain(
      "&lt;script&gt;&quot;x&quot;&lt;/script&gt;",
    );
  });
});
