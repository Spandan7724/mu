import { z } from "zod";

// The classified, externally consequential operations. BD12 keeps them off
// BrowserAction entirely: they are reachable only through submit().
export type SubmitIntent =
  | "submit-form"
  | "send"
  | "purchase"
  | "delete"
  | "consent"
  | "account-change";

export const submitIntentSchema = z.enum([
  "submit-form",
  "send",
  "purchase",
  "delete",
  "consent",
  "account-change",
]);

// SECURITY.md §9: autonomous-submit may pre-authorize these two for approved task
// origins. Its scoped grant does not cover the remaining intents; explicit full access does.
export const AUTONOMOUS_SUBMIT_INTENTS: readonly SubmitIntent[] = ["submit-form", "send"];

export function permissionScopeForIntent(intent: SubmitIntent): string {
  return intent === "submit-form" ? "browser:submit" : `browser:${intent}`;
}
