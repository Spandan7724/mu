import { describe, expect, test } from "bun:test";
import { isBrowserDriverError } from "../../contracts/driver.ts";
import {
  assertSupportedServer,
  BROWSER_EXECUTABLE_ENV,
  browserExecutableCandidates,
  discoverBrowserExecutable,
  isSnapConfined,
  PINNED_SERVER_VERSION,
  PINNED_SIDECAR_VERSION,
  persistentSidecarArgs,
  resolveSidecar,
  SIDECAR_CLI_ENV,
  SIDECAR_RUNTIME_ENV,
} from "./sidecar.ts";

const OUTPUT = "/home/u/.mu/browser/artifacts/sidecar";

function thrown(body: () => unknown): unknown {
  try {
    body();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("the bridge is pinned, never fetched", () => {
  test("the pinned versions are the ones B0 qualified", () => {
    expect(PINNED_SIDECAR_VERSION).toBe("0.0.79");
    expect(PINNED_SERVER_VERSION).toBe("1.63.0-alpha-2026-08-05");
  });

  test("a server reporting another build fails with update instructions", () => {
    const error = thrown(() => assertSupportedServer({ name: "Playwright", version: "1.2.3" }));
    expect(isBrowserDriverError(error) && error.code).toBe("protocol-mismatch");
    expect(String(error)).toContain("Reinstall @mu-agent/browser");
  });

  test("a server that does not identify itself is a mismatch, not a maybe", () => {
    expect(() => assertSupportedServer(undefined)).toThrow("did not identify itself");
  });

  test("an explicit cli path must be absolute", () => {
    expect(() => resolveSidecar({ env: { [SIDECAR_CLI_ENV]: "cli.js" } })).toThrow(
      "must be an absolute path",
    );
  });

  test("an explicit cli path and runtime are used verbatim", () => {
    expect(
      resolveSidecar({
        env: { [SIDECAR_CLI_ENV]: "/opt/mcp/cli.js", [SIDECAR_RUNTIME_ENV]: "/usr/bin/node" },
      }),
    ).toEqual({ cli: "/opt/mcp/cli.js", runtime: "/usr/bin/node" });
  });

  test("an unresolvable bridge says how to install it and never offers to fetch it", () => {
    const message = String(
      thrown(() => resolveSidecar({ env: {}, resolveFrom: ["file:///nowhere/x.ts"] })),
    );
    expect(message).toContain("Install @mu-agent/browser");
    expect(message).toContain("never downloads it");
    expect(message).not.toContain("npx");
  });
});

describe("browser discovery is bounded to installed locations", () => {
  test("only known install paths are ever probed", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      for (const family of ["chrome", "edge", "chromium"]) {
        const candidates = browserExecutableCandidates(family, platform);
        expect(candidates.length).toBeGreaterThan(0);
        for (const candidate of candidates) expect(candidate).not.toContain("*");
      }
    }
  });

  test("the first existing candidate wins, and nothing else is probed", () => {
    const probed: string[] = [];
    const found = discoverBrowserExecutable("chrome", {
      platform: "linux",
      env: {},
      exists: (path) => {
        probed.push(path);
        return path === "/opt/google/chrome/chrome";
      },
    });
    expect(found).toBe("/opt/google/chrome/chrome");
    expect(probed).toEqual([
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
    ]);
  });

  test("an explicit executable overrides discovery entirely", () => {
    expect(
      discoverBrowserExecutable("chrome", {
        platform: "linux",
        env: { [BROWSER_EXECUTABLE_ENV]: "/custom/chrome" },
        exists: () => false,
      }),
    ).toBe("/custom/chrome");
  });

  test("no installed browser is an actionable refusal, never a download", () => {
    const error = thrown(() =>
      discoverBrowserExecutable("chrome", { platform: "linux", env: {}, exists: () => false }),
    );
    expect(isBrowserDriverError(error) && error.code).toBe("unsupported");
    expect(String(error)).toContain("does not download browsers");
  });
});

describe("sidecar argv", () => {
  const persistent = persistentSidecarArgs({
    browser: "chrome",
    outputDir: OUTPUT,
    executablePath: "/usr/bin/google-chrome",
    userDataDir: "/home/u/.mu/browser/profiles/default",
  });

  test("persistent mode names a Mu-owned profile and never remote debugging (BD7)", () => {
    expect(persistent[persistent.indexOf("--user-data-dir") + 1]).toBe(
      "/home/u/.mu/browser/profiles/default",
    );
    expect(persistent).not.toContain("--remote-debugging-port");
    expect(persistent).not.toContain("--isolated");
  });

  test("the sidecar writes into Mu's private artifact root", () => {
    expect(persistent).toContain("--output-dir");
    expect(persistent[persistent.indexOf("--output-dir") + 1]).toBe(OUTPUT);
    // Generated Playwright source is page text by another name.
    expect(persistent[persistent.indexOf("--codegen") + 1]).toBe("none");
  });

  test("headless is opt-in and persistent-only", () => {
    expect(persistent).not.toContain("--headless");
    expect(
      persistentSidecarArgs({
        browser: "chrome",
        outputDir: OUTPUT,
        executablePath: "/usr/bin/google-chrome",
        userDataDir: "/p",
        headless: true,
      }),
    ).toContain("--headless");
  });
});

describe("a missing browser names one you actually have", () => {
  const installed = (paths: string[]) => (path: string) => paths.includes(path);

  test("chromium being installed is said out loud when chrome is asked for", () => {
    try {
      discoverBrowserExecutable("chrome", {
        platform: "linux",
        env: {},
        exists: installed(["/usr/bin/chromium-browser"]),
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String(error)).toContain("--browser chromium");
    }
  });

  test("with nothing installed it says how to install rather than what to pass", () => {
    try {
      discoverBrowserExecutable("chrome", { platform: "linux", env: {}, exists: () => false });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String(error)).toContain("Install it");
      expect(String(error)).not.toContain("--browser");
    }
  });
});

describe("a snap-packaged browser is recognized", () => {
  // Measured against the chromium snap: its /tmp is a private namespace, so a file
  // Playwright stages there is invisible to the host process that copies it out.
  test("a path inside the snap tree is confined", () => {
    expect(isSnapConfined("/snap/bin/chromium")).toBe(true);
  });

  test("a distro wrapper that hands off to the snap is confined", () => {
    const wrapper = "#!/bin/sh\nif ! [ -x /snap/bin/chromium ]; then\n exit 1\nfi\n";
    expect(isSnapConfined("/usr/bin/chromium-browser", () => wrapper)).toBe(true);
  });

  test("an ordinary binary is not", () => {
    expect(
      isSnapConfined("/usr/bin/google-chrome", () => {
        throw new Error("binary, not text");
      }),
    ).toBe(false);
  });
});
