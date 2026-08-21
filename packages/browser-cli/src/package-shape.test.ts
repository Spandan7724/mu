// The published shape of `@mu-agent/browser`, pinned against the coding product's
// shape so the two boundaries can be compared rather than described.
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import codingPackage from "../../cli/package.json";
import browserPackage from "../package.json";
import * as sdk from "./index.ts";

const packageRoot = dirname(import.meta.dir);

describe("published package shape", () => {
  test("the manifest identity, bin, entry points and files list", () => {
    expect(browserPackage.name).toBe("@mu-agent/browser");
    expect(browserPackage.type).toBe("module");
    expect(browserPackage.main).toBe("./dist/index.js");
    expect(browserPackage.types).toBe("./dist/types/index.d.ts");
    expect(browserPackage.exports).toEqual({
      ".": {
        types: "./dist/types/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
    });
    expect(browserPackage.bin).toEqual({ "mu-browser": "./dist/mu-browser.js" });
    expect(browserPackage.files).toEqual([
      "dist/mu-browser.js",
      "dist/index.js",
      "dist/types",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_LICENSES.txt",
    ]);
  });

  test("only `mu-browser` is published as an executable", () => {
    expect(Object.keys(browserPackage.bin)).toEqual(["mu-browser"]);
  });

  test("both published entry points exist in this package", async () => {
    const files = await readdir(join(packageRoot, "src"));
    expect(files).toContain("main.ts");
    expect(files).toContain("index.ts");
  });

  test("the build and pack scripts point at those entry files", () => {
    expect(browserPackage.scripts.build).toContain("bun build src/main.ts");
    expect(browserPackage.scripts.build).toContain("bun build src/index.ts");
    expect(browserPackage.scripts.prepack).toBe("bun run build");
  });

  test("the internal workspaces are devDependencies, never runtime ones", () => {
    expect(browserPackage.dependencies).toEqual({ zod: "4.4.3" });
    for (const internal of [
      "@mu/cli-runtime",
      "@mu/core",
      "@mu/profile-browser",
      "@mu/tui",
      "mu",
    ]) {
      expect((browserPackage.devDependencies as Record<string, string>)[internal]).toBe(
        "workspace:*",
      );
      expect(Object.keys(browserPackage.dependencies)).not.toContain(internal);
    }
  });

  test("no new runtime dependency was added for the browser product", () => {
    // A browser runtime dependency needs its own decision entry first (BD24/BD25),
    // so this list must stay identical to the coding product's until one lands.
    expect(Object.keys(browserPackage.dependencies)).toEqual(
      Object.keys(codingPackage.dependencies),
    );
  });
});

describe("the two products are independent", () => {
  test("neither public package depends on the other, in any dependency field", () => {
    const fields = (manifest: Record<string, unknown>) => ({
      ...((manifest.dependencies as Record<string, string>) ?? {}),
      ...((manifest.optionalDependencies as Record<string, string>) ?? {}),
      ...((manifest.peerDependencies as Record<string, string>) ?? {}),
      ...((manifest.devDependencies as Record<string, string>) ?? {}),
    });
    expect(Object.keys(fields(browserPackage))).not.toContain("@mu-agent/mu");
    expect(Object.keys(fields(codingPackage))).not.toContain("@mu-agent/browser");
  });

  test("their executables and package names do not collide", () => {
    expect(Object.keys(codingPackage.bin)).toEqual(["mu"]);
    expect(Object.keys(browserPackage.bin)).toEqual(["mu-browser"]);
    expect(browserPackage.name).not.toBe(codingPackage.name);
  });

  test("their entry files are distinct, so neither overwrites the other on install", () => {
    expect(browserPackage.bin["mu-browser"]).not.toBe(
      (codingPackage.bin as Record<string, string>).mu,
    );
  });

  test("each product versions independently", () => {
    expect(browserPackage.version).not.toBe(codingPackage.version);
  });
});

describe("public SDK surface", () => {
  const expected = [
    "browserProfile",
    "createBrowserAgent",
    "BROWSER_PROFILE_NAME",
    "BROWSER_PERMISSION_MODES",
    "browserPrompt",
    "browserDataDir",
    "browserDataLayout",
    "BrowserDriverError",
    "connectionSummary",
    "acceptsModelActions",
    "phaseSummary",
    // Shared kernel surface, re-exported the way the coding SDK re-exports it.
    "Agent",
    "FileSessionStore",
    "tool",
    "userMessage",
  ];

  test("every documented export is reachable from the package entry", () => {
    for (const name of expected) {
      expect(typeof (sdk as Record<string, unknown>)[name]).not.toBe("undefined");
    }
  });

  test("no coding profile export leaks into the browser SDK", () => {
    for (const name of ["codingProfile", "bashTool", "TodoStore", "ShadowCheckpointProvider"]) {
      expect((sdk as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  test("the internal CLI runtime is not re-exported", () => {
    for (const name of [
      "runInteractive",
      "runHeadless",
      "runRpc",
      "parseArgs",
      "browserProduct",
      "createBrowserProduct",
    ]) {
      expect((sdk as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  test("driver implementations stay internal until their compatibility contract is intentional", () => {
    for (const name of [
      "createFakeBrowserDriver",
      "extensionFactory",
      "persistentProfileFactory",
    ]) {
      expect((sdk as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
