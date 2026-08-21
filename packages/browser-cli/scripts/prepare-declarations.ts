// Flattens the internal workspace declarations into `dist/types` and rewrites the
// workspace specifiers to relative paths, so a consumer of `@mu-agent/browser`
// never resolves `@mu/core` or `@mu/profile-browser` — neither of which is
// published. The coding product has its own copy of this for its own graph.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const outputRoot = join(packageRoot, "dist", "types");

// `exclude` drops a directory from the copy. Only safe where nothing the package
// re-exports resolves into it: `@mu/ai` and `mu` re-export their own testing
// helpers from their barrels, while the browser profile's barrel deliberately
// does not, so the driver conformance harness need not be published.
const declarationPackages = [
  { source: join(repositoryRoot, "packages", "ai", "dist"), destination: "ai", exclude: [] },
  { source: join(repositoryRoot, "packages", "core", "dist"), destination: "core", exclude: [] },
  { source: join(repositoryRoot, "packages", "sdk", "dist"), destination: "sdk", exclude: [] },
  {
    source: join(repositoryRoot, "packages", "profiles", "browser", "dist"),
    destination: "profile-browser",
    exclude: ["testing"],
  },
] as const;

function modulePath(fromFile: string, targetFile: string): string {
  const path = relative(dirname(fromFile), targetFile).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function rewriteModules(declaration: string, destination: string): string {
  const browserTypes = join(outputRoot, "profile-browser");
  const modules: Record<string, string> = {
    "@mu/ai": modulePath(destination, join(outputRoot, "ai", "index.js")),
    "@mu/core": modulePath(destination, join(outputRoot, "core", "index.js")),
    "@mu/profile-browser/commands": modulePath(
      destination,
      join(browserTypes, "commands", "index.js"),
    ),
    "@mu/profile-browser/drivers": modulePath(
      destination,
      join(browserTypes, "drivers", "index.js"),
    ),
    "@mu/profile-browser/profile": modulePath(
      destination,
      join(browserTypes, "profile", "index.js"),
    ),
    "@mu/profile-browser/renderers": modulePath(
      destination,
      join(browserTypes, "renderers", "index.js"),
    ),
    "@mu/profile-browser/runtime": modulePath(
      destination,
      join(browserTypes, "runtime", "index.js"),
    ),
    "@mu/profile-browser": modulePath(destination, join(browserTypes, "index.js")),
    mu: modulePath(destination, join(outputRoot, "sdk", "index.js")),
  };

  let rewritten = declaration;
  // Longest specifier first: `@mu/profile-browser` must not eat its own subpaths.
  for (const specifier of Object.keys(modules).sort((a, b) => b.length - a.length)) {
    const path = modules[specifier] as string;
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rewritten = rewritten.replace(new RegExp(`(from\\s+)["']${escaped}["']`, "g"), `$1"${path}"`);
    rewritten = rewritten.replace(
      new RegExp(`import\\(["']${escaped}["']\\)`, "g"),
      `import("${path}")`,
    );
  }
  return rewritten
    .replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2")
    .replace(/\/\/# sourceMappingURL=.*(?:\r?\n)?/g, "");
}

async function writeDeclaration(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, rewriteModules(await readFile(source, "utf8"), destination));
}

async function copyDeclarations(
  sourceRoot: string,
  destinationName: string,
  exclude: readonly string[],
): Promise<void> {
  const excluded = new Set(exclude);
  const destinationRoot = join(outputRoot, destinationName);
  async function copyDirectory(source: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        await copyDirectory(from, to);
        continue;
      }
      if (!entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.d.ts")) continue;
      await writeDeclaration(from, to);
    }
  }
  await copyDirectory(sourceRoot, destinationRoot);
}

await rm(outputRoot, { recursive: true, force: true });
for (const packageInfo of declarationPackages) {
  await copyDeclarations(packageInfo.source, packageInfo.destination, packageInfo.exclude);
}
await writeDeclaration(join(packageRoot, "dist", "index.d.ts"), join(outputRoot, "index.d.ts"));
