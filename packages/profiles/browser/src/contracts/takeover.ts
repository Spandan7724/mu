import { z } from "zod";
import { BROWSER_LIMITS } from "./json.ts";
import { identifierSchema, observedUrlSchema, timestampSchema } from "./primitives.ts";

export type TakeoverReason =
  | "login"
  | "password"
  | "passkey"
  | "mfa"
  | "captcha"
  | "ambiguous-action"
  | "unsupported-ui"
  | "user-requested";

export const takeoverReasonSchema = z.enum([
  "login",
  "password",
  "passkey",
  "mfa",
  "captcha",
  "ambiguous-action",
  "unsupported-ui",
  "user-requested",
]);

// BD14: reasons the agent hands the visible browser back to the user.
export const CREDENTIAL_TAKEOVER_REASONS: readonly TakeoverReason[] = [
  "login",
  "password",
  "passkey",
  "mfa",
  "captcha",
];

// There is no field here that could hold a credential, so takeover state is safe
// to persist and to replay into a resumed session.
export interface TakeoverState {
  reason: TakeoverReason;
  instructions: string;
  startedAt: number;
  tabId: string;
  url: string;
}

export const takeoverStateSchema = z.strictObject({
  reason: takeoverReasonSchema,
  instructions: z.string().min(1).max(BROWSER_LIMITS.maxSummaryChars),
  startedAt: timestampSchema,
  tabId: identifierSchema,
  url: observedUrlSchema,
});

export function suppressesScreenshots(reason: TakeoverReason): boolean {
  return CREDENTIAL_TAKEOVER_REASONS.includes(reason);
}
