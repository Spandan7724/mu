import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Installs the packed tarball into a project outside the workspace, where
// internal @mu/* names cannot resolve, then typechecks and runs the consumer.
const root = resolve(import.meta.dir, "..");
const cli = join(root, "packages", "cli");
const work = await mkdtemp(join(tmpdir(), "mu-packed-sdk-"));

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}`);
}

try {
  await run(
    ["bun", "pm", "pack", "--ignore-scripts", "--filename", join(work, "mu.tgz"), "--quiet"],
    cli,
  );
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({
      name: "mu-packed-sdk-consumer",
      private: true,
      type: "module",
      dependencies: { "@mu-agent/mu": "file:./mu.tgz" },
    }),
  );
  await copyFile(join(cli, "testing", "sdk-consumer.ts"), join(work, "sdk-consumer.ts"));
  await run(["bun", "install", "--ignore-scripts"], work);
  await run(
    [
      "bun",
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ESNext",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--typeRoots",
      join(root, "node_modules", "@types"),
      "--types",
      "bun",
      "sdk-consumer.ts",
    ],
    work,
  );
  await run(["bun", "sdk-consumer.ts"], work);
  console.log("packed SDK verified outside the workspace");
} finally {
  await rm(work, { recursive: true, force: true });
}
