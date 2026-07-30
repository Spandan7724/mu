import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const outputRoot = join(repositoryRoot, "packages", "cli", "dist", "types");
const packageNames = ["ai", "core", "sdk"] as const;

function modulePath(fromFile: string, targetFile: string): string {
  const path = relative(dirname(fromFile), targetFile).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

async function copyDeclarations(packageName: (typeof packageNames)[number]): Promise<void> {
  const sourceRoot = join(repositoryRoot, "packages", packageName, "dist");
  const destinationRoot = join(outputRoot, packageName);

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

      const aiIndex = modulePath(destination, join(outputRoot, "ai", "index.js"));
      const coreIndex = modulePath(destination, join(outputRoot, "core", "index.js"));
      const declaration = (await readFile(source, "utf8"))
        .replaceAll('"@mu/ai"', `"${aiIndex}"`)
        .replaceAll('"@mu/core"', `"${coreIndex}"`)
        .replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2")
        .replace(/\/\/# sourceMappingURL=.*(?:\r?\n)?/g, "");
      await writeFile(destination, declaration);
    }
  }

  await copyDirectory(sourceRoot, destinationRoot);
}

await rm(outputRoot, { recursive: true, force: true });
for (const packageName of packageNames) await copyDeclarations(packageName);
