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
  DEFAULT_CONNECTION,
} from "@mu/profile-browser/profile";
import { browserRenderers } from "@mu/profile-browser/renderers";
import browserPackage from "../package.json";
import { type BrowserConnectionChoice, driverFactoryFor } from "./drivers.ts";

export const BROWSER_COMMAND = "mu-browser";
export const DEFAULT_BROWSER_PROFILE = "browser";

// Product-owned argv beyond the neutral surface flags.
export interface BrowserProductOptions {
  connection?: BrowserConnectionChoice | undefined;
  browser?: "chrome" | "edge" | "chromium" | undefined;
  browserProfile?: string | undefined;
  headless: boolean;
  documents: string[];
  allowedOrigins: string[];
  applicantProfile?: string | undefined;
  artifactRoot?: string | undefined;
}

export type BrowserProductCommand = "doctor";

const CONNECTIONS: BrowserConnectionChoice[] = ["extension", "persistent", "fake"];
const BROWSERS = ["chrome", "edge", "chromium"] as const;

export function emptyBrowserProductOptions(): BrowserProductOptions {
  return { headless: false, documents: [], allowedOrigins: [] };
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
        options.connection = "fake";
        break;
      case "--headless":
        options.headless = true;
        break;
      case "--connection":
        if (!value) errors.push("--connection requires a value");
        else if (!CONNECTIONS.includes(value as BrowserConnectionChoice)) {
          errors.push(`--connection expects ${CONNECTIONS.join(" | ")}, got "${value}"`);
        } else options.connection = value as BrowserConnectionChoice;
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
        if (!value) errors.push("--document requires a path");
        else options.documents.push(value);
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

  if (options.headless && (options.connection ?? DEFAULT_CONNECTION) === "extension") {
    errors.push(
      "--headless needs --connection persistent: the extension attaches to a browser you can see",
    );
  }
  if (options.browserProfile && (options.connection ?? DEFAULT_CONNECTION) !== "persistent") {
    errors.push("--browser-profile needs --connection persistent");
  }

  return { options, ...(command ? { command } : {}), errors };
}

export function browserProfileOptionsFrom(
  options: BrowserProductOptions | undefined,
  home?: string,
): BrowserProfileOptions {
  const product = options ?? emptyBrowserProductOptions();
  const choice = product.connection ?? DEFAULT_CONNECTION;
  return {
    ...(home === undefined ? {} : { home }),
    // The fake driver is a development connection over the extension contract; it
    // never claims to own a browser.
    connection: choice === "fake" ? "extension" : choice,
    browser: product.browser ?? DEFAULT_BROWSER,
    ...(product.headless ? { headless: true } : {}),
    ...(product.browserProfile ? { userDataDir: product.browserProfile } : {}),
    ...(product.documents.length > 0 ? { documents: [...product.documents] } : {}),
    ...(product.allowedOrigins.length > 0 ? { allowedOrigins: [...product.allowedOrigins] } : {}),
    ...(product.applicantProfile ? { applicantProfile: product.applicantProfile } : {}),
    ...(product.artifactRoot ? { artifactRoot: product.artifactRoot } : {}),
    factory: driverFactoryFor(choice),
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
  return browserProfile(browserProfileOptionsFrom(request.options, home));
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
    "--document": 1,
    "--allow-origin": 1,
    "--applicant-profile": 1,
    "--artifact-root": 1,
  },
  parseProductArgs: parseBrowserArgs,
  help: {
    usage: [usageLine(`${BROWSER_COMMAND} doctor`, "check the browser environment, no network")],
    options: [
      "      --connection <mode>  extension (default) | persistent | fake",
      "      --browser <name>     chrome (default) | edge | chromium",
      "      --browser-profile <name>",
      "                           Mu-owned profile to use with --connection persistent",
      "      --fake-browser       alias for --connection fake, a deterministic in-memory browser",
      "      --headless           run the Mu-owned browser without a window (persistent only)",
      "      --document <path>    authorize one local document for upload (repeatable)",
      "      --allow-origin <origin>",
      "                           approve an origin beyond the task's own (repeatable)",
      "      --applicant-profile <path>",
      "                           load saved answers and their provenance",
      "      --artifact-root <path>",
      "                           where screenshots, downloads and receipts are kept",
    ],
    permissionModes: BROWSER_PERMISSION_MODES.map((mode) => mode.id),
  },
  data: {
    configFile: (home) => browserConfigPath(home),
    modelCatalogFile: (home) => browserModelCatalogPath(home),
    sessionRoot: (home) => browserSessionsDir(home),
  },
  renderers: browserRenderers,
  // No direct shell and no file mentions: this product has no shell, and a
  // browser session is not rooted in a directory to mention files from.
  diagnostics: () => browserDiagnostics(undefined),
  transcriptPrefix: BROWSER_COMMAND,
  terminalTitle: (_context: ProductLaunchContext) => BROWSER_COMMAND,
  footerLocation: () => undefined,
};

export const HELP_TEXT = helpText(browserProduct);
