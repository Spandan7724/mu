import { z } from "zod";
import { BROWSER_LIMITS } from "./json.ts";
import {
  type ElementRefId,
  elementRefIdSchema,
  identifierSchema,
  observedUrlSchema,
  originSchema,
  timestampSchema,
} from "./primitives.ts";
import { isCredentialLabel } from "./redaction.ts";
import { REDACTED } from "./secret.ts";
import {
  type BrowserFrame,
  type BrowserTab,
  browserFrameSchema,
  browserTabSchema,
} from "./tabs.ts";

export type ObservationRevision = number;

export const observationRevisionSchema: z.ZodType<ObservationRevision> = z
  .number()
  .int()
  .nonnegative();

// A ref without its tab and revision is meaningless, so the two travel with it and
// no API in this package accepts a bare ref string in its place.
export interface BrowserElementRef {
  ref: ElementRefId;
  revision: ObservationRevision;
  tabId: string;
  frameId?: string | undefined;
}

export const browserElementRefSchema = z.strictObject({
  ref: elementRefIdSchema,
  revision: observationRevisionSchema,
  tabId: identifierSchema,
  frameId: identifierSchema.optional(),
});

export type BrowserRisk =
  | "password"
  | "authentication"
  | "captcha"
  | "personal-data"
  | "file-upload"
  | "submit"
  | "send"
  | "purchase"
  | "delete"
  | "consent"
  | "account-change"
  | "download";

export const browserRiskSchema = z.enum([
  "password",
  "authentication",
  "captcha",
  "personal-data",
  "file-upload",
  "submit",
  "send",
  "purchase",
  "delete",
  "consent",
  "account-change",
  "download",
]);

// Risks that BD12 routes to browser_submit rather than browser_act.
export const COMMITMENT_RISKS: readonly BrowserRisk[] = [
  "submit",
  "send",
  "purchase",
  "delete",
  "consent",
  "account-change",
];

// Risks that BD14 routes to human takeover rather than to any tool.
export const TAKEOVER_RISKS: readonly BrowserRisk[] = ["password", "authentication", "captcha"];

export interface BrowserElementOption {
  label: string;
  value?: string | undefined;
  selected?: boolean | undefined;
}

export interface BrowserElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserElement extends BrowserElementRef {
  role?: string | undefined;
  name?: string | undefined;
  label?: string | undefined;
  placeholder?: string | undefined;
  value?: string | undefined;
  description?: string | undefined;
  checked?: boolean | "mixed" | undefined;
  selected?: boolean | undefined;
  disabled?: boolean | undefined;
  readonly?: boolean | undefined;
  required?: boolean | undefined;
  inputType?: string | undefined;
  options?: BrowserElementOption[] | undefined;
  risk?: BrowserRisk[] | undefined;
  /** Viewport-relative geometry from the same accessibility snapshot as this ref. */
  box?: BrowserElementBox | undefined;
}

const text = z.string().max(BROWSER_LIMITS.maxElementTextChars);

export function isCredentialElement(element: BrowserElement): boolean {
  if (element.inputType === "password") return true;
  if (element.risk?.some((risk) => risk === "password" || risk === "authentication")) return true;
  return (
    isCredentialLabel(element.name) ||
    isCredentialLabel(element.label) ||
    isCredentialLabel(element.placeholder) ||
    isCredentialLabel(element.description)
  );
}

export const browserElementSchema = z
  .strictObject({
    ref: elementRefIdSchema,
    revision: observationRevisionSchema,
    tabId: identifierSchema,
    frameId: identifierSchema.optional(),
    role: z.string().max(64).optional(),
    name: text.optional(),
    label: text.optional(),
    placeholder: text.optional(),
    value: text.optional(),
    description: text.optional(),
    checked: z.union([z.boolean(), z.literal("mixed")]).optional(),
    selected: z.boolean().optional(),
    disabled: z.boolean().optional(),
    readonly: z.boolean().optional(),
    required: z.boolean().optional(),
    inputType: z.string().max(64).optional(),
    options: z
      .array(
        z.strictObject({
          label: text,
          value: text.optional(),
          selected: z.boolean().optional(),
        }),
      )
      .max(BROWSER_LIMITS.maxOptionsPerElement)
      .optional(),
    risk: z.array(browserRiskSchema).max(browserRiskSchema.options.length).optional(),
    box: z
      .strictObject({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .superRefine((element, ctx) => {
    if (!isCredentialElement(element)) return;
    if (element.value !== undefined && element.value !== REDACTED) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "credential field values are never observed (BD14)",
      });
    }
    if (element.options !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "credential fields carry no option values",
      });
    }
  });

export interface BrowserViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  documentWidth?: number | undefined;
  documentHeight?: number | undefined;
}

export interface BrowserScreenshot {
  mimeType: "image/png" | "image/jpeg";
  data: string;
  // Literal: a screenshot returned to the model is always droppable from context.
  evictable: true;
}

export type ScreenshotOmissionReason =
  | "credential"
  | "too-large"
  | "unsupported-format"
  | "unavailable";

export interface BrowserObservationCoverage {
  /** Zero-based range in this revision's semantic ordering. */
  start: number;
  end: number;
  /** Number of actionable controls in the bounded private source. */
  total: number;
  /** Relevance projections are for discovery and do not prove document order. */
  order: "document" | "relevance";
  hasMore: boolean;
  /** Session-issued and revision-bound. Never a selector or browser ref. */
  nextCursor?: string | undefined;
  /** The browser source exceeded Mu's private backstop, so `total` is not page-complete. */
  sourceIncomplete: boolean;
}

export interface BrowserObservation {
  connectionId: string;
  tab: BrowserTab;
  revision: ObservationRevision;
  observedAt: number;
  title: string;
  url: string;
  origin?: string | undefined;
  viewport: BrowserViewport;
  frames: BrowserFrame[];
  summary: string;
  snapshot: string;
  elements: BrowserElement[];
  risks: BrowserRisk[];
  screenshot?: BrowserScreenshot | undefined;
  screenshotOmitted?: ScreenshotOmissionReason | undefined;
  truncated?: { nodesOmitted: number; textCharsOmitted: number } | undefined;
  /** INTERNAL driver continuation metadata; never itself used as a model cursor. */
  sourceHasMore?: boolean | undefined;
  /** Stable fingerprint of the canonical semantic source for fail-closed continuation. */
  sourceRevision?: string | undefined;
  coverage?: BrowserObservationCoverage | undefined;
}

export const browserObservationSchema = z
  .strictObject({
    connectionId: identifierSchema,
    tab: browserTabSchema,
    revision: observationRevisionSchema,
    observedAt: timestampSchema,
    title: text,
    url: observedUrlSchema,
    origin: originSchema.optional(),
    viewport: z.strictObject({
      width: z.number().int().nonnegative(),
      height: z.number().int().nonnegative(),
      scrollX: z.number().int(),
      scrollY: z.number().int(),
      documentWidth: z.number().int().nonnegative().optional(),
      documentHeight: z.number().int().nonnegative().optional(),
    }),
    frames: z.array(browserFrameSchema).max(BROWSER_LIMITS.maxFrames),
    summary: z.string().max(BROWSER_LIMITS.maxSummaryChars),
    snapshot: z.string().max(BROWSER_LIMITS.maxSnapshotChars),
    elements: z.array(browserElementSchema).max(BROWSER_LIMITS.maxElements),
    risks: z.array(browserRiskSchema).max(browserRiskSchema.options.length),
    screenshot: z
      .strictObject({
        mimeType: z.enum(["image/png", "image/jpeg"]),
        data: z.string().max(BROWSER_LIMITS.maxScreenshotBase64Chars),
        evictable: z.literal(true),
      })
      .optional(),
    screenshotOmitted: z
      .enum(["credential", "too-large", "unsupported-format", "unavailable"])
      .optional(),
    truncated: z
      .strictObject({
        nodesOmitted: z.number().int().nonnegative(),
        textCharsOmitted: z.number().int().nonnegative(),
      })
      .optional(),
    sourceHasMore: z.boolean().optional(),
    sourceRevision: z.string().min(1).max(256).optional(),
    coverage: z
      .strictObject({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        order: z.enum(["document", "relevance"]),
        hasMore: z.boolean(),
        nextCursor: identifierSchema.optional(),
        sourceIncomplete: z.boolean(),
      })
      .superRefine((coverage, ctx) => {
        if (coverage.end < coverage.start || coverage.end > coverage.total) {
          ctx.addIssue({ code: "custom", message: "observation coverage range is invalid" });
        }
        if (coverage.hasMore !== (coverage.end < coverage.total || coverage.sourceIncomplete)) {
          ctx.addIssue({
            code: "custom",
            path: ["hasMore"],
            message: "hasMore must match coverage",
          });
        }
        if (coverage.nextCursor !== undefined && coverage.end >= coverage.total) {
          ctx.addIssue({
            code: "custom",
            path: ["nextCursor"],
            message: "a continuation cursor requires another indexed window",
          });
        }
      })
      .optional(),
  })
  .superRefine((observation, ctx) => {
    if (observation.screenshot !== undefined && observation.screenshotOmitted !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["screenshotOmitted"],
        message: "an observation cannot attach and omit the same screenshot",
      });
    }
    const frameIds = new Set(observation.frames.map((frame) => frame.id));
    const refs = new Set<string>();
    observation.elements.forEach((element, index) => {
      if (element.tabId !== observation.tab.id) {
        ctx.addIssue({
          code: "custom",
          path: ["elements", index, "tabId"],
          message: "element refs belong to the observed tab",
        });
      }
      if (element.revision !== observation.revision) {
        ctx.addIssue({
          code: "custom",
          path: ["elements", index, "revision"],
          message: "element refs carry the revision that produced them",
        });
      }
      if (element.frameId !== undefined && !frameIds.has(element.frameId)) {
        ctx.addIssue({
          code: "custom",
          path: ["elements", index, "frameId"],
          message: "element frame must be one of the observed frames",
        });
      }
      if (refs.has(element.ref)) {
        ctx.addIssue({
          code: "custom",
          path: ["elements", index, "ref"],
          message: `duplicate element ref ${element.ref}`,
        });
      }
      refs.add(element.ref);
    });
    for (const frame of observation.frames) {
      if (frame.parentId !== undefined && !frameIds.has(frame.parentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["frames"],
          message: `frame ${frame.id} names an unknown parent`,
        });
      }
    }
    const declared = new Set(observation.risks);
    for (const element of observation.elements) {
      for (const risk of element.risk ?? []) {
        if (!declared.has(risk)) {
          ctx.addIssue({
            code: "custom",
            path: ["risks"],
            message: `element risk ${risk} is missing from the observation risk summary`,
          });
        }
      }
    }
  });

export type RefValidity = "current" | "wrong-tab" | "stale-revision" | "unknown-frame" | "unknown";

// BD9/ARCHITECTURE §8: a ref is judged against the observation that is current, and
// a failure is reported as such. It is never repaired by index, position or guess.
export function refValidity(ref: BrowserElementRef, observation: BrowserObservation): RefValidity {
  if (ref.tabId !== observation.tab.id) return "wrong-tab";
  if (ref.revision !== observation.revision) return "stale-revision";
  if (ref.frameId !== undefined && !observation.frames.some((f) => f.id === ref.frameId)) {
    return "unknown-frame";
  }
  return observation.elements.some((element) => element.ref === ref.ref) ? "current" : "unknown";
}

export function isRefCurrent(ref: BrowserElementRef, observation: BrowserObservation): boolean {
  return refValidity(ref, observation) === "current";
}

export function refValidityMessage(validity: RefValidity): string {
  switch (validity) {
    case "current":
      return "reference is current";
    case "wrong-tab":
      return "reference belongs to a different tab; observe the tab you intend to act on";
    case "stale-revision":
      return "the page changed since this reference was created; observe again";
    case "unknown-frame":
      return "the frame holding this reference is gone; observe again";
    case "unknown":
      return "this element is no longer present; observe again";
  }
}

export function sameElementRef(a: BrowserElementRef, b: BrowserElementRef): boolean {
  return a.ref === b.ref && a.tabId === b.tabId && a.revision === b.revision;
}

export function elementRefOf(element: BrowserElement): BrowserElementRef {
  return {
    ref: element.ref,
    revision: element.revision,
    tabId: element.tabId,
    ...(element.frameId === undefined ? {} : { frameId: element.frameId }),
  };
}
