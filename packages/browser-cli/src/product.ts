import type {
  ProductArgResult,
  ProductDescriptor,
  ProductLaunchContext,
  ProfileRequest,
} from "@mu/cli-runtime";
import { helpText, usageLine } from "@mu/cli-runtime";
import type { Profile } from "@mu/core";
import {
  BROWSER_PERMISSION_MODES,
  type BrowserProfileOptions,
  browserConfigPath,
  browserDataLayout,
  browserModelCatalogPath,
  browserProfile,
  browserSessionsDir,
  DEFAULT_BROWSER,
} from "@mu/profile-browser/profile";
import { browserRenderers } from "@mu/profile-browser/renderers";
import browserPackage from "../package.json";
import { type BrowserConnectionChoice, driverFactoryFor } from "./drivers.ts";

export const BROWSER_COMMAND = "mu-browser";
export const DEFAULT_BROWSER_PROFILE = "browser";

// Product-owned argv beyond the neutral surface flags.
export interface BrowserProductOptions {
  fakeBrowser: boolean;
  browser?: "chrome" | "edge" | "chromium" | undefined;
  browserProfile?: string | undefined;
  headless: boolean;
  allowedOrigins: string[];
  applicantProfile?: string | undefined;
  artifactRoot?: string | undefined;
}

export type BrowserProductCommand = "doctor";

const BROWSERS = ["chrome", "edge", "chromium"] as const;

export function emptyBrowserProductOptions(): BrowserProductOptions {
  return { fakeBrowser: false, headless: false, allowedOrigins: [] };
}

function parseBrowserArgs(
  claimed: readonly (readonly string[])[],
): ProductArgResult<BrowserProductOptions> {
  const options = emptyBrowserProductOptions();
  const errors: string[] = [];
  let command: BrowserProductCommand | undefined;

  for (const group of claimed) {
    const [token, value] = group;
    switch (token) {
      case "doctor":
        command = "doctor";
        break;
      case "--fake-browser":
        options.fakeBrowser = true;
        break;
      case "--headless":
        options.headless = true;
        break;
      case "--connection":
        errors.push(
          "--connection was removed; Mu now always launches its own persistent browser (use --fake-browser only for testing)",
        );
        break;
      case "--browser":
        if (!value) errors.push("--browser requires a value");
        else if (!BROWSERS.includes(value as (typeof BROWSERS)[number])) {
          errors.push(`--browser expects ${BROWSERS.join(" | ")}, got "${value}"`);
        } else options.browser = value as (typeof BROWSERS)[number];
        break;
      case "--browser-profile":
        if (!value) errors.push("--browser-profile requires a name");
        else options.browserProfile = value;
        break;
      case "--document":
        errors.push(
          "--document was removed; put the file directly in the directory where mu-browser starts",
        );
        break;
      case "--allow-origin":
        if (!value) errors.push("--allow-origin requires an origin");
        else options.allowedOrigins.push(value);
        break;
      case "--applicant-profile":
        if (!value) errors.push("--applicant-profile requires a path");
        else options.applicantProfile = value;
        break;
      case "--artifact-root":
        if (!value) errors.push("--artifact-root requires a path");
        else options.artifactRoot = value;
        break;
    }
  }

  return { options, ...(command ? { command } : {}), errors };
}

export function browserProfileOptionsFrom(
  options: BrowserProductOptions | undefined,
  home?: string,
  cwd?: string,
): BrowserProfileOptions {
  const product = options ?? emptyBrowserProductOptions();
  const choice: BrowserConnectionChoice = product.fakeBrowser ? "fake" : "persistent";
  return {
    ...(home === undefined ? {} : { home }),
    browser: product.browser ?? DEFAULT_BROWSER,
    ...(product.headless ? { headless: true } : {}),
    ...(product.browserProfile ? { userDataDir: product.browserProfile } : {}),
    ...(cwd === undefined ? {} : { workspaceRoot: cwd }),
    ...(product.allowedOrigins.length > 0 ? { allowedOrigins: [...product.allowedOrigins] } : {}),
    ...(product.applicantProfile ? { applicantProfile: product.applicantProfile } : {}),
    ...(product.artifactRoot ? { artifactRoot: product.artifactRoot } : {}),
    factory: driverFactoryFor(choice, home),
  };
}

// `--profile` selects a Mu profile, and this product ships exactly one. A name it
// does not know is refused rather than silently falling back to something else.
export async function resolveBrowserProfile(
  request: ProfileRequest<BrowserProductOptions>,
  home?: string,
): Promise<Profile> {
  const name = request.name ?? DEFAULT_BROWSER_PROFILE;
  if (name !== DEFAULT_BROWSER_PROFILE) {
    throw new Error(`Unknown profile "${name}". mu-browser ships the "browser" profile.`);
  }
  return browserProfile(browserProfileOptionsFrom(request.options, home, request.cwd));
}

export function browserDiagnostics(home?: string): string[] {
  const layout = browserDataLayout(home);
  return [`browser data root: ${layout.root}`];
}

// `home` exists so a test can give the product a scratch data root; the shipped
// descriptor below takes none and resolves against the user's real home.
export function createBrowserProduct(
  config: { home?: string } = {},
): ProductDescriptor<BrowserProductOptions> {
  return { ...browserProduct, ...homeBoundParts(config.home) };
}

function homeBoundParts(
  home: string | undefined,
): Partial<ProductDescriptor<BrowserProductOptions>> {
  if (home === undefined) return {};
  return {
    createProfile: (request) => resolveBrowserProfile(request, home),
    data: {
      configFile: (override) => browserConfigPath(override ?? home),
      modelCatalogFile: (override) => browserModelCatalogPath(override ?? home),
      sessionRoot: (override) => browserSessionsDir(override ?? home),
    },
    diagnostics: () => browserDiagnostics(home),
  };
}

export const browserProduct: ProductDescriptor<BrowserProductOptions> = {
  id: "mu-browser",
  displayName: "Mu Browser",
  commandName: BROWSER_COMMAND,
  version: browserPackage.version,
  tagline: "a general-purpose browser automation agent",
  bannerTagline: "an agent that drives your browser",
  defaultProfile: DEFAULT_BROWSER_PROFILE,
  createProfile: (request) => resolveBrowserProfile(request),
  argTokens: {
    doctor: 0,
    "--connection": 1,
    "--browser": 1,
    "--browser-profile": 1,
    "--fake-browser": 0,
    "--headless": 0,
    // Consumed only to return an actionable migration error. It grants nothing.
    "--document": 1,
    "--allow-origin": 1,
    "--applicant-profile": 1,
    "--artifact-root": 1,
  },
  parseProductArgs: parseBrowserArgs,
  help: {
    usage: [usageLine(`${BROWSER_COMMAND} doctor`, "check the browser environment, no network")],
    options: [
      "      --browser <name>     chrome (default) | edge | chromium",
      "      --browser-profile <name>",
      "                           Mu-owned persistent profile to use (default: default)",
      "      --fake-browser       use a deterministic in-memory browser for testing",
      "      --headless           run the Mu-owned browser without a window",
      "                           uploadable files come from the launch directory",
      "      --allow-origin <origin>",
      "                           approve an origin beyond the task's own (repeatable)",
      "      --applicant-profile <path>",
      "                           load saved answers and their provenance",
      "      --artifact-root <path>",
      "                           where screenshots, downloads and receipts are kept",
    ],
    permissionModes: BROWSER_PERMISSION_MODES.map((mode) => mode.id),
    allowAll: "alias for --permission-mode yolo (no permission prompts)",
  },
  data: {
    configFile: (home) => browserConfigPath(home),
    modelCatalogFile: (home) => browserModelCatalogPath(home),
    sessionRoot: (home) => browserSessionsDir(home),
  },
  renderers: browserRenderers,
  // No direct shell. The browser profile receives cwd as a file-access boundary,
  // but paths remain runtime-only and are never rendered as @-mentions.
  diagnostics: () => browserDiagnostics(undefined),
  transcriptPrefix: BROWSER_COMMAND,
  terminalTitle: (_context: ProductLaunchContext) => BROWSER_COMMAND,
  footerLocation: () => undefined,
};

export const HELP_TEXT = helpText(browserProduct);
