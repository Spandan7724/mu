import { describe, expect, test } from "bun:test";
import {
  type DiscoverDeps,
  defaultDiscoverDeps,
  discoverBrowser,
  findCandidates,
  knownPaths,
  parseVersionOutput,
} from "./discover.ts";

function deps(files: string[], overrides: Partial<DiscoverDeps> = {}): DiscoverDeps {
  const present = new Set(files);
  return {
    platform: "linux",
    env: {},
    home: "/home/u",
    exists: (path) => present.has(path),
    which: () => null,
    probeVersion: async () => undefined,
    ...overrides,
  };
}

describe("browser discovery", () => {
  test("prefers Chrome, then Chromium, Brave and Edge", async () => {
    const found = await discoverBrowser(
      {},
      deps(["/usr/bin/brave", "/usr/bin/chromium"], {
        probeVersion: async () => "Chromium 150.0.1.2 Arch Linux\n",
      }),
    );
    expect(found).toEqual({
      path: "/usr/bin/chromium",
      channel: "chromium",
      product: "Chromium",
      version: "150.0.1.2",
    });
  });

  test("a channel restricts the search; PATH lookups count", () => {
    const candidates = findCandidates(
      "brave",
      deps(["/usr/bin/google-chrome-stable", "/home/u/bin/brave"], {
        which: (command) => (command === "brave" ? "/home/u/bin/brave" : null),
      }),
    );
    expect(candidates).toEqual([{ channel: "brave", path: "/home/u/bin/brave" }]);
  });

  test("an explicit executable wins and must exist", async () => {
    expect(
      await discoverBrowser(
        { executable: "/opt/x/chrome" },
        deps(["/opt/x/chrome", "/usr/bin/google-chrome"], {
          probeVersion: async () => "Google Chrome 154.0.8037.57 ",
        }),
      ),
    ).toMatchObject({ path: "/opt/x/chrome", channel: "custom", version: "154.0.8037.57" });
    await expect(discoverBrowser({ executable: "/missing" }, deps([]))).rejects.toThrow(
      "Browser executable not found",
    );
  });

  test("missing browsers and unknown channels fail with actionable messages", async () => {
    await expect(discoverBrowser({}, deps([]))).rejects.toThrow("browser.executable");
    await expect(discoverBrowser({ channel: "edge" }, deps([]))).rejects.toThrow("Microsoft Edge");
    await expect(discoverBrowser({ channel: "firefox" }, deps([]))).rejects.toThrow(
      "Unknown browser",
    );
  });

  test("macOS path table covers system and per-user Applications", () => {
    const paths = knownPaths("darwin", {}, "/Users/u");
    expect(paths).toContainEqual({
      channel: "chrome",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    expect(paths).toContainEqual({
      channel: "brave",
      path: "/Users/u/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    });
    expect(paths.map((candidate) => candidate.channel)).toContain("edge");
  });

  test("Windows path table expands program-files and local-app-data roots", async () => {
    const env = {
      PROGRAMFILES: "D:\\PF",
      "PROGRAMFILES(X86)": "D:\\PF86",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    };
    const paths = knownPaths("win32", env, "C:\\Users\\u");
    expect(paths).toContainEqual({
      channel: "chrome",
      path: "D:\\PF\\Google\\Chrome\\Application\\chrome.exe",
    });
    expect(paths).toContainEqual({
      channel: "edge",
      path: "D:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe",
    });
    const found = await discoverBrowser(
      {},
      deps(["C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"], {
        platform: "win32",
        env,
      }),
    );
    expect(found).toMatchObject({
      channel: "chrome",
      product: "Google Chrome",
      version: "unknown",
    });
  });

  test("parses --version output of each product", () => {
    expect(parseVersionOutput("Google Chrome 154.0.8037.57 \n")).toEqual({
      product: "Google Chrome",
      version: "154.0.8037.57",
    });
    expect(parseVersionOutput("Brave Browser 154.1.90.3")).toEqual({
      product: "Brave Browser",
      version: "154.1.90.3",
    });
    expect(parseVersionOutput("Microsoft Edge 140.0.3485.54 ")).toMatchObject({
      version: "140.0.3485.54",
    });
  });

  test.skipIf(process.platform !== "linux")(
    "finds a real Chrome-family browser on this machine",
    async () => {
      const candidates = findCandidates(undefined, defaultDiscoverDeps());
      if (candidates.length === 0) return;
      const found = await discoverBrowser();
      expect(found.path).toBe(candidates[0]?.path as string);
      expect(found.version).toMatch(/^\d+\./);
    },
  );
});
