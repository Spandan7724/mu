import { describe, expect, test } from "bun:test";
import { authErrorPage, authSuccessPage } from "./auth-page.ts";

describe("auth callback page", () => {
  test("names the provider in the success copy", () => {
    const page = authSuccessPage("OpenAI");
    expect(page).toContain("Authentication successful");
    expect(page).toContain("OpenAI authentication completed. You can close this window.");
    expect(page).toContain(">mu<");
    expect(page).toContain("#2dd4bf");
    expect(page).toContain("background: #000");
  });

  test("marks failures without the accent", () => {
    const page = authErrorPage("OpenAI", "Return to mu and try again.");
    expect(page).toContain("Authentication failed");
    expect(page).toContain("#f87171");
    expect(page).not.toContain("#2dd4bf");
  });

  test("escapes provider-supplied copy", () => {
    expect(authErrorPage("OpenAI", '<script>"x"</script>')).toContain(
      "&lt;script&gt;&quot;x&quot;&lt;/script&gt;",
    );
  });
});
