// ARCHITECTURE §3. The defaults are the safe ones: the extension bridge (so the
// user approves a visible tab rather than Mu launching something), no origin
// approved beyond the task's, and nothing pre-authorized for upload.
import { z } from "zod";
import type { BrowserConnectionMode, BrowserFamily } from "../contracts/connection.ts";
import { normalizeOrigin } from "../contracts/primitives.ts";
import type { BrowserSecret } from "../contracts/secret.ts";
import type { BrowserDriverFactory } from "../drivers/factory.ts";

export interface BrowserProfileOptions {
  connection?: BrowserConnectionMode;
  browser?: BrowserFamily;
  // A Mu-owned profile *name*, resolved under the browser data root. It is never
  // a path to one of the user's own browser profiles (BD7).
  userDataDir?: string;
  documents?: string[];
  applicantProfile?: string;
  allowedOrigins?: string[];
  artifactRoot?: string;
  headless?: boolean;
  // Product plumbing rather than user configuration.
  home?: string;
  dataRoot?: string;
  factory?: BrowserDriverFactory;
  extensionToken?: BrowserSecret;
}

export const browserProfileOptionsSchema = z
  .strictObject({
    connection: z.enum(["extension", "persistent"]).optional(),
    browser: z.enum(["chrome", "edge", "chromium"]).optional(),
    userDataDir: z.string().min(1).max(128).optional(),
    documents: z.array(z.string().min(1)).max(100).optional(),
    applicantProfile: z.string().min(1).optional(),
    allowedOrigins: z.array(z.string().min(1)).max(200).optional(),
    artifactRoot: z.string().min(1).optional(),
    headless: z.boolean().optional(),
  })
  .superRefine((options, ctx) => {
    if (options.connection === "extension" || options.connection === undefined) {
      if (options.headless === true) {
        ctx.addIssue({
          code: "custom",
          path: ["headless"],
          message: "extension mode attaches to a browser you can see; it cannot run headless",
        });
      }
      if (options.userDataDir !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["userDataDir"],
          message: "extension mode attaches to your own browser and owns no profile directory",
        });
      }
    }
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
  connection: BrowserConnectionMode;
  browser: BrowserFamily;
  headless: boolean;
  userDataDir: string | undefined;
  documents: string[];
  applicantProfile: string | undefined;
  allowedOrigins: string[];
  artifactRoot: string | undefined;
  extensionToken: BrowserSecret | undefined;
}

export const DEFAULT_CONNECTION: BrowserConnectionMode = "extension";
export const DEFAULT_BROWSER: BrowserFamily = "chrome";

export function resolveBrowserProfileOptions(
  options: BrowserProfileOptions = {},
): ResolvedBrowserProfileOptions {
  const { home, dataRoot, factory, extensionToken, ...declared } = options;
  void home;
  void dataRoot;
  void factory;
  const parsed = browserProfileOptionsSchema.parse(declared);
  const connection = parsed.connection ?? DEFAULT_CONNECTION;
  if (connection !== "extension" && extensionToken !== undefined) {
    throw new Error("an extension token is only meaningful for extension mode (BD27)");
  }
  return {
    connection,
    browser: parsed.browser ?? DEFAULT_BROWSER,
    headless: parsed.headless ?? false,
    userDataDir: connection === "persistent" ? (parsed.userDataDir ?? "default") : undefined,
    documents: [...(parsed.documents ?? [])],
    applicantProfile: parsed.applicantProfile,
    // Deduplicated and normalized, so a rule can never be widened by writing the
    // same origin two different ways.
    allowedOrigins: [
      ...new Set((parsed.allowedOrigins ?? []).map((origin) => normalizeOrigin(origin) as string)),
    ],
    artifactRoot: parsed.artifactRoot,
    extensionToken,
  };
}
