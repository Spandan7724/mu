import { z } from "zod";
import { BROWSER_LIMITS } from "./json.ts";
import { identifierSchema, observedUrlSchema, originSchema, webUrlSchema } from "./primitives.ts";

// Tab and frame ids exist only for the current driver connection. They are never
// durable session identity.
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  origin?: string | undefined;
  active: boolean;
  attached: boolean;
}

export interface BrowserFrame {
  id: string;
  parentId?: string | undefined;
  name?: string | undefined;
  url: string;
  origin?: string | undefined;
  crossOrigin: boolean;
}

export const browserTabSchema = z.strictObject({
  id: identifierSchema,
  title: z.string().max(BROWSER_LIMITS.maxElementTextChars),
  url: observedUrlSchema,
  origin: originSchema.optional(),
  active: z.boolean(),
  attached: z.boolean(),
});

export const browserFrameSchema = z.strictObject({
  id: identifierSchema,
  parentId: identifierSchema.optional(),
  name: z.string().max(BROWSER_LIMITS.maxElementTextChars).optional(),
  url: observedUrlSchema,
  origin: originSchema.optional(),
  crossOrigin: z.boolean(),
});

export type TabRequest =
  | { kind: "list" }
  | { kind: "select"; tabId: string }
  | { kind: "close"; tabId: string }
  | { kind: "open"; url?: string | undefined };

export const tabRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list") }),
  z.strictObject({ kind: z.literal("select"), tabId: identifierSchema }),
  z.strictObject({ kind: z.literal("close"), tabId: identifierSchema }),
  z.strictObject({ kind: z.literal("open"), url: webUrlSchema.optional() }),
]);

export interface TabOutcome {
  ok: boolean;
  tabs: BrowserTab[];
  activeTabId?: string | undefined;
  message: string;
}

export const tabOutcomeSchema = z
  .strictObject({
    ok: z.boolean(),
    tabs: z.array(browserTabSchema).max(BROWSER_LIMITS.maxTabs),
    activeTabId: identifierSchema.optional(),
    message: z.string().min(1).max(2_000),
  })
  .superRefine((outcome, ctx) => {
    const ids = new Set<string>();
    for (const tab of outcome.tabs) {
      if (ids.has(tab.id)) {
        ctx.addIssue({ code: "custom", path: ["tabs"], message: `duplicate tab id ${tab.id}` });
      }
      ids.add(tab.id);
    }
    const active = outcome.tabs.filter((tab) => tab.active);
    if (active.length > 1) {
      ctx.addIssue({ code: "custom", path: ["tabs"], message: "at most one tab may be active" });
    }
    if (outcome.activeTabId !== undefined && !ids.has(outcome.activeTabId)) {
      ctx.addIssue({
        code: "custom",
        path: ["activeTabId"],
        message: "activeTabId must name a listed tab",
      });
    }
    const activeTab = active[0];
    if (activeTab && outcome.activeTabId !== undefined && activeTab.id !== outcome.activeTabId) {
      ctx.addIssue({
        code: "custom",
        path: ["activeTabId"],
        message: "activeTabId must match the tab flagged active",
      });
    }
  });

export function attachedTabs(tabs: readonly BrowserTab[]): BrowserTab[] {
  return tabs.filter((tab) => tab.attached);
}
