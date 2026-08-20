import { z } from "zod";
import { identifierSchema, timestampSchema } from "./primitives.ts";
import { type BrowserSecret, browserSecretSchema } from "./secret.ts";

export type BrowserConnectionMode = "extension" | "persistent";
export type BrowserFamily = "chrome" | "edge" | "chromium";

export type BrowserConnectionPhase =
  | "disconnected"
  | "connecting"
  | "ready"
  | "takeover"
  | "reconnecting"
  | "closing"
  | "failed";

export const browserConnectionModeSchema = z.enum(["extension", "persistent"]);
export const browserFamilySchema = z.enum(["chrome", "edge", "chromium"]);
export const browserConnectionPhaseSchema = z.enum([
  "disconnected",
  "connecting",
  "ready",
  "takeover",
  "reconnecting",
  "closing",
  "failed",
]);

// Only `ready` accepts model-authored actions (ARCHITECTURE §7).
export const ACTIONABLE_PHASES: readonly BrowserConnectionPhase[] = ["ready"];

export function acceptsModelActions(phase: BrowserConnectionPhase): boolean {
  return ACTIONABLE_PHASES.includes(phase);
}

// Emitted state. It carries opaque identifiers only: no cookies, no extension
// token, no CDP endpoint, no Playwright handle.
export interface BrowserConnectionState {
  phase: BrowserConnectionPhase;
  mode: BrowserConnectionMode;
  browser: BrowserFamily;
  connectionId?: string | undefined;
  activeTabId?: string | undefined;
  message?: string | undefined;
  approvalRequired?: boolean | undefined;
  updatedAt: number;
}

export const browserConnectionStateSchema = z.strictObject({
  phase: browserConnectionPhaseSchema,
  mode: browserConnectionModeSchema,
  browser: browserFamilySchema,
  connectionId: identifierSchema.optional(),
  activeTabId: identifierSchema.optional(),
  message: z.string().max(2_000).optional(),
  approvalRequired: z.boolean().optional(),
  updatedAt: timestampSchema,
});

// `extensionToken` is a BrowserSecret rather than a string so ConnectOptions is not
// assignable to JsonValue and cannot be spread into anything that is.
export interface ConnectOptions {
  mode: BrowserConnectionMode;
  browser: BrowserFamily;
  userDataDir?: string | undefined;
  extensionToken?: BrowserSecret | undefined;
  headless?: boolean | undefined;
}

export const connectOptionsSchema = z
  .strictObject({
    mode: browserConnectionModeSchema,
    browser: browserFamilySchema,
    userDataDir: z.string().min(1).optional(),
    extensionToken: browserSecretSchema.optional(),
    headless: z.boolean().optional(),
  })
  .superRefine((options, ctx) => {
    if (options.mode === "extension") {
      if (options.userDataDir !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["userDataDir"],
          message: "extension mode attaches to the user's browser and owns no profile directory",
        });
      }
      if (options.headless === true) {
        ctx.addIssue({
          code: "custom",
          path: ["headless"],
          message: "extension mode attaches to a visible browser",
        });
      }
    } else if (options.extensionToken !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["extensionToken"],
        message: "an extension token is only meaningful for extension mode (BD27)",
      });
    }
  });

// Configuration-shaped input: the token arrives as a string and leaves boxed.
export type ConnectOptionsInput = z.input<typeof connectOptionsSchema>;

export function connectionSummary(state: BrowserConnectionState): string {
  const tab = state.activeTabId ? ` tab ${state.activeTabId}` : "";
  return `${state.browser} (${state.mode}) ${state.phase}${tab}`;
}
