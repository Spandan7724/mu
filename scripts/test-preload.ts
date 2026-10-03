import { afterAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test run gets one temp root, removed when the run ends, so tests and the
// browsers they launch cannot leave folders in the system temp directory. Roots
// left by runs that were killed outright are swept by the next run.
const PREFIX = "mu-test-run-";
const system = tmpdir();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Browsers launched by tests run out of profiles under the root; an
// interrupted run orphans them and they keep writing there.
function stopProcessesUnder(dir: string): void {
  if (process.platform !== "win32") Bun.spawnSync(["pkill", "-KILL", "-f", dir]);
}

for (const name of readdirSync(system)) {
  if (!name.startsWith(PREFIX)) continue;
  const pid = Number(name.slice(PREFIX.length).split("-")[0]);
  if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
  stopProcessesUnder(join(system, name));
  rmSync(join(system, name), { recursive: true, force: true, maxRetries: 3 });
}

const root = mkdtempSync(join(system, `${PREFIX}${process.pid}-`));
// Short on purpose: Chrome's singleton socket lives under TMPDIR and Unix
// socket paths are capped near 108 bytes.
process.env.TMPDIR = root;
process.env.TEMP = root;
process.env.TMP = root;

const cleanup = () => {
  stopProcessesUnder(root);
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
};
afterAll(async () => {
  for (let attempt = 0; attempt < 20 && existsSync(root); attempt++) {
    cleanup();
    if (existsSync(root)) await Bun.sleep(100);
  }
});
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  process.once(signal, () => {
    cleanup();
    process.exit(code);
  });
}
