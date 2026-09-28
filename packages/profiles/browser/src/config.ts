import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { BrowserLauncher } from "./browser/connect.ts";
import type { Size } from "./browser/launch.ts";

export interface BrowserProfileOptions {
  browserProfile?: string;
  connect?: "managed" | "cdp";
  cdpUrl?: string;
  executable?: string;
  channel?: "chrome" | "chromium" | "brave" | "edge";
  headless?: boolean;
  vision?: "auto" | "on" | "off";
  viewport?: Size;
  keepOpen?: boolean;
  downloadsDir?: string;
  allowedHosts?: string[];
  blockedHosts?: string[];
  home?: string;
  launcher?: BrowserLauncher;
}

export interface ResolvedBrowserOptions {
  browserProfile: string;
  connect: "managed" | "cdp";
  cdpUrl?: string;
  executable?: string;
  channel?: "chrome" | "chromium" | "brave" | "edge";
  headless: boolean;
  vision: "auto" | "on" | "off";
  viewport: Size;
  keepOpen: boolean;
  downloadsDir: string;
  allowedHosts: string[];
  blockedHosts: string[];
  home: string;
  userDataDir: string;
  launcher?: BrowserLauncher;
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const browserConfigSchema = z
  .object({
    browserProfile: z.string().regex(PROFILE_NAME).optional(),
    connect: z.enum(["managed", "cdp"]).optional(),
    cdpUrl: z.string().min(1).optional(),
    executable: z.string().min(1).optional(),
    channel: z.enum(["chrome", "chromium", "brave", "edge"]).optional(),
    headless: z.boolean().optional(),
    vision: z.enum(["auto", "on", "off"]).optional(),
    viewport: z
      .object({ width: z.number().int().min(200), height: z.number().int().min(200) })
      .optional(),
    keepOpen: z.boolean().optional(),
    downloadsDir: z.string().min(1).optional(),
    allowedHosts: z.array(z.string().min(1)).optional(),
    blockedHosts: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function readBrowserConfig(
  home: string,
  onWarning: (message: string) => void,
): z.infer<typeof browserConfigSchema> {
  const path = join(home, ".mu", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      onWarning(
        `Invalid user config at ${path}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return {};
  }
  const section =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).browser : undefined;
  if (section === undefined) return {};
  const result = browserConfigSchema.safeParse(section);
  if (!result.success) {
    onWarning(
      `Invalid user config at ${path}: ${result.error.issues
        .map((issue) => `browser.${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
    return {};
  }
  return result.data;
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

// Config file < explicit options (CLI flags and SDK options arrive as options).
export function resolveBrowserOptions(
  options: BrowserProfileOptions = {},
  onWarning: (message: string) => void = () => {},
): ResolvedBrowserOptions {
  const home = resolve(options.home ?? homedir());
  const merged = { ...readBrowserConfig(home, onWarning), ...defined(options) };
  const browserProfile = merged.browserProfile ?? "default";
  if (!PROFILE_NAME.test(browserProfile)) {
    throw new Error(
      `Invalid browser profile name "${browserProfile}": use letters, digits, ".", "_" or "-".`,
    );
  }
  const connect = merged.connect ?? (merged.cdpUrl ? "cdp" : "managed");
  if (connect === "cdp" && !merged.cdpUrl) {
    throw new Error('Browser connect mode "cdp" needs a cdpUrl (--cdp <url>).');
  }
  return {
    browserProfile,
    connect,
    ...(merged.cdpUrl ? { cdpUrl: merged.cdpUrl } : {}),
    ...(merged.executable ? { executable: merged.executable } : {}),
    ...(merged.channel ? { channel: merged.channel } : {}),
    headless: merged.headless ?? false,
    vision: merged.vision ?? "auto",
    viewport: merged.viewport ?? { width: 1280, height: 800 },
    keepOpen: merged.keepOpen ?? true,
    downloadsDir: resolve(merged.downloadsDir ?? join(home, ".mu", "browser", "downloads")),
    allowedHosts: merged.allowedHosts ?? [],
    blockedHosts: merged.blockedHosts ?? [],
    home,
    userDataDir: join(home, ".mu", "browser", "profiles", browserProfile),
    ...(options.launcher ? { launcher: options.launcher } : {}),
  };
}
