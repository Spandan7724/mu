import { expect, test } from "bun:test";
import { browserPrompt } from "./prompts.ts";

test("the prompt is static and covers the loop, refs, commits, untrusted content and hand-off", () => {
  const sections = browserPrompt("anthropic/claude-x");
  expect(sections).toHaveLength(1);
  expect(sections.every((section) => !section.dynamic)).toBe(true);
  const text = sections.map((section) => section.text).join("\n");
  for (const phrase of [
    "Every action already returns the new page state",
    "[ref=e12]",
    "Lines starting with * are new",
    "fill_form",
    "commit: true",
    'marked untrusted="true"',
    "prompt injection",
    "Login walls, two-factor codes, CAPTCHAs",
    "change it",
    "notes",
    "re-read the user's request",
  ]) {
    expect(text).toContain(phrase);
  }
});

test("GPT and Codex-plan models get the GPT addendum", () => {
  expect(browserPrompt("openai-codex/gpt-5.6-luna")).toHaveLength(2);
  expect(browserPrompt("openai/gpt-5.5")).toHaveLength(2);
  expect(browserPrompt("google/gemini-3")).toHaveLength(1);
});
