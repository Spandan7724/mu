import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const outputRoot = join(repositoryRoot, "packages", "cli", "dist", "types");
const declarationPackages = [
  {
    source: join(repositoryRoot, "packages", "ai", "dist"),
    destination: "ai",
  },
  {
    source: join(repositoryRoot, "packages", "core", "dist"),
    destination: "core",
  },
  {
    source: join(repositoryRoot, "packages", "sdk", "dist"),
    destination: "sdk",
  },
  {
    source: join(repositoryRoot, "packages", "profiles", "coding", "dist"),
    destination: "profile-coding",
  },
] as const;

function modulePath(fromFile: string, targetFile: string): string {
  const path = relative(dirname(fromFile), targetFile).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function rewriteModules(declaration: string, destination: string): string {
  const modules = {
    "@mu/ai": modulePath(destination, join(outputRoot, "ai", "index.js")),
    "@mu/core": modulePath(destination, join(outputRoot, "core", "index.js")),
    "@mu/profile-coding": modulePath(destination, join(outputRoot, "profile-coding", "index.js")),
    mu: modulePath(destination, join(outputRoot, "sdk", "index.js")),
  };

  let rewritten = declaration;
  for (const [specifier, path] of Object.entries(modules)) {
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

async function copyDeclarations(sourceRoot: string, destinationName: string): Promise<void> {
  const destinationRoot = join(outputRoot, destinationName);

  async function copyDirectory(
    sourceDirectory: string,
    destinationDirectory: string,
  ): Promise<void> {
    await mkdir(destinationDirectory, { recursive: true });
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
      const source = join(sourceDirectory, entry.name);
      const destination = join(destinationDirectory, entry.name);
      if (entry.isDirectory()) {
        await copyDirectory(source, destination);
        continue;
      }
      if (!entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.d.ts")) continue;
      await writeDeclaration(source, destination);
    }
  }

  await copyDirectory(sourceRoot, destinationRoot);
}

await rm(outputRoot, { recursive: true, force: true });
for (const packageInfo of declarationPackages) {
  await copyDeclarations(packageInfo.source, packageInfo.destination);
}
await writeDeclaration(
  join(repositoryRoot, "packages", "cli", "dist", "sdk.d.ts"),
  join(outputRoot, "index.d.ts"),
);
