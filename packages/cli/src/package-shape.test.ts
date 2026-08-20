// B1 must not move the public `@mu-agent/mu` boundary. This pins the parts of
// the published package a consumer can observe — manifest, entry points, and
// SDK exports — against the pre-B1 baseline in `main:packages/cli/package.json`.
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import cliPackage from "../package.json";
import * as sdk from "./sdk.ts";

const packageRoot = dirname(import.meta.dir);

describe("published package shape", () => {
  test("the manifest identity, bin, entry points and files list are unchanged", () => {
    expect(cliPackage.name).toBe("@mu-agent/mu");
    expect(cliPackage.type).toBe("module");
    expect(cliPackage.main).toBe("./dist/index.js");
    expect(cliPackage.types).toBe("./dist/types/index.d.ts");
    expect(cliPackage.exports).toEqual({
      ".": {
        types: "./dist/types/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
    });
    expect(cliPackage.bin).toEqual({ mu: "./dist/mu.js" });
    expect(cliPackage.files).toEqual([
      "dist/mu.js",
      "dist/index.js",
      "dist/types",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_LICENSES.txt",
    ]);
  });

  test("only `mu` is published as an executable", () => {
    expect(Object.keys(cliPackage.bin)).toEqual(["mu"]);
  });

  test("runtime and optional dependencies are unchanged", () => {
    expect(cliPackage.dependencies).toEqual({ zod: "4.4.3" });
    expect(cliPackage.optionalDependencies).toEqual({
      "@mu-agent/ripgrep-darwin-arm64": "0.0.1",
      "@mu-agent/ripgrep-linux-x64": "0.0.1",
      "@mu-agent/ripgrep-windows-x64": "0.0.1",
    });
  });

  // The extraction adds a workspace devDependency; it is bundled at build time
  // by `bun build --target=bun`, so it never reaches the published manifest.
  test("the new internal runtime is a workspace devDependency, never a runtime one", () => {
    expect(cliPackage.devDependencies["@mu/cli-runtime"]).toBe("workspace:*");
    expect(Object.keys(cliPackage.dependencies)).not.toContain("@mu/cli-runtime");
  });

  test("the build and pack scripts still point at the same entry files", () => {
    expect(cliPackage.scripts.build).toContain("bun build src/main.ts");
    expect(cliPackage.scripts.build).toContain("bun build src/sdk.ts");
    expect(cliPackage.scripts.prepack).toBe("bun run build");
  });

  test("both published entry points exist in this package", async () => {
    const files = await readdir(join(packageRoot, "src"));
    expect(files).toContain("main.ts");
    expect(files).toContain("sdk.ts");
  });
});

describe("public SDK surface", () => {
  const expected = [
    "Agent",
    "codingProfile",
    "createAgent",
    "MemorySessionStore",
    "FileSessionStore",
    "SessionTree",
    "ExtensionHost",
    "CommandRegistry",
    "tool",
    "customMessage",
    "userMessage",
    "textResult",
    "errorResult",
    "optionsFromProfile",
    "loadProfile",
    "defaultModelRef",
    "findModel",
    "listModels",
    "readAuthFile",
    "saveApiKey",
    "createCredentialResolver",
    "loadMarkdownCommands",
    "toCommand",
    "registryWithCoreCommands",
    "sessionToMarkdown",
  ];

  test("every documented export is still reachable from the package entry", () => {
    for (const name of expected) {
      expect(typeof (sdk as Record<string, unknown>)[name]).not.toBe("undefined");
    }
  });

  test("createAgent still accepts the coding profile by name", () => {
    expect(typeof sdk.createAgent).toBe("function");
    expect(typeof sdk.codingProfile).toBe("function");
  });

  // The runtime is internal. Leaking its descriptor types through the public
  // SDK would make a future browser product a breaking change for `mu` users.
  test("the internal runtime is not re-exported from the public SDK", () => {
    for (const name of ["runInteractive", "runHeadless", "runRpc", "parseArgs", "codingProduct"]) {
      expect((sdk as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
