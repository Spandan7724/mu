import { z } from "zod";
import { identifierSchema, timestampSchema } from "./primitives.ts";

export type BrowserConnectionMode = "persistent";
export type BrowserFamily = "chrome" | "edge" | "chromium";

export type BrowserConnectionPhase =
  | "disconnected"
  | "connecting"
  | "ready"
  | "takeover"
  | "reconnecting"
  | "closing"
  | "failed";

export const browserConnectionModeSchema = z.literal("persistent");
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

// Emitted state. It carries opaque identifiers only: no cookies, CDP endpoint,
// browser handle, or profile contents.
export interface BrowserConnectionState {
  phase: BrowserConnectionPhase;
  mode: BrowserConnectionMode;
  browser: BrowserFamily;
  connectionId?: string | undefined;
  activeTabId?: string | undefined;
  message?: string | undefined;
  updatedAt: number;
}

export const browserConnectionStateSchema = z.strictObject({
  phase: browserConnectionPhaseSchema,
  mode: browserConnectionModeSchema,
  browser: browserFamilySchema,
  connectionId: identifierSchema.optional(),
  activeTabId: identifierSchema.optional(),
  message: z.string().max(2_000).optional(),
  updatedAt: timestampSchema,
});

export interface ConnectOptions {
  mode: BrowserConnectionMode;
  browser: BrowserFamily;
  userDataDir?: string | undefined;
  headless?: boolean | undefined;
}

export const connectOptionsInputSchema = z.strictObject({
  mode: browserConnectionModeSchema,
  browser: browserFamilySchema,
  userDataDir: z.string().min(1).optional(),
  headless: z.boolean().optional(),
});

export const connectOptionsSchema = connectOptionsInputSchema;

export type ConnectOptionsInput = z.input<typeof connectOptionsInputSchema>;

export function connectionSummary(state: BrowserConnectionState): string {
  const tab = state.activeTabId ? ` tab ${state.activeTabId}` : "";
  return `${state.browser} (${state.mode}) ${state.phase}${tab}`;
}
