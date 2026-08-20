import { z } from "zod";
import {
  type BrowserConnectionMode,
  type BrowserConnectionPhase,
  type BrowserFamily,
  browserConnectionModeSchema,
  browserConnectionPhaseSchema,
  browserFamilySchema,
} from "./connection.ts";
import { BROWSER_LIMITS } from "./json.ts";
import { type ObservationRevision, observationRevisionSchema } from "./observation.ts";
import {
  type AuthorizedDocumentId,
  authorizedDocumentIdSchema,
  identifierSchema,
  observedUrlSchema,
  originSchema,
} from "./primitives.ts";
import { type TakeoverState, takeoverStateSchema } from "./takeover.ts";

export interface BrowserCarryoverConnection {
  mode: BrowserConnectionMode;
  browser: BrowserFamily;
  phase: BrowserConnectionPhase;
}

export interface BrowserCarryoverField {
  label: string;
  factId?: string | undefined;
  origin: string;
}

// Survives compaction, so it is plain JSON and secret-free by construction: no
// values, only labels, ids and origins.
export interface BrowserCarryover {
  connection: BrowserCarryoverConnection;
  active?:
    | {
        tabId: string;
        url: string;
        origin?: string | undefined;
        title: string;
        revision: ObservationRevision;
      }
    | undefined;
  allowedOrigins: string[];
  completedSteps: string[];
  outstandingSteps: string[];
  filledFields: BrowserCarryoverField[];
  unresolvedQuestions: string[];
  uploadedDocumentIds: AuthorizedDocumentId[];
  takeover?: TakeoverState | undefined;
  receiptId?: string | undefined;
}

const step = z.string().min(1).max(BROWSER_LIMITS.maxSummaryChars);

export const browserCarryoverSchema = z.strictObject({
  connection: z.strictObject({
    mode: browserConnectionModeSchema,
    browser: browserFamilySchema,
    phase: browserConnectionPhaseSchema,
  }),
  active: z
    .strictObject({
      tabId: identifierSchema,
      url: observedUrlSchema,
      origin: originSchema.optional(),
      title: z.string().max(BROWSER_LIMITS.maxElementTextChars),
      revision: observationRevisionSchema,
    })
    .optional(),
  allowedOrigins: z.array(originSchema).max(200),
  completedSteps: z.array(step).max(500),
  outstandingSteps: z.array(step).max(500),
  filledFields: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(256),
        factId: identifierSchema.optional(),
        origin: originSchema,
      }),
    )
    .max(1_000),
  unresolvedQuestions: z.array(step).max(500),
  uploadedDocumentIds: z.array(authorizedDocumentIdSchema).max(100),
  takeover: takeoverStateSchema.optional(),
  receiptId: identifierSchema.optional(),
});
