// ARCHITECTURE §3. Mu always launches a dedicated persistent browser profile; no
// origin is approved beyond the task's. The product supplies a launch-directory file
// boundary; embedders can still provide a finite exact document set directly.
import { z } from "zod";
import type { BrowserFamily } from "../contracts/connection.ts";
import { normalizeOrigin } from "../contracts/primitives.ts";
import type { BrowserDriverFactory } from "../drivers/factory.ts";

export interface BrowserProfileOptions {
  browser?: BrowserFamily;
  // A Mu-owned profile *name*, resolved under the browser data root. It is never
  // a path to one of the user's own browser profiles (BD7).
  userDataDir?: string;
  documents?: string[];
  /** Product-supplied launch directory. Direct files here form the local-file boundary. */
  workspaceRoot?: string;
  applicantProfile?: string;
  allowedOrigins?: string[];
  artifactRoot?: string;
  headless?: boolean;
  // Product plumbing rather than user configuration.
  home?: string;
  dataRoot?: string;
  factory?: BrowserDriverFactory;
}

export const browserProfileOptionsSchema = z
  .strictObject({
    browser: z.enum(["chrome", "edge", "chromium"]).optional(),
    userDataDir: z.string().min(1).max(128).optional(),
    documents: z.array(z.string().min(1)).max(100).optional(),
    applicantProfile: z.string().min(1).optional(),
    allowedOrigins: z.array(z.string().min(1)).max(200).optional(),
    artifactRoot: z.string().min(1).optional(),
    headless: z.boolean().optional(),
  })
  .superRefine((options, ctx) => {
    for (const [index, origin] of (options.allowedOrigins ?? []).entries()) {
      if (normalizeOrigin(origin) === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["allowedOrigins", index],
          message: `"${origin}" is not an http(s) origin`,
        });
      }
    }
  });

export interface ResolvedBrowserProfileOptions {
  connection: "persistent";
  browser: BrowserFamily;
  headless: boolean;
  userDataDir: string | undefined;
  documents: string[];
  workspaceRoot: string | undefined;
  applicantProfile: string | undefined;
  allowedOrigins: string[];
  artifactRoot: string | undefined;
}

export const DEFAULT_BROWSER: BrowserFamily = "chrome";

export function resolveBrowserProfileOptions(
  options: BrowserProfileOptions = {},
): ResolvedBrowserProfileOptions {
  const { home, dataRoot, factory, workspaceRoot, ...declared } = options;
  void home;
  void dataRoot;
  void factory;
  const parsed = browserProfileOptionsSchema.parse(declared);
  return {
    connection: "persistent",
    browser: parsed.browser ?? DEFAULT_BROWSER,
    headless: parsed.headless ?? false,
    userDataDir: parsed.userDataDir ?? "default",
    documents: [...(parsed.documents ?? [])],
    workspaceRoot,
    applicantProfile: parsed.applicantProfile,
    // Deduplicated and normalized, so a rule can never be widened by writing the
    // same origin two different ways.
    allowedOrigins: [
      ...new Set((parsed.allowedOrigins ?? []).map((origin) => normalizeOrigin(origin) as string)),
    ],
    artifactRoot: parsed.artifactRoot,
  };
}
